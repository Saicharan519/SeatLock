import request from 'supertest';
import type { Pool } from 'pg';
import { createTestPool } from '../helpers/db';
import { createTestApp } from '../helpers/app';

describe('GET /api/health', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createTestPool(2);
  });
  afterAll(() => pool.end());

  test('reports the database as up', async () => {
    const res = await request(createTestApp(pool)).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });

  test('unknown routes return the standard error shape with a request ID', async () => {
    const res = await request(createTestApp(pool)).get('/api/nope').set('X-Request-Id', 'req-123');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found', requestId: 'req-123' },
    });
  });
});
