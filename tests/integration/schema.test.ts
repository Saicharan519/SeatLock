import type { Pool } from 'pg';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createShow } from '../helpers/factories';

/**
 * The database must refuse corruption even if application code has a bug.
 * These tests bypass the API and write invalid rows directly.
 */
describe('database safety nets', () => {
  let pool: Pool;
  let userId: string;
  let showId: string;
  let seatId: number;

  beforeAll(() => {
    pool = createTestPool(2);
  });
  afterAll(() => pool.end());

  beforeEach(async () => {
    await resetDatabase(pool);
    ({ id: userId } = (
      await pool.query(
        `INSERT INTO users (name, email, password_hash) VALUES ('U', 'u@test.local', 'x') RETURNING id`,
      )
    ).rows[0]);
    showId = await createShow(pool);
    ({ id: seatId } = (
      await pool.query(`SELECT id FROM seats WHERE show_id = $1 AND seat_label = 'A1'`, [showId])
    ).rows[0]);
  });

  const insertBooking = async (status: string) =>
    (
      await pool.query(
        `INSERT INTO bookings (user_id, show_id, status, expires_at)
         VALUES ($1, $2, $3, now() + interval '5 minutes') RETURNING id`,
        [userId, showId, status],
      )
    ).rows[0].id as string;

  test('T15: rejects two confirmed booking items for one seat', async () => {
    const b1 = await insertBooking('CONFIRMED');
    const b2 = await insertBooking('CONFIRMED');
    await pool.query(
      `INSERT INTO booking_items (booking_id, seat_id, price, is_confirmed) VALUES ($1, $2, 20000, true)`,
      [b1, seatId],
    );

    await expect(
      pool.query(
        `INSERT INTO booking_items (booking_id, seat_id, price, is_confirmed) VALUES ($1, $2, 20000, true)`,
        [b2, seatId],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'one_confirmed_per_seat' });
  });

  test('allows unconfirmed items for a seat alongside one confirmed item', async () => {
    const b1 = await insertBooking('CONFIRMED');
    const b2 = await insertBooking('CANCELLED');
    await pool.query(
      `INSERT INTO booking_items (booking_id, seat_id, price, is_confirmed) VALUES ($1, $2, 20000, true)`,
      [b1, seatId],
    );
    await expect(
      pool.query(`INSERT INTO booking_items (booking_id, seat_id, price) VALUES ($1, $2, 20000)`, [
        b2,
        seatId,
      ]),
    ).resolves.toBeDefined();
  });

  test('rejects a HELD seat with no booking, and an AVAILABLE seat with one', async () => {
    await expect(
      pool.query(`UPDATE seats SET status = 'HELD' WHERE id = $1`, [seatId]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'seat_status_owner',
    });

    const b = await insertBooking('PENDING');
    await expect(
      pool.query(`UPDATE seats SET booking_id = $1 WHERE id = $2`, [b, seatId]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'seat_status_owner',
    });
  });

  test('rejects a second PENDING booking for the same user and show', async () => {
    await insertBooking('PENDING');
    await expect(insertBooking('PENDING')).rejects.toMatchObject({
      code: '23505',
      constraint: 'one_pending_per_user_show',
    });
    // Non-pending bookings are unrestricted
    await expect(insertBooking('EXPIRED')).resolves.toBeDefined();
  });

  test('rejects a reused idempotency key for the same user, even on another endpoint', async () => {
    const insertKey = (endpoint: string) =>
      pool.query(
        `INSERT INTO idempotency_keys (user_id, key, endpoint, request_hash) VALUES ($1, 'k1', $2, 'h')`,
        [userId, endpoint],
      );
    await insertKey('POST /api/holds');
    await expect(insertKey('POST /api/bookings/:id/pay')).rejects.toMatchObject({
      code: '23505',
      constraint: 'idempotency_user_key',
    });
  });

  test('rejects a duplicate seat label within a show', async () => {
    await expect(
      pool.query(
        `INSERT INTO seats (show_id, seat_label, category) VALUES ($1, 'A1', 'STANDARD')`,
        [showId],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'seats_show_label' });
  });

  test('rejects a seat whose category has no price for its show', async () => {
    await expect(
      pool.query(
        `INSERT INTO seats (show_id, seat_label, category) VALUES ($1, 'Z1', 'RECLINER')`,
        [showId],
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'seats_category_priced' });
  });

  test('rejects two overlapping shows on one screen, allows back-to-back', async () => {
    const { rows } = await pool.query(
      `SELECT movie_id, screen_id, starts_at, ends_at FROM shows WHERE id = $1`,
      [showId],
    );
    const s = rows[0];
    const insert = (startsAt: Date, endsAt: Date) =>
      pool.query(
        `INSERT INTO shows (movie_id, screen_id, starts_at, ends_at) VALUES ($1, $2, $3, $4)`,
        [s.movie_id, s.screen_id, startsAt, endsAt],
      );
    const minute = 60_000;
    const end = new Date(s.ends_at).getTime();
    // Starts 1 minute before the existing show ends: overlaps
    await expect(
      insert(new Date(end - minute), new Date(end + 120 * minute)),
    ).rejects.toMatchObject({
      code: '23P01',
      constraint: 'shows_no_overlap_per_screen',
    });
    // Starts exactly when it ends: the ranges are half-open, so this is fine
    await expect(insert(new Date(end), new Date(end + 120 * minute))).resolves.toBeDefined();
  });
});
