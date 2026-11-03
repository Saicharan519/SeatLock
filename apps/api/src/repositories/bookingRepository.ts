import type { PoolClient } from 'pg';
import { logTransition } from '../utils/transitionLog';

export type BookingStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';

export interface ShowForHold {
  id: string;
  upcoming: boolean;
}

/** The show, and whether it starts in the future by the database clock (R5). */
export async function findShowForHold(
  client: PoolClient,
  showId: string,
): Promise<ShowForHold | undefined> {
  const { rows } = await client.query<ShowForHold>(
    `SELECT id, starts_at > now() AS upcoming FROM shows WHERE id = $1`,
    [showId],
  );
  return rows[0];
}

/**
 * Seats for the given labels with their current category price, in ascending id order.
 * Unlocked read. The price read here is what booking_items stores (the price snapshot).
 */
export async function findSeatsByLabels(
  client: PoolClient,
  showId: string,
  labels: string[],
): Promise<{ id: string; seat_label: string; price: number }[]> {
  const { rows } = await client.query<{ id: string; seat_label: string; price: number }>(
    `SELECT s.id, s.seat_label, p.price
     FROM seats s
     JOIN show_prices p ON p.show_id = s.show_id AND p.category = s.category
     WHERE s.show_id = $1 AND s.seat_label = ANY($2::text[])
     ORDER BY s.id`,
    [showId, labels],
  );
  return rows;
}

/**
 * The caller's PENDING booking for this show, locked (booking is first in the R3 lock order).
 * FOR UPDATE re-evaluates the WHERE clause after waiting, so if the worker expired it or a
 * webhook confirmed it while we waited, it is simply not returned.
 */
export async function lockPendingBookingOfUser(
  client: PoolClient,
  userId: string,
  showId: string,
): Promise<{ id: string; live: boolean } | undefined> {
  const { rows } = await client.query<{ id: string; live: boolean }>(
    `SELECT id, expires_at >= now() AS live FROM bookings
     WHERE user_id = $1 AND show_id = $2 AND status = 'PENDING'
     FOR UPDATE`,
    [userId, showId],
  );
  return rows[0];
}

/**
 * Guarded transition: UPDATE ... WHERE status = expected. Returns false if the booking was
 * not in the expected state (a lost race or an invalid transition), which callers must handle.
 */
export async function transitionBooking(
  client: PoolClient,
  bookingId: string,
  from: BookingStatus,
  to: BookingStatus,
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE bookings SET status = $3, updated_at = now() WHERE id = $1 AND status = $2`,
    [bookingId, from, to],
  );
  if (rowCount === 1) logTransition(client, 'booking', bookingId, from, to);
  return rowCount === 1;
}

export async function insertPendingBooking(
  client: PoolClient,
  input: { userId: string; showId: string; totalAmount: number; ttlSeconds: number },
): Promise<{ id: string; expires_at: Date }> {
  const { rows } = await client.query<{ id: string; expires_at: Date }>(
    `INSERT INTO bookings (user_id, show_id, status, total_amount, expires_at)
     VALUES ($1, $2, 'PENDING', $3, now() + make_interval(secs => $4))
     RETURNING id, expires_at`,
    [input.userId, input.showId, input.totalAmount, input.ttlSeconds],
  );
  return rows[0]!;
}

/**
 * The conditional claim (PRD 9.1 step 6). A seat is claimable if it is AVAILABLE, or HELD
 * by a booking whose hold has expired (a stale hold the worker hasn't swept yet).
 * The caller compares the returned count with the number requested (R8).
 */
export async function claimSeats(
  client: PoolClient,
  seatIds: string[],
  bookingId: string,
): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE seats s
     SET status = 'HELD', booking_id = $2, updated_at = now()
     WHERE s.id = ANY($1::bigint[])
       AND ( s.status = 'AVAILABLE'
             OR ( s.status = 'HELD'
                  AND EXISTS (SELECT 1 FROM bookings b
                              WHERE b.id = s.booking_id AND b.expires_at < now()) ) )`,
    [seatIds, bookingId],
  );
  return rowCount ?? 0;
}

/** One item per seat, each at the price it had when the hold was made. */
export async function insertBookingItems(
  client: PoolClient,
  bookingId: string,
  seats: { id: string; price: number }[],
): Promise<void> {
  await client.query(
    `INSERT INTO booking_items (booking_id, seat_id, price)
     SELECT $1, seat_id, price FROM unnest($2::bigint[], $3::int[]) AS t(seat_id, price)`,
    [bookingId, seats.map((s) => s.id), seats.map((s) => s.price)],
  );
}

export interface LockedBooking {
  id: string;
  user_id: string;
  show_id: string;
  status: BookingStatus;
  total_amount: number;
  /** expires_at > now(), by the database clock (R5) */
  live: boolean;
}

const LOCKED_BOOKING_COLUMNS = `id, user_id, show_id, status, total_amount, expires_at > now() AS live`;

/** Locks a booking (first in the R3 lock order). */
export async function lockBooking(
  client: PoolClient,
  bookingId: string,
): Promise<LockedBooking | undefined> {
  const { rows } = await client.query<LockedBooking>(
    `SELECT ${LOCKED_BOOKING_COLUMNS} FROM bookings WHERE id = $1 FOR UPDATE`,
    [bookingId],
  );
  return rows[0];
}

/** Locks a booking only if it belongs to the user. Someone else's booking looks like no booking. */
export async function lockBookingOfUser(
  client: PoolClient,
  bookingId: string,
  userId: string,
): Promise<LockedBooking | undefined> {
  const { rows } = await client.query<LockedBooking>(
    `SELECT ${LOCKED_BOOKING_COLUMNS} FROM bookings WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [bookingId, userId],
  );
  return rows[0];
}

/** The booking's seats as recorded in booking_items, ascending id. */
export async function itemSeatsOfBooking(
  client: PoolClient,
  bookingId: string,
): Promise<{ id: string; seat_label: string }[]> {
  const { rows } = await client.query<{ id: string; seat_label: string }>(
    `SELECT s.id, s.seat_label FROM booking_items i JOIN seats s ON s.id = i.seat_id
     WHERE i.booking_id = $1 ORDER BY s.id`,
    [bookingId],
  );
  return rows;
}

/** How many of these seats this booking still holds. Call with the seats locked. */
export async function countSeatsHeldBy(
  client: PoolClient,
  seatIds: string[],
  bookingId: string,
): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM seats
     WHERE id = ANY($1::bigint[]) AND booking_id = $2 AND status = 'HELD'`,
    [seatIds, bookingId],
  );
  return rows[0]!.n;
}

/** HELD -> BOOKED for seats this booking holds. Returns the number changed. */
export async function markSeatsBooked(
  client: PoolClient,
  seatIds: string[],
  bookingId: string,
): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE seats SET status = 'BOOKED', updated_at = now()
     WHERE id = ANY($1::bigint[]) AND booking_id = $2 AND status = 'HELD'`,
    [seatIds, bookingId],
  );
  return rowCount ?? 0;
}

/**
 * Late-payment re-claim (PRD 9.3): how many of these seats this booking could take now.
 * A seat qualifies if it is AVAILABLE, still HELD by this booking, or HELD by any booking
 * whose hold has expired. A seat that is BOOKED or under someone's live hold does not.
 * Call with the seats locked.
 */
export async function countSeatsClaimableLate(
  client: PoolClient,
  seatIds: string[],
  bookingId: string,
): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM seats s
     WHERE s.id = ANY($1::bigint[])
       AND ( s.status = 'AVAILABLE'
             OR ( s.status = 'HELD'
                  AND ( s.booking_id = $2
                        OR EXISTS (SELECT 1 FROM bookings b
                                   WHERE b.id = s.booking_id AND b.expires_at < now()) ) ) )`,
    [seatIds, bookingId],
  );
  return rows[0]!.n;
}

/** Takes seats straight to BOOKED for this booking. Only after countSeatsClaimableLate passed. */
export async function bookSeats(
  client: PoolClient,
  seatIds: string[],
  bookingId: string,
): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE seats SET status = 'BOOKED', booking_id = $2, updated_at = now()
     WHERE id = ANY($1::bigint[])`,
    [seatIds, bookingId],
  );
  return rowCount ?? 0;
}

/** Cancellation: BOOKED -> AVAILABLE for this booking's seats. Seats must be locked. */
export async function releaseBookedSeats(
  client: PoolClient,
  seatIds: string[],
  bookingId: string,
): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE seats SET status = 'AVAILABLE', booking_id = NULL, updated_at = now()
     WHERE id = ANY($1::bigint[]) AND booking_id = $2 AND status = 'BOOKED'`,
    [seatIds, bookingId],
  );
  return rowCount ?? 0;
}

/** Sets is_confirmed, the column the one_confirmed_per_seat index enforces. */
export async function setItemsConfirmed(
  client: PoolClient,
  bookingId: string,
  confirmed: boolean,
): Promise<void> {
  await client.query(`UPDATE booking_items SET is_confirmed = $2 WHERE booking_id = $1`, [
    bookingId,
    confirmed,
  ]);
}

/** Payment for a booking, locked (payment is second in the R3 lock order). */
export async function lockPaymentOfBooking(
  client: PoolClient,
  bookingId: string,
): Promise<{ id: string; status: string } | undefined> {
  const { rows } = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM payments WHERE booking_id = $1 FOR UPDATE`,
    [bookingId],
  );
  return rows[0];
}
