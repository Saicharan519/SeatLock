import type { PoolClient } from 'pg';

export type BookingStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';

export interface ShowForHold {
  id: string;
  price_per_seat: number;
  upcoming: boolean;
}

/** The show, and whether it starts in the future by the database clock (R5). */
export async function findShowForHold(
  client: PoolClient,
  showId: string,
): Promise<ShowForHold | undefined> {
  const { rows } = await client.query<ShowForHold>(
    `SELECT id, price_per_seat, starts_at > now() AS upcoming FROM shows WHERE id = $1`,
    [showId],
  );
  return rows[0];
}

/** Seat ids for the given labels, in ascending id order. Unlocked read. */
export async function findSeatsByLabels(
  client: PoolClient,
  showId: string,
  labels: string[],
): Promise<{ id: string; seat_label: string }[]> {
  const { rows } = await client.query<{ id: string; seat_label: string }>(
    `SELECT id, seat_label FROM seats WHERE show_id = $1 AND seat_label = ANY($2::text[]) ORDER BY id`,
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

export async function insertBookingItems(
  client: PoolClient,
  bookingId: string,
  seatIds: string[],
  price: number,
): Promise<void> {
  await client.query(
    `INSERT INTO booking_items (booking_id, seat_id, price)
     SELECT $1, seat_id, $3 FROM unnest($2::bigint[]) AS seat_id`,
    [bookingId, seatIds, price],
  );
}

export async function lockBookingOfUser(
  client: PoolClient,
  bookingId: string,
  userId: string,
): Promise<{ id: string; status: BookingStatus } | undefined> {
  const { rows } = await client.query<{ id: string; status: BookingStatus }>(
    `SELECT id, status FROM bookings WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [bookingId, userId],
  );
  return rows[0];
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
