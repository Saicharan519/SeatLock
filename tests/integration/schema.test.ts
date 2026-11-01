import type { Pool } from 'pg';
import { createTestPool, resetDatabase } from '../helpers/db';

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
    ({ id: showId } = (
      await pool.query(
        `INSERT INTO shows (title, venue, starts_at, price_per_seat)
         VALUES ('Show', 'Hall', now() + interval '1 day', 20000) RETURNING id`,
      )
    ).rows[0]);
    ({ id: seatId } = (
      await pool.query(`INSERT INTO seats (show_id, seat_label) VALUES ($1, 'A1') RETURNING id`, [
        showId,
      ])
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
      pool.query(`INSERT INTO seats (show_id, seat_label) VALUES ($1, 'A1')`, [showId]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'seats_show_label' });
  });
});
