import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Pool } from 'pg';
import { afterCommit, withTransaction } from '@seatlock/db';
import type { Logger } from '@seatlock/shared';
import { setTransitionLogger } from '../../apps/api/src/utils/transitionLog';
import { expireHolds } from '../../apps/worker/src/jobs/expireHolds';
import { createTestApp } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createShow, createUser, holdSeatsDirectly } from '../helpers/factories';
import { deliverEvent, gatewayEvent, pendingPayment } from '../helpers/webhooks';

/** PRD observability: booking and payment transitions are logged (id, from, to), after commit only. */
describe('state-transition logging', () => {
  let pool: Pool;
  let app: ReturnType<typeof createTestApp>;
  let logged: { entity: string; id: string; from: string; to: string }[];
  const capture = {
    info: (entry: { entity: string; id: string; from: string; to: string }) => logged.push(entry),
  } as unknown as Logger;

  beforeAll(() => {
    pool = createTestPool(5);
    app = createTestApp(pool, { HOLD_TTL_SECONDS: 300 });
  });
  afterAll(async () => {
    setTransitionLogger(undefined);
    await pool.end();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    logged = [];
    setTransitionLogger(capture);
  });

  test('a confirmed booking logs both transitions', async () => {
    const { bookingId, paymentId } = await pendingPayment(pool, app);
    await deliverEvent(app, gatewayEvent('payment.succeeded', paymentId));
    expect(logged).toEqual([
      { entity: 'booking', id: bookingId, from: 'PENDING', to: 'CONFIRMED' },
      { entity: 'payment', id: paymentId, from: 'INITIATED', to: 'SUCCESS' },
    ]);
  });

  test('a transition inside a transaction that rolls back is never logged', async () => {
    // Priya has a stale hold, and asks for a seat Rahul holds. The hold transaction marks her
    // stale booking EXPIRED, then fails with SEAT_UNAVAILABLE and rolls everything back.
    const showId = await createShow(pool);
    const [priya, rahul] = [await createUser(pool), await createUser(pool)];
    const stale = await holdSeatsDirectly(pool, {
      userId: priya.id,
      showId,
      labels: ['A1'],
      expiresInSeconds: -1,
    });
    await holdSeatsDirectly(pool, {
      userId: rahul.id,
      showId,
      labels: ['B1'],
      expiresInSeconds: 300,
    });

    const res = await request(app)
      .post('/api/holds')
      .set('Authorization', `Bearer ${priya.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showId, seats: ['B1'] });
    expect(res.body.error.code).toBe('SEAT_UNAVAILABLE');

    const { rows } = await pool.query(`SELECT status FROM bookings WHERE id = $1`, [stale]);
    expect(rows[0].status).toBe('PENDING'); // the EXPIRED change was rolled back...
    expect(logged).toEqual([]); // ...so it was never logged
  });

  test('the worker logs each booking it expires', async () => {
    const logs: object[] = [];
    const workerLogger = { info: (entry: object) => logs.push(entry) } as unknown as Logger;
    const { bookingId } = await pendingPayment(pool, app);
    await pool.query(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      bookingId,
    ]);

    await expireHolds(pool, 100, workerLogger);
    expect(logs).toEqual([{ entity: 'booking', id: bookingId, from: 'PENDING', to: 'EXPIRED' }]);
  });

  describe('afterCommit', () => {
    test('runs after COMMIT, never after ROLLBACK, and only once across deadlock retries', async () => {
      const calls: string[] = [];

      await withTransaction(pool, async (client) => {
        afterCommit(client, () => calls.push('committed'));
        expect(calls).toEqual([]); // not yet: still inside the transaction
      });
      expect(calls).toEqual(['committed']);

      await expect(
        withTransaction(pool, async (client) => {
          afterCommit(client, () => calls.push('rolled back'));
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(calls).toEqual(['committed']);

      // First attempt deadlocks after registering a callback; the retry succeeds
      let attempt = 0;
      await withTransaction(pool, async (client) => {
        attempt += 1;
        afterCommit(client, () => calls.push(`attempt ${attempt}`));
        if (attempt === 1) throw Object.assign(new Error('deadlock'), { code: '40P01' });
      });
      expect(calls).toEqual(['committed', 'attempt 2']);
    });
  });
});
