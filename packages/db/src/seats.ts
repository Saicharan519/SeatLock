import type { PoolClient } from 'pg';

export const SEAT_ROWS = ['A', 'B', 'C', 'D', 'E'] as const;
export const SEATS_PER_ROW = 10;

/** A1..A10, B1..B10, ... E10. Order matters: seat ids ascend in this order. */
export function seatLabels(): string[] {
  return SEAT_ROWS.flatMap((row) =>
    Array.from({ length: SEATS_PER_ROW }, (_, i) => `${row}${i + 1}`),
  );
}

/**
 * Generates a show's 50 seats. Must run in the same transaction that creates the show,
 * so a show never exists without its seats.
 */
export async function insertSeatsForShow(client: PoolClient, showId: string): Promise<number> {
  const result = await client.query(
    `INSERT INTO seats (show_id, seat_label)
     SELECT $1, label FROM unnest($2::text[]) WITH ORDINALITY AS t(label, ord)
     ORDER BY ord`,
    [showId, seatLabels()],
  );
  return result.rowCount ?? 0;
}

/**
 * Locks seat rows in ascending id order (R2). Every path that touches several seats
 * calls this first, so two transactions can never each hold a seat the other wants.
 * A plain multi-row UPDATE locks rows in scan order, which is NOT safe.
 *
 * Seat ids are bigint, which pg returns as strings.
 */
export async function lockSeatsInIdOrder(client: PoolClient, seatIds: string[]): Promise<void> {
  if (seatIds.length === 0) return;
  await client.query(`SELECT id FROM seats WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE`, [
    seatIds,
  ]);
}

/** Ids of the seats these bookings currently hold. Unlocked read: lock them before changing. */
export async function heldSeatIdsOfBookings(
  client: PoolClient,
  bookingIds: string[],
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM seats WHERE booking_id = ANY($1::uuid[]) AND status = 'HELD' ORDER BY id`,
    [bookingIds],
  );
  return rows.map((r) => r.id);
}

/**
 * Releases the HELD seats of these bookings. Guarded by booking_id, so a seat another
 * hold has already taken over is never touched. Callers must have locked the seats
 * in id order first: either a combined lock set (R2), or via releaseHeldSeatsOfBookings.
 */
export async function releaseLockedSeats(
  client: PoolClient,
  bookingIds: string[],
): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE seats SET status = 'AVAILABLE', booking_id = NULL, updated_at = now()
     WHERE booking_id = ANY($1::uuid[]) AND status = 'HELD'`,
    [bookingIds],
  );
  return rowCount ?? 0;
}

/** Locks (id order) and releases every seat these bookings hold. */
export async function releaseHeldSeatsOfBookings(
  client: PoolClient,
  bookingIds: string[],
): Promise<number> {
  if (bookingIds.length === 0) return 0;
  await lockSeatsInIdOrder(client, await heldSeatIdsOfBookings(client, bookingIds));
  return releaseLockedSeats(client, bookingIds);
}
