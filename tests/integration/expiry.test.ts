import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Pool } from 'pg';
import { expireHolds } from '../../apps/worker/src/jobs/expireHolds';
import { createTestApp } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createShow, createUser, holdSeatsDirectly } from '../helpers/factories';

const TTL_SECONDS = 5; // From tests/setup/env.ts, as the PRD specifies for tests
const waitPastTtl = () => new Promise((resolve) => setTimeout(resolve, TTL_SECONDS * 1000 + 500));

describe('hold expiry (FR-07)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    pool = createTestPool(10);
    app = createTestApp(pool);
  });
  afterAll(() => pool.end());
  beforeEach(() => resetDatabase(pool));

  const hold = (token: string, showId: string, seats: string[]) =>
    request(app)
      .post('/api/holds')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showId, seats });
  const seat = async (showId: string, label: string) =>
    (
      await pool.query(
        `SELECT status, booking_id FROM seats WHERE show_id = $1 AND seat_label = $2`,
        [showId, label],
      )
    ).rows[0];
  const bookingStatus = async (id: string) =>
    (await pool.query(`SELECT status FROM bookings WHERE id = $1`, [id])).rows[0].status;

  test('T5: after the TTL, the worker expires the hold, frees the seats, and others can hold them', async () => {
    const showId = await createShow(pool);
    const [priya, rahul] = [await createUser(pool), await createUser(pool)];
    const { body } = await hold(priya.token, showId, ['A1', 'A2']);

    // Before the TTL the worker leaves it alone
    expect(await expireHolds(pool)).toBe(0);

    await waitPastTtl();
    expect(await expireHolds(pool)).toBe(1);

    expect(await bookingStatus(body.bookingId)).toBe('EXPIRED');
    expect(await seat(showId, 'A1')).toEqual({ status: 'AVAILABLE', booking_id: null });
    expect(await seat(showId, 'A2')).toEqual({ status: 'AVAILABLE', booking_id: null });
    expect((await hold(rahul.token, showId, ['A1', 'A2'])).status).toBe(201);

    // Running again finds nothing
    expect(await expireHolds(pool)).toBe(0);
  }, 20_000);

  test('T19: a stale hold is taken over before the sweep, and the sweep leaves the new owner alone', async () => {
    const showId = await createShow(pool);
    const [priya, rahul] = [await createUser(pool), await createUser(pool)];
    const old = (await hold(priya.token, showId, ['A1', 'A2'])).body.bookingId;

    await waitPastTtl();
    // The seat map already shows them AVAILABLE (read-time check), worker not run yet
    const map = await request(app).get(`/api/shows/${showId}/seats`);
    expect(map.body.seats.slice(0, 2).map((s: { status: string }) => s.status)).toEqual([
      'AVAILABLE',
      'AVAILABLE',
    ]);

    const takeover = await hold(rahul.token, showId, ['A1']);
    expect(takeover.status).toBe(201);
    const fresh = takeover.body.bookingId;

    // The old booking is still PENDING until the worker runs
    expect(await bookingStatus(old)).toBe('PENDING');
    expect(await seat(showId, 'A1')).toEqual({ status: 'HELD', booking_id: fresh });
    expect(await seat(showId, 'A2')).toEqual({ status: 'HELD', booking_id: old });

    expect(await expireHolds(pool)).toBe(1);
    expect(await bookingStatus(old)).toBe('EXPIRED');
    expect(await bookingStatus(fresh)).toBe('PENDING');
    // Release is guarded by booking_id: A1 belongs to the new hold and is untouched
    expect(await seat(showId, 'A1')).toEqual({ status: 'HELD', booking_id: fresh });
    expect(await seat(showId, 'A2')).toEqual({ status: 'AVAILABLE', booking_id: null });
  }, 20_000);

  test('two workers running at once expire every booking exactly once', async () => {
    // 150 stale holds across three shows, more than one batch of 100
    const users = await Promise.all(Array.from({ length: 150 }, () => createUser(pool)));
    const shows = [await createShow(pool), await createShow(pool), await createShow(pool)];
    const labels = (
      await pool.query(`SELECT seat_label FROM seats WHERE show_id = $1 ORDER BY id`, [shows[0]])
    ).rows.map((r) => r.seat_label as string);
    await Promise.all(
      users.map((u, i) =>
        holdSeatsDirectly(pool, {
          userId: u.id,
          showId: shows[Math.floor(i / 50)]!,
          labels: [labels[i % 50]!],
          expiresInSeconds: -1,
        }),
      ),
    );
    const live = await createUser(pool);
    const liveShow = await createShow(pool);
    await holdSeatsDirectly(pool, {
      userId: live.id,
      showId: liveShow,
      labels: ['A1'],
      expiresInSeconds: 300,
    });

    const [a, b] = await Promise.all([expireHolds(pool, 40), expireHolds(pool, 40)]);
    expect(a + b).toBe(150);

    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM bookings WHERE status = 'EXPIRED') AS expired,
         (SELECT count(*)::int FROM bookings WHERE status = 'PENDING') AS pending,
         (SELECT count(*)::int FROM seats WHERE status = 'HELD') AS held`,
    );
    // Only the live hold survives
    expect(rows[0]).toEqual({ expired: 150, pending: 1, held: 1 });
  }, 30_000);
});
