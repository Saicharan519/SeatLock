import request from 'supertest';
import type { Pool } from 'pg';
import type { Redis } from '@seatlock/shared';
import { createTestPool } from '../helpers/db';
import { createTestApp } from '../helpers/app';
import { closeRedis, connectTestRedis } from '../helpers/redis';

/** The health route only calls ping(); a real unreachable client is exercised in T13. */
const deadRedis = {
  ping: () => Promise.reject(new Error('Connection is closed.')),
} as unknown as Redis;

describe('GET /api/health', () => {
  let pool: Pool;
  let redis: Redis;

  beforeAll(async () => {
    pool = createTestPool(2);
    redis = await connectTestRedis();
  });
  afterAll(async () => {
    await closeRedis(redis);
    await pool.end();
  });

  const health = (r: Redis | null) =>
    request(createTestApp(pool, {}, undefined, r)).get('/api/health');

  test('database and Redis up: ok', async () => {
    const res = await health(redis);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up', redis: 'up' });
  });

  test('Redis down: still 200, reported as degraded (the API works without it)', async () => {
    const res = await health(deadRedis);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'degraded', db: 'up', redis: 'down' });
  });

  test('no Redis configured: reported as disabled', async () => {
    expect((await health(null)).body).toEqual({ status: 'ok', db: 'up', redis: 'disabled' });
  });

  test('unknown routes return the standard error shape with a request ID', async () => {
    const res = await request(createTestApp(pool)).get('/api/nope').set('X-Request-Id', 'req-123');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found', requestId: 'req-123' },
    });
  });
});
