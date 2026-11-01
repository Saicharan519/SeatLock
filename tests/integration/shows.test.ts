import request from 'supertest';
import type { Pool } from 'pg';
import { createTestApp } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createShow, createUser, holdSeatsDirectly } from '../helpers/factories';

describe('shows and seat map (FR-02, FR-03)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    pool = createTestPool(5);
    app = createTestApp(pool);
  });
  afterAll(() => pool.end());
  beforeEach(() => resetDatabase(pool));

  test('GET /shows lists only upcoming shows, soonest first', async () => {
    const later = await createShow(pool, {
      title: 'Later',
      startsAt: new Date(Date.now() + 2 * 86_400_000),
    });
    const sooner = await createShow(pool, {
      title: 'Sooner',
      startsAt: new Date(Date.now() + 3_600_000),
    });
    await createShow(pool, { title: 'Past', startsAt: new Date(Date.now() - 3_600_000) });

    const res = await request(app).get('/api/shows');
    expect(res.status).toBe(200);
    expect(res.body.shows.map((s: { id: string }) => s.id)).toEqual([sooner, later]);
    expect(res.body.shows[0]).toMatchObject({
      title: 'Sooner',
      venue: 'Test Hall',
      pricePerSeat: 20000,
    });
  });

  test('GET /shows/:id returns the show, and 404 for unknown or malformed ids', async () => {
    const id = await createShow(pool);
    expect((await request(app).get(`/api/shows/${id}`)).body.show.id).toBe(id);

    const unknown = await request(app).get('/api/shows/00000000-0000-4000-8000-000000000000');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('NOT_FOUND');
    expect((await request(app).get('/api/shows/not-a-uuid')).status).toBe(404);
  });

  test('seat map has 50 seats A1..E10, all AVAILABLE for a new show', async () => {
    const id = await createShow(pool);
    const res = await request(app).get(`/api/shows/${id}/seats`);
    expect(res.status).toBe(200);
    expect(res.body.seats).toHaveLength(50);
    expect(res.body.seats[0]).toEqual({ label: 'A1', status: 'AVAILABLE' });
    expect(res.body.seats[49]).toEqual({ label: 'E10', status: 'AVAILABLE' });
    expect(res.body.seats.every((s: { status: string }) => s.status === 'AVAILABLE')).toBe(true);
  });

  test('seat map shows live holds as HELD and stale holds as AVAILABLE (read-time check)', async () => {
    const showId = await createShow(pool);
    const priya = await createUser(pool);
    const rahul = await createUser(pool);
    await holdSeatsDirectly(pool, {
      userId: priya.id,
      showId,
      labels: ['A1', 'A2'],
      expiresInSeconds: 300,
    });
    // Expired, but the worker hasn't swept it: the row still says HELD
    await holdSeatsDirectly(pool, {
      userId: rahul.id,
      showId,
      labels: ['B1'],
      expiresInSeconds: -1,
    });
    await pool.query(
      `UPDATE seats SET status = 'BOOKED' WHERE show_id = $1 AND seat_label = 'A2'`,
      [showId],
    );

    const res = await request(app).get(`/api/shows/${showId}/seats`);
    const status = Object.fromEntries(
      res.body.seats.map((s: { label: string; status: string }) => [s.label, s.status]),
    );
    expect(status.A1).toBe('HELD');
    expect(status.A2).toBe('BOOKED');
    expect(status.B1).toBe('AVAILABLE');
  });

  describe('POST /admin/shows', () => {
    const body = () => ({
      title: 'Dune: Part Three',
      venue: 'INOX, Screen 2',
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
      pricePerSeat: 30000,
    });

    test('requires authentication (401) and the ADMIN role (403)', async () => {
      expect((await request(app).post('/api/admin/shows').send(body())).status).toBe(401);

      const user = await createUser(pool);
      const res = await request(app)
        .post('/api/admin/shows')
        .set('Authorization', `Bearer ${user.token}`)
        .send(body());
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    test('creates the show and its 50 seats', async () => {
      const admin = await createUser(pool, 'ADMIN');
      const res = await request(app)
        .post('/api/admin/shows')
        .set('Authorization', `Bearer ${admin.token}`)
        .send(body());
      expect(res.status).toBe(201);
      expect(res.body.show).toMatchObject({
        title: 'Dune: Part Three',
        pricePerSeat: 30000,
        seatCount: 50,
      });

      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM seats WHERE show_id = $1`, [
        res.body.show.id,
      ]);
      expect(rows[0].n).toBe(50);
    });

    test('rejects past start times and non-integer prices', async () => {
      const admin = await createUser(pool, 'ADMIN');
      const send = (b: object) =>
        request(app).post('/api/admin/shows').set('Authorization', `Bearer ${admin.token}`).send(b);

      const past = await send({ ...body(), startsAt: new Date(Date.now() - 1000).toISOString() });
      expect(past.status).toBe(400);
      const fractional = await send({ ...body(), pricePerSeat: 199.5 });
      expect(fractional.status).toBe(400);
      expect(fractional.body.error.code).toBe('VALIDATION_ERROR');

      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM shows`);
      expect(rows[0].n).toBe(0);
    });
  });
});
