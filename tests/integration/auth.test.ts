import jwt from 'jsonwebtoken';
import request from 'supertest';
import type { Pool } from 'pg';
import { createTestApp } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';

describe('auth (FR-01)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    pool = createTestPool(5);
    app = createTestApp(pool);
  });
  afterAll(() => pool.end());
  beforeEach(() => resetDatabase(pool));

  const rahul = { name: 'Rahul', email: 'Rahul@Example.com', password: 'correct-horse' };

  test('register returns a user and token, and stores a bcrypt hash', async () => {
    const res = await request(app).post('/api/auth/register').send(rahul);
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      name: 'Rahul',
      email: 'rahul@example.com',
      role: 'USER',
    });
    expect(res.body.user).not.toHaveProperty('password_hash');
    expect(typeof res.body.token).toBe('string');

    const { rows } = await pool.query(`SELECT password_hash FROM users`);
    expect(rows[0].password_hash).toMatch(/^\$2[aby]\$/);
  });

  test('register rejects a duplicate email case-insensitively', async () => {
    await request(app).post('/api/auth/register').send(rahul);
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...rahul, email: 'RAHUL@example.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  test('register validates the body', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ name: '', email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('login succeeds with the right password and fails with the same error otherwise', async () => {
    await request(app).post('/api/auth/register').send(rahul);

    const ok = await request(app)
      .post('/api/auth/login')
      .send({ email: 'rahul@example.com', password: 'correct-horse' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeDefined();

    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: 'rahul@example.com', password: 'wrong-password' });
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'correct-horse' });
    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({
        code: 'UNAUTHENTICATED',
        message: 'Invalid email or password',
      });
    }
  });

  test('GET /auth/me requires a valid token', async () => {
    const { body } = await request(app).post('/api/auth/register').send(rahul);

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('rahul@example.com');

    const missing = await request(app).get('/api/auth/me');
    expect(missing.status).toBe(401);

    const forged = jwt.sign({ role: 'ADMIN' }, 'some-other-secret-entirely', {
      subject: body.user.id,
    });
    const bad = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${forged}`);
    expect(bad.status).toBe(401);

    const expired = jwt.sign({ role: 'USER' }, process.env.JWT_SECRET!, {
      subject: body.user.id,
      expiresIn: -10,
    });
    const old = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${expired}`);
    expect(old.status).toBe(401);
  });
});
