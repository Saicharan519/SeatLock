import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Pool } from 'pg';
import { createTestApp } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createShow, createUser } from '../helpers/factories';

/**
 * Phase 16: the website's session lives in an httpOnly cookie, and cookie-authenticated
 * writes need the X-SeatLock-Client header (CSRF). Bearer tokens keep working for API clients.
 */
describe('session cookie and CSRF protection', () => {
  let pool: Pool;
  let app: ReturnType<typeof createTestApp>;
  const CSRF = 'x-seatlock-client';

  beforeAll(() => {
    pool = createTestPool(4);
    app = createTestApp(pool);
  });
  afterAll(() => pool.end());
  beforeEach(() => resetDatabase(pool));

  /** Registers a user and returns the Set-Cookie value and the session cookie pair. */
  async function signUp() {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Cookie User',
        email: `c-${randomUUID()}@example.test`,
        password: 'password123',
      });
    expect(res.status).toBe(201);
    const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
    const session = setCookie.find((c) => c.startsWith('seatlock_session='))!;
    return { res, setCookie: session, cookie: session.split(';')[0]! };
  }

  test('signing up or in sets an httpOnly, SameSite=Lax cookie scoped to /api, lasting an hour', async () => {
    const { setCookie, res } = await signUp();
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\/api/);
    expect(setCookie).toMatch(/Max-Age=3600/);
    // Not Secure in tests (NODE_ENV=test); production defaults to Secure (next test)
    expect(setCookie).not.toMatch(/Secure/i);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: res.body.user.email, password: 'password123' });
    expect(String(login.headers['set-cookie'])).toMatch(/^seatlock_session=.+HttpOnly/i);
  });

  test('the cookie is Secure in production, or when COOKIE_SECURE says so', async () => {
    for (const overrides of [{ NODE_ENV: 'production' as const }, { COOKIE_SECURE: true }]) {
      const res = await request(createTestApp(pool, overrides))
        .post('/api/auth/register')
        .send({ name: 'S', email: `s-${randomUUID()}@example.test`, password: 'password123' });
      expect(String(res.headers['set-cookie'])).toMatch(/; Secure/i);
    }
  });

  test('the cookie alone authenticates reads', async () => {
    const { cookie, res } = await signUp();
    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe(res.body.user.id);
  });

  test('a cookie-authenticated write without the client header is refused (CSRF), with it accepted', async () => {
    const { cookie } = await signUp();
    const showId = await createShow(pool);
    const hold = () =>
      request(app)
        .post('/api/holds')
        .set('Cookie', cookie)
        .set('Idempotency-Key', randomUUID())
        .send({ showId, seats: ['A1'] });

    // What a forged cross-site request looks like: the browser attaches the cookie, nothing else
    const forged = await hold();
    expect(forged.status).toBe(403);
    expect(forged.body.error.code).toBe('FORBIDDEN');
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM bookings`);
    expect(rows[0]).toEqual({ n: 0 });

    const real = await hold().set(CSRF, 'web');
    expect(real.status).toBe(201);
  });

  test('Bearer tokens still work, and need no client header (browsers never send them on their own)', async () => {
    const user = await createUser(pool);
    const showId = await createShow(pool);
    const res = await request(app)
      .post('/api/holds')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showId, seats: ['A1'] });
    expect(res.status).toBe(201);
  });

  test('a Bearer token wins over a cookie; a bad Bearer is not rescued by a good cookie', async () => {
    const { cookie } = await signUp();
    const other = await createUser(pool);
    const both = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookie)
      .set('Authorization', `Bearer ${other.token}`);
    expect(both.body.user.id).toBe(other.id);

    const bad = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookie)
      .set('Authorization', 'Bearer not-a-token');
    expect(bad.status).toBe(401);
  });

  test('logout clears the cookie', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(204);
    const cleared = String(res.headers['set-cookie']);
    expect(cleared).toMatch(/^seatlock_session=;/);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect(cleared).toMatch(/Path=\/api/);
  });

  test('a tampered, expired-looking or empty cookie is 401', async () => {
    const { cookie } = await signUp();
    for (const bad of [
      `${cookie}x`,
      'seatlock_session=',
      'seatlock_session=abc.def.ghi',
      'other=1',
    ]) {
      expect((await request(app).get('/api/auth/me').set('Cookie', bad)).status).toBe(401);
    }
  });

  test('the cookie is found among other cookies', async () => {
    const { cookie } = await signUp();
    const res = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `theme=dark; ${cookie}; lang=en`);
    expect(res.status).toBe(200);
  });
});
