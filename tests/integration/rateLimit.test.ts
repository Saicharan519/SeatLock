import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Pool } from 'pg';
import type { Redis } from '@seatlock/shared';
import { createTestApp } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createShow, createUser } from '../helpers/factories';
import { closeRedis, connectTestRedis, unreachableRedis } from '../helpers/redis';

/** FR-18: auth 10/min per IP; holds and pay 30/min per user (shared). Redis fails open (T13). */
describe('rate limiting (FR-18) and Redis outages (T13)', () => {
  let pool: Pool;
  let redis: Redis;

  beforeAll(async () => {
    pool = createTestPool(10);
    redis = await connectTestRedis();
  });
  afterAll(async () => {
    await closeRedis(redis);
    await pool.end();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    await redis.flushdb(); // test database 1 only
  });

  const limitedApp = (r: Redis | null = redis, overrides = {}) =>
    createTestApp(
      pool,
      { RATE_LIMIT_ENABLED: true, HOLD_TTL_SECONDS: 300, ...overrides },
      undefined,
      r,
    );
  const badLogin = (app: ReturnType<typeof createTestApp>, ip?: string) => {
    const req = request(app).post('/api/auth/login');
    if (ip) req.set('X-Forwarded-For', ip);
    return req.send({ email: 'nobody@test.local', password: 'wrong-password' });
  };
  const hold = (
    app: ReturnType<typeof createTestApp>,
    token: string,
    showId: string,
    seats = ['A1'],
  ) =>
    request(app)
      .post('/api/holds')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showId, seats });

  describe('limits', () => {
    test('auth: 10 per minute per IP, then 429 with Retry-After', async () => {
      const app = limitedApp();
      const remaining: (string | undefined)[] = [];
      for (let i = 0; i < 10; i++) {
        const res = await badLogin(app);
        expect(res.status).toBe(401); // allowed through (wrong password)
        remaining.push(res.headers['ratelimit-remaining']);
      }
      expect(remaining).toEqual(['9', '8', '7', '6', '5', '4', '3', '2', '1', '0']);

      const blocked = await badLogin(app);
      expect(blocked.status).toBe(429);
      expect(blocked.body.error.code).toBe('RATE_LIMITED');
      const retryAfter = Number(blocked.headers['retry-after']);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);

      // The counter expires with the window
      const keys = await redis.keys('rl:auth:*');
      expect(keys).toHaveLength(1);
      const ttl = await redis.pttl(keys[0]!);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
    });

    test('auth limits are per IP (behind a trusted proxy)', async () => {
      const app = limitedApp(redis, { TRUST_PROXY: true });
      for (let i = 0; i < 10; i++) await badLogin(app, '203.0.113.1');
      expect((await badLogin(app, '203.0.113.1')).status).toBe(429);
      expect((await badLogin(app, '203.0.113.2')).status).toBe(401); // a different client
    });

    test('concurrent first requests still count exactly (atomic increment + expiry)', async () => {
      const app = limitedApp();
      const responses = await Promise.all(Array.from({ length: 25 }, () => badLogin(app)));
      expect(responses.filter((r) => r.status === 401)).toHaveLength(10);
      expect(responses.filter((r) => r.status === 429)).toHaveLength(15);
    });

    test('holds and pay share 30 per minute per user; other users are unaffected', async () => {
      const app = limitedApp();
      const showId = await createShow(pool);
      const [rahul, priya] = [await createUser(pool), await createUser(pool)];

      const first = await hold(app, rahul.token, showId);
      expect(first.status).toBe(201);
      for (let i = 0; i < 28; i++) await hold(app, rahul.token, showId); // 409s, but they count
      const pay = await request(app)
        .post(`/api/bookings/${first.body.bookingId}/pay`)
        .set('Authorization', `Bearer ${rahul.token}`)
        .set('Idempotency-Key', randomUUID())
        .send();
      expect(pay.status).toBe(202); // request 30
      const blocked = await hold(app, rahul.token, showId, ['B1']);
      expect(blocked.status).toBe(429); // request 31

      expect((await hold(app, priya.token, showId, ['C1'])).status).toBe(201);
      // Reads aren't limited
      const map = await request(app).get(`/api/shows/${showId}/seats`);
      expect(map.status).toBe(200);
    });

    test('RATE_LIMIT_ENABLED=false turns limiting off entirely (for load tests)', async () => {
      const app = limitedApp(redis, { RATE_LIMIT_ENABLED: false });
      for (let i = 0; i < 15; i++) {
        const res = await badLogin(app);
        expect(res.status).toBe(401);
        expect(res.headers['ratelimit-limit']).toBeUndefined();
      }
    });
  });

  describe('T13: the API keeps working when Redis is down (fail open)', () => {
    /** Register, log in, hold and pay: the full write path, timed. */
    async function fullFlow(app: ReturnType<typeof createTestApp>) {
      const started = Date.now();
      const email = `t13-${randomUUID()}@test.local`;
      const reg = await request(app)
        .post('/api/auth/register')
        .send({ name: 'T13', email, password: 'password123' });
      const login = await request(app)
        .post('/api/auth/login')
        .send({ email, password: 'password123' });
      const showId = await createShow(pool);
      const held = await hold(app, login.body.token, showId);
      const pay = await request(app)
        .post(`/api/bookings/${held.body.bookingId}/pay`)
        .set('Authorization', `Bearer ${login.body.token}`)
        .set('Idempotency-Key', randomUUID())
        .send();
      return {
        statuses: [reg.status, login.status, held.status, pay.status],
        limited: [reg, login, held, pay].some((r) => r.headers['ratelimit-limit'] !== undefined),
        ms: Date.now() - started,
      };
    }

    test('Redis unreachable from the start: every request succeeds, unlimited, without hanging', async () => {
      const dead = unreachableRedis();
      try {
        const result = await fullFlow(limitedApp(dead));
        expect(result.statuses).toEqual([201, 200, 201, 202]);
        expect(result.limited).toBe(false);
        expect(result.ms).toBeLessThan(3000);
      } finally {
        await closeRedis(dead);
      }
    });

    test('Redis drops out mid-run: requests keep succeeding, and limiting resumes when it returns', async () => {
      const own = await connectTestRedis();
      try {
        const app = limitedApp(own);
        expect((await fullFlow(app)).limited).toBe(true); // working normally

        own.disconnect(); // Redis gone
        const during = await fullFlow(app);
        expect(during.statuses).toEqual([201, 200, 201, 202]);
        expect(during.limited).toBe(false);

        await own.connect(); // Redis back
        expect((await fullFlow(app)).limited).toBe(true);
      } finally {
        await closeRedis(own);
      }
    });

    test('Redis connected but frozen: the 250 ms command timeout lets requests through', async () => {
      const app = limitedApp();
      const admin = await connectTestRedis();
      try {
        // CLIENT PAUSE stops Redis answering any client's commands, like a stalled server
        await admin.call('CLIENT', 'PAUSE', '2000', 'ALL');
        const started = Date.now();
        const res = await badLogin(app);
        expect(res.status).toBe(401); // allowed through, not 429, not a hang
        expect(res.headers['ratelimit-limit']).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(1500);
      } finally {
        await admin.call('CLIENT', 'UNPAUSE').catch(() => undefined);
        await closeRedis(admin);
      }
    });
  });
});
