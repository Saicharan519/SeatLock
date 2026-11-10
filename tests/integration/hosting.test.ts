import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Pool } from 'pg';
import { pruneOldShows, withTransaction } from '@seatlock/db';
import { createLogger } from '@seatlock/shared';
import { createGatewayApp } from '../../apps/mock-gateway/src/app';
import { createPgGatewayStore } from '../../apps/mock-gateway/src/pgStore';
import { createTestApp } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createShow, createUser, holdSeatsDirectly } from '../helpers/factories';

/**
 * Phase 13.5: the behaviour the hosted deployment relies on (Vercel in front of Render,
 * free-tier sleep, a storage cap).
 */
describe('hosting safeguards', () => {
  let pool: Pool;
  const SECRET = 'x'.repeat(40);
  const silent = createLogger('test', 'silent');

  beforeAll(() => {
    pool = createTestPool(5);
  });
  afterAll(() => pool.end());
  beforeEach(() => resetDatabase(pool));

  describe('origin secret (only requests through the website proxy)', () => {
    const app = () => createTestApp(pool, { ORIGIN_SECRET: SECRET });

    test('rejects API requests without the secret, or with a wrong one', async () => {
      const none = await request(app()).get('/api/movies');
      expect(none.status).toBe(403);
      expect(none.body.error.code).toBe('FORBIDDEN');
      const wrong = await request(app()).get('/api/movies').set('X-Origin-Secret', 'y'.repeat(40));
      expect(wrong.status).toBe(403);
      const short = await request(app()).get('/api/movies').set('X-Origin-Secret', 'x');
      expect(short.status).toBe(403);
    });

    test('accepts requests carrying the secret', async () => {
      const res = await request(app()).get('/api/movies').set('X-Origin-Secret', SECRET);
      expect(res.status).toBe(200);
    });

    test('webhooks and the health check stay reachable without it', async () => {
      expect((await request(app()).get('/api/health')).status).toBe(200);
      // Reaches the webhook handler, which rejects the missing signature (401, not 403)
      const hook = await request(app()).post('/api/webhooks/payment').send({});
      expect(hook.status).toBe(401);
    });

    test('without ORIGIN_SECRET configured, nothing changes', async () => {
      expect((await request(createTestApp(pool)).get('/api/movies')).status).toBe(200);
    });
  });

  test('API responses are never cacheable by a shared cache', async () => {
    const res = await request(createTestApp(pool)).get('/api/movies');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  describe('mock gateway with a durable store', () => {
    test('a restarted gateway still knows its charges, so refunds keep working', async () => {
      const store = createPgGatewayStore(pool);
      const options = {
        webhookSecret: process.env.WEBHOOK_SECRET!,
        logger: silent,
        controlEnabled: false,
        webhookDelayMs: 60_000, // no webhook is sent during the test
        store,
      };
      const paymentId = randomUUID();
      const body = { paymentId, amount: 25000, callbackUrl: 'http://127.0.0.1:9/hook' };

      const first = createGatewayApp(options);
      const charged = await request(first.app).post('/charges').send(body);
      expect(charged.status).toBe(201);
      first.stop();

      // A new instance: empty memory, same database
      const second = createGatewayApp(options);
      const again = await request(second.app).post('/charges').send(body);
      expect(again.status).toBe(200); // recognised as the same charge
      expect(again.body.chargeId).toBe(charged.body.chargeId);
      const refund = await request(second.app).post('/refunds').send(body);
      expect(refund.status).toBe(201);
      second.stop();

      const third = createGatewayApp(options);
      const refundAgain = await request(third.app).post('/refunds').send(body);
      expect(refundAgain.status).toBe(200); // the refund is remembered too: no second payout
      expect(refundAgain.body.refundId).toBe(refund.body.refundId);
      third.stop();
    });

    test('an unknown payment is still refused', async () => {
      const gw = createGatewayApp({
        webhookSecret: process.env.WEBHOOK_SECRET!,
        logger: silent,
        controlEnabled: false,
        store: createPgGatewayStore(pool),
      });
      const res = await request(gw.app)
        .post('/refunds')
        .send({ paymentId: randomUUID(), amount: 100, callbackUrl: 'http://127.0.0.1:9/hook' });
      expect(res.status).toBe(404);
      gw.stop();
    });
  });

  describe('pruning old shows (storage cap)', () => {
    const count = async (sql: string, params: unknown[] = []) =>
      (await pool.query(sql, params)).rows[0].n as number;

    test('removes ended, never-booked shows with their seats; keeps booked and upcoming ones', async () => {
      const longAgo = new Date(Date.now() - 3 * 86_400_000);
      const emptyOld = await createShow(pool, { startsAt: longAgo, title: 'Old, empty' });
      const bookedOld = await createShow(pool, { startsAt: longAgo, title: 'Old, booked' });
      const upcoming = await createShow(pool, { title: 'Upcoming' });
      const user = await createUser(pool);
      await holdSeatsDirectly(pool, {
        userId: user.id,
        showId: bookedOld,
        labels: ['A1'],
        expiresInSeconds: -1,
      });

      const removed = await withTransaction(pool, (c) => pruneOldShows(c));
      expect(removed).toBe(1);
      const left = await pool.query(`SELECT id FROM shows ORDER BY starts_at`);
      expect(left.rows.map((r) => r.id).sort()).toEqual([bookedOld, upcoming].sort());
      expect(
        await count(`SELECT count(*)::int AS n FROM seats WHERE show_id = $1`, [emptyOld]),
      ).toBe(0);
      expect(
        await count(`SELECT count(*)::int AS n FROM show_prices WHERE show_id = $1`, [emptyOld]),
      ).toBe(0);
      expect(
        await count(`SELECT count(*)::int AS n FROM seats WHERE show_id = $1`, [bookedOld]),
      ).toBe(50);
    });

    test('a show that ended less than a day ago is kept', async () => {
      await createShow(pool, { startsAt: new Date(Date.now() - 4 * 3_600_000) });
      expect(await withTransaction(pool, (c) => pruneOldShows(c))).toBe(0);
    });
  });
});
