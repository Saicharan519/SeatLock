import type { Pool } from 'pg';

/**
 * DELIBERATELY BROKEN. Never used by the API: this is the "obvious" implementation that
 * SeatLock exists to replace, kept to demonstrate the bug (PRD 14).
 *
 *   1. SELECT the seat and check it's AVAILABLE   <- read, no lock
 *   2. do some work (validation, pricing, ...)    <- the race window
 *   3. UPDATE the seat to HELD, unconditionally   <- write, no re-check
 *
 * Two requests can both pass step 1 before either reaches step 3. Both are told "you hold
 * the seat"; the second UPDATE silently overwrites the first, so one customer is holding a
 * seat that now belongs to someone else. At confirm time that's a double sale.
 *
 * workMs widens the race window with pg_sleep, standing in for real application work.
 */
export async function naiveHold(
  pool: Pool,
  input: { userId: string; showId: string; label: string; workMs: number },
): Promise<{ outcome: 'held' | 'unavailable'; bookingId?: string; seatId?: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM seats WHERE show_id = $1 AND seat_label = $2`,
      [input.showId, input.label],
    );
    const seat = rows[0]!;
    if (seat.status !== 'AVAILABLE') {
      await client.query('ROLLBACK');
      return { outcome: 'unavailable' };
    }

    if (input.workMs > 0) await client.query('SELECT pg_sleep($1)', [input.workMs / 1000]);

    const booking = await client.query<{ id: string }>(
      `INSERT INTO bookings (user_id, show_id, status, total_amount, expires_at)
       VALUES ($1, $2, 'PENDING', 25000, now() + interval '5 minutes') RETURNING id`,
      [input.userId, input.showId],
    );
    const bookingId = booking.rows[0]!.id;
    // No "AND status = 'AVAILABLE'", no row-count check: last writer wins
    await client.query(`UPDATE seats SET status = 'HELD', booking_id = $1 WHERE id = $2`, [
      bookingId,
      seat.id,
    ]);
    await client.query('COMMIT');
    return { outcome: 'held', bookingId, seatId: seat.id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The confirm step done naively too: mark every "held" booking's seat as confirmed. Without
 * the database's one_confirmed_per_seat index, every oversold seat would now be sold twice.
 * With it, Postgres rejects every second confirmation. Returns how many got through.
 */
export async function naiveConfirmAll(
  pool: Pool,
  winners: { bookingId: string; seatId: string }[],
): Promise<{ confirmed: number; rejectedByDatabase: number }> {
  let confirmed = 0;
  let rejectedByDatabase = 0;
  for (const w of winners) {
    try {
      await pool.query(
        `INSERT INTO booking_items (booking_id, seat_id, price, is_confirmed) VALUES ($1, $2, 25000, true)`,
        [w.bookingId, w.seatId],
      );
      confirmed += 1;
    } catch (err) {
      if ((err as { constraint?: string }).constraint !== 'one_confirmed_per_seat') throw err;
      rejectedByDatabase += 1;
    }
  }
  return { confirmed, rejectedByDatabase };
}
