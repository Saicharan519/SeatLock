import { randomUUID } from 'node:crypto';
import { Agent, type Server } from 'node:http';
import request from 'supertest';
import type { Pool } from 'pg';
import { seatLabels } from '@seatlock/db';
import { startTestServer, stopServer } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createShow, createUsers } from '../helpers/factories';

/** Deterministic PRNG so a failing T2 run can be reproduced from its seed. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('hold concurrency', () => {
  // The API pool matches production (20 connections); a small separate pool checks results
  let apiPool: Pool;
  let pool: Pool;
  let server: Server;
  // All requests are fired at once. Desktop Windows refuses connections beyond a ~200-deep
  // accept queue, so the client reuses 200 keep-alive sockets and queues the rest itself.
  // The server still sees 200 concurrent requests competing for 20 DB connections.
  const httpAgent = new Agent({ keepAlive: true, maxSockets: 200 });

  beforeAll(async () => {
    apiPool = createTestPool(20);
    pool = createTestPool(2);
    // Production TTL. With the 5 s test TTL, a burst that takes longer than 5 s to drain
    // lets late requests legitimately take over early holds that have already expired.
    server = await startTestServer(apiPool, { HOLD_TTL_SECONDS: 300 });
  });
  afterAll(async () => {
    httpAgent.destroy();
    await stopServer(server);
    await Promise.all([apiPool.end(), pool.end()]);
  });
  beforeEach(() => resetDatabase(pool));

  const hold = (token: string, showId: string, seats: string[]) =>
    request(server)
      .post('/api/holds')
      .agent(httpAgent)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showId, seats });

  test('T1: 1,000 users race for 50 seats, exactly 50 win', async () => {
    const showId = await createShow(pool);
    const users = await createUsers(pool, 1000);
    const labels = seatLabels();

    const responses = await Promise.all(
      users.map((u, i) => hold(u.token, showId, [labels[i % 50]!])),
    );

    const outcomes: Record<string, number> = {};
    for (const r of responses) {
      const key = r.status === 201 ? '201' : `${r.status} ${r.body.error?.code}`;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
    }
    // Exactly two outcomes, and no 503s or pool errors (R6)
    expect(outcomes).toEqual({ '201': 50, '409 SEAT_UNAVAILABLE': 950 });

    const { rows } = await pool.query(
      `SELECT count(*)::int AS held, count(DISTINCT booking_id)::int AS bookings
       FROM seats WHERE show_id = $1 AND status = 'HELD'`,
      [showId],
    );
    expect(rows[0]).toEqual({ held: 50, bookings: 50 });

    // Every winner holds exactly the seat its response says
    const winners = responses.filter((r) => r.status === 201).map((r) => r.body);
    expect(new Set(winners.map((w) => w.seats[0])).size).toBe(50);
    const pending = await pool.query(
      `SELECT count(*)::int AS n FROM bookings WHERE status = 'PENDING'`,
    );
    expect(pending.rows[0].n).toBe(50);
  }, 120_000);

  test('T2: 200 users with random overlapping 1-4 seat requests never get partial or shared seats', async () => {
    const seed = Date.now();
    const random = mulberry32(seed);
    const showId = await createShow(pool);
    const users = await createUsers(pool, 200);
    const labels = seatLabels();

    const requests = users.map((u) => {
      const count = 1 + Math.floor(random() * 4);
      const picked = new Set<string>();
      while (picked.size < count) picked.add(labels[Math.floor(random() * 50)]!);
      return { user: u, seats: [...picked].sort() };
    });

    const deadlocksBefore = await deadlockCount(pool);
    const responses = await Promise.all(requests.map((r) => hold(r.user.token, showId, r.seats)));

    // Only success or a clean SEAT_UNAVAILABLE: no deadlock or retry errors surface
    for (const r of responses) {
      if (r.status !== 201) {
        expect({ seed, status: r.status, code: r.body.error?.code }).toEqual({
          seed,
          status: 409,
          code: 'SEAT_UNAVAILABLE',
        });
      }
    }

    // Every successful booking holds exactly the seats it asked for
    const won = responses.flatMap((r, i) =>
      r.status === 201 ? [{ ...requests[i]!, body: r.body }] : [],
    );
    expect(won.length).toBeGreaterThan(0);
    for (const w of won) {
      expect([...w.body.seats].sort()).toEqual(w.seats);
      const { rows } = await pool.query(
        `SELECT seat_label FROM seats WHERE booking_id = $1 AND status = 'HELD'`,
        [w.body.bookingId],
      );
      // Sorted in JS, not SQL: database collation may order labels differently
      expect(rows.map((r) => r.seat_label).sort()).toEqual(w.seats);
    }

    // No seat appears in two live bookings, and HELD seats match live booking items exactly
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM seats WHERE show_id = $1 AND status = 'HELD') AS held_seats,
         (SELECT count(*)::int FROM booking_items i JOIN bookings b ON b.id = i.booking_id
           WHERE b.status = 'PENDING') AS live_items,
         (SELECT count(*)::int FROM (
            SELECT i.seat_id FROM booking_items i JOIN bookings b ON b.id = i.booking_id
            WHERE b.status = 'PENDING' GROUP BY i.seat_id HAVING count(*) > 1) d) AS shared_seats`,
      [showId],
    );
    expect(rows[0]).toEqual({
      held_seats: won.reduce((n, w) => n + w.seats.length, 0),
      live_items: won.reduce((n, w) => n + w.seats.length, 0),
      shared_seats: 0,
    });

    // Id-ordered locking (R2) means Postgres should never even detect a deadlock
    await new Promise((resolve) => setTimeout(resolve, 1500)); // let backends flush stats
    expect((await deadlockCount(pool)) - deadlocksBefore).toBe(0);
  }, 120_000);
});

async function deadlockCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query(
    `SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()`,
  );
  return rows[0].n;
}
