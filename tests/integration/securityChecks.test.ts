import { Writable } from 'node:stream';
import request from 'supertest';
import type { Pool } from 'pg';
import { createLogger } from '@seatlock/shared';
import { createApp } from '../../apps/api/src/app';
import { loadApiConfig } from '../../apps/api/src/config/env';
import { loggableUrl } from '../../apps/api/src/middleware/requestLogger';
import { acceptingGateway } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createUser } from '../helpers/factories';

/**
 * Phase 16 security review: what the logs and the API's responses must never reveal, and the
 * headers every response carries. The logs are read exactly as production writes them (same
 * logger, same redaction), from real requests.
 */
describe('security checks', () => {
  let pool: Pool;
  beforeAll(() => {
    pool = createTestPool(4);
  });
  afterAll(() => pool.end());
  beforeEach(() => resetDatabase(pool));

  /** An app whose log lines land in `lines` instead of stdout. */
  function appWithCapturedLogs() {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = createApp({
      pool,
      config: loadApiConfig(),
      logger: createLogger('test', 'debug', sink),
      gateway: acceptingGateway,
      redis: null,
    });
    return { app, lines };
  }

  test('logs never contain passwords, tokens, or the email an admin searched for', async () => {
    const { app, lines } = appWithCapturedLogs();
    const password = 'correct-horse-battery-staple';
    const email = `leaky-${Date.now()}@example.test`;

    const reg = await request(app)
      .post('/api/auth/register')
      .send({ name: 'Leak Test', email, password });
    expect(reg.status).toBe(201);
    const token: string = reg.body.token;

    await request(app).post('/api/auth/login').send({ email, password: 'wrong-password-1' });
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    const admin = await createUser(pool, 'ADMIN');
    const search = await request(app)
      .get(`/api/admin/bookings?q=${encodeURIComponent(email)}&status=CONFIRMED`)
      .set('Authorization', `Bearer ${admin.token}`);
    expect(search.status).toBe(200);

    const log = lines.join('');
    expect(lines.length).toBeGreaterThanOrEqual(4); // the requests really were logged
    for (const secret of [
      password,
      'wrong-password-1',
      token,
      admin.token,
      email,
      encodeURIComponent(email),
    ]) {
      expect(log).not.toContain(secret);
    }
    expect(log).not.toMatch(/authorization|bearer/i);
    expect(log).toContain('q=[REDACTED]&status=CONFIRMED'); // other parameters stay readable
  });

  test('an unexpected error answers with a generic message and a request id, no internals', async () => {
    // The database is unreachable, with an internal hostname in the error
    const broken = createApp({
      pool: { query: () => Promise.reject(new Error('connect ECONNREFUSED db.internal:5432')) },
      config: loadApiConfig(),
      logger: createLogger('test', 'silent'),
      gateway: acceptingGateway,
      redis: null,
    } as never);
    const res = await request(broken).get('/api/movies');
    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong',
      requestId: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|db\.internal|at |stack/);
  });

  test('every API response carries headers that stop framing, sniffing and script execution', async () => {
    const { app } = appWithCapturedLogs();
    for (const path of ['/api/health', '/api/movies', '/api/nope']) {
      const res = await request(app).get(path);
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'none'; frame-ancestors 'none'",
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-powered-by']).toBeUndefined();
    }
  });

  test('a validation error names the field, never echoes the submitted value', async () => {
    const { app } = appWithCapturedLogs();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: 'X', email: 'not-an-email', password: 'short-secret' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('short-secret');
    expect(JSON.stringify(res.body)).not.toContain('not-an-email');
  });

  test('loggableUrl redacts only private parameters', () => {
    expect(loggableUrl('/api/admin/bookings?q=a%40b.com')).toBe('/api/admin/bookings?q=[REDACTED]');
    expect(loggableUrl('/api/x?status=FAILED&q=ref&limit=5')).toBe(
      '/api/x?status=FAILED&q=[REDACTED]&limit=5',
    );
    expect(loggableUrl('/api/movies?city=Hyderabad')).toBe('/api/movies?city=Hyderabad');
    expect(loggableUrl('/api/requests?seq=1')).toBe('/api/requests?seq=1');
  });
});
