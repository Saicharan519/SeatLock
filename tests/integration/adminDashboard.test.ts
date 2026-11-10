import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Pool } from 'pg';
import { deleteUnbookedShow } from '../../apps/api/src/repositories/catalogRepository';
import { createTestApp, waitFor } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createShow, createUser, holdSeatsDirectly } from '../helpers/factories';
import { insertEvents } from '../helpers/outbox';

/**
 * Phase 15: the admin dashboard's API. Reads (overview, bookings, theatres, a theatre's day)
 * and the two new catalogue writes (edit a movie, delete a show nobody booked).
 */
describe('admin dashboard API', () => {
  let pool: Pool;
  let app: ReturnType<typeof createTestApp>;
  let adminAuth: string;

  beforeAll(() => {
    pool = createTestPool(6);
    app = createTestApp(pool);
  });
  afterAll(() => pool.end());
  beforeEach(async () => {
    await resetDatabase(pool);
    adminAuth = `Bearer ${(await createUser(pool, 'ADMIN')).token}`;
  });

  const get = (path: string) => request(app).get(path).set('Authorization', adminAuth);

  /** A paid booking, written straight to the database the way a confirmed payment leaves it. */
  async function confirmedBooking(
    userId: string,
    showId: string,
    labels: string[],
    provider: 'MOCK' | 'CASHFREE' = 'MOCK',
  ) {
    const id = await holdSeatsDirectly(pool, { userId, showId, labels, expiresInSeconds: 300 });
    await pool.query(
      `INSERT INTO booking_items (booking_id, seat_id, price, is_confirmed)
       SELECT $1, id, 20000, true FROM seats WHERE booking_id = $1`,
      [id],
    );
    await pool.query(`UPDATE seats SET status = 'BOOKED' WHERE booking_id = $1`, [id]);
    await pool.query(`UPDATE bookings SET status = 'CONFIRMED', total_amount = $2 WHERE id = $1`, [
      id,
      20000 * labels.length,
    ]);
    await pool.query(
      `INSERT INTO payments (booking_id, amount, status, provider) VALUES ($1, $2, 'SUCCESS', $3)`,
      [id, 20000 * labels.length, provider],
    );
    return id;
  }

  async function theatreOfShow(showId: string) {
    const { rows } = await pool.query<{ theatre_id: string; movie_id: string }>(
      `SELECT sc.theatre_id, sh.movie_id FROM shows sh JOIN screens sc ON sc.id = sh.screen_id
       WHERE sh.id = $1`,
      [showId],
    );
    return rows[0]!;
  }

  test('every dashboard route requires authentication (401) and the ADMIN role (403)', async () => {
    const user = await createUser(pool);
    const id = '00000000-0000-4000-8000-000000000000';
    const routes: [method: 'get' | 'patch' | 'delete', path: string][] = [
      ['get', '/api/admin/overview'],
      ['get', '/api/admin/bookings'],
      ['get', '/api/admin/theatres'],
      ['get', `/api/admin/shows?theatreId=${id}&date=2026-01-01`],
      ['patch', `/api/admin/movies/${id}`],
      ['delete', `/api/admin/shows/${id}`],
    ];
    for (const [method, path] of routes) {
      expect((await request(app)[method](path)).status).toBe(401);
      const asUser = await request(app)[method](path).set('Authorization', `Bearer ${user.token}`);
      expect(asUser.status).toBe(403);
    }
  });

  test('overview: revenue, tickets, live holds, occupancy, gateways, top movies, events', async () => {
    const [a, b, c] = [await createUser(pool), await createUser(pool), await createUser(pool)];
    const show = await createShow(pool, { title: 'Big Film' });
    await confirmedBooking(a.id, show, ['A1', 'A2'], 'MOCK');
    await confirmedBooking(b.id, show, ['B1'], 'CASHFREE');
    await holdSeatsDirectly(pool, {
      userId: c.id,
      showId: show,
      labels: ['C1'],
      expiresInSeconds: 300,
    });
    const [failed] = await insertEvents(pool, 2, 'RefundRequired', { paymentId: 'p', amount: 1 });
    await pool.query(`UPDATE outbox_events SET status = 'FAILED' WHERE id = $1`, [failed]);

    const res = await get('/api/admin/overview');
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({
      confirmedBookings: 2,
      revenue: 60000,
      ticketsSold: 3,
      activeHolds: 1,
      refundsPending: 0,
      customers: 3,
      upcomingShows: 1,
      upcomingSeats: 50,
      upcomingBooked: 3,
      upcomingOccupancy: 3 / 50,
    });
    // Seven days, oldest first, today last with today's revenue
    expect(res.body.revenueByDay).toHaveLength(7);
    expect(res.body.revenueByDay.at(-1)).toMatchObject({ bookings: 2, revenue: 60000 });
    expect(res.body.revenueByDay[0]).toMatchObject({ bookings: 0, revenue: 0 });
    expect(res.body.bookingsByStatus).toEqual({ CONFIRMED: 2, PENDING: 1 });
    expect(res.body.revenueByProvider).toEqual([
      { provider: 'CASHFREE', bookings: 1, revenue: 20000 },
      { provider: 'MOCK', bookings: 1, revenue: 40000 },
    ]);
    expect(res.body.outbox).toEqual({ PENDING: 1, FAILED: 1 });
    expect(res.body.topMovies).toEqual([
      expect.objectContaining({ title: 'Big Film', tickets: 3, revenue: 60000 }),
    ]);
    expect(res.body.recentBookings).toHaveLength(3);
  });

  test('overview on an empty database is all zeros, not an error', async () => {
    const res = await get('/api/admin/overview');
    expect(res.status).toBe(200);
    expect(res.body.totals).toMatchObject({ revenue: 0, upcomingOccupancy: 0 });
    expect(res.body.recentBookings).toEqual([]);
  });

  test('bookings: everyone’s, newest first, filtered by status, email or ticket reference', async () => {
    const a = await createUser(pool);
    const b = await createUser(pool);
    const show = await createShow(pool);
    const paid = await confirmedBooking(a.id, show, ['A1', 'A2'], 'CASHFREE');
    const held = await holdSeatsDirectly(pool, {
      userId: b.id,
      showId: show,
      labels: ['B1'],
      expiresInSeconds: 300,
    });

    const all = await get('/api/admin/bookings');
    expect(all.status).toBe(200);
    expect(all.body.bookings.map((x: { id: string }) => x.id)).toEqual([held, paid]);
    expect(all.body.bookings[1]).toMatchObject({
      status: 'CONFIRMED',
      totalAmount: 40000,
      seats: ['A1', 'A2'],
      payment: { status: 'SUCCESS', provider: 'CASHFREE' },
      movieTitle: 'Test Show',
      theatre: { city: 'Testville' },
    });

    const confirmed = await get('/api/admin/bookings?status=CONFIRMED');
    expect(confirmed.body.bookings.map((x: { id: string }) => x.id)).toEqual([paid]);

    const { rows } = await pool.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [
      b.id,
    ]);
    const byEmail = await get(`/api/admin/bookings?q=${rows[0]!.email.slice(0, 8).toUpperCase()}`);
    expect(byEmail.body.bookings.map((x: { id: string }) => x.id)).toEqual([held]);

    // The reference on a ticket is the id's first 8 characters, printed upper case
    const byRef = await get(`/api/admin/bookings?q=${paid.slice(0, 8).toUpperCase()}`);
    expect(byRef.body.bookings.map((x: { id: string }) => x.id)).toEqual([paid]);

    expect((await get('/api/admin/bookings?status=NOPE')).status).toBe(400);
    expect((await get('/api/admin/bookings?q=%25')).body.bookings).toEqual([]);
  });

  test('theatres: every theatre with its screens, seat categories and upcoming show count', async () => {
    const show = await createShow(pool);
    const { theatre_id } = await theatreOfShow(show);
    const res = await get('/api/admin/theatres');
    expect(res.status).toBe(200);
    expect(res.body.theatres).toEqual([
      expect.objectContaining({
        id: theatre_id,
        city: 'Testville',
        screens: [
          expect.objectContaining({
            name: 'Screen 1',
            seatCount: 50,
            categories: ['STANDARD'],
            upcomingShows: 1,
            layout: expect.objectContaining({ rows: expect.any(Array) }),
          }),
        ],
      }),
    ]);
  });

  test('a theatre’s day: its shows with seats sold and bookings, by calendar day in IST', async () => {
    // 10:00 IST tomorrow, i.e. 04:30 UTC
    const tomorrow = new Date(Date.now() + 86_400_000).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Kolkata',
    });
    const startsAt = new Date(`${tomorrow}T10:00:00+05:30`);
    const show = await createShow(pool, { startsAt });
    const { theatre_id } = await theatreOfShow(show);
    const user = await createUser(pool);
    await confirmedBooking(user.id, show, ['A1', 'A2', 'A3']);

    const res = await get(`/api/admin/shows?theatreId=${theatre_id}&date=${tomorrow}`);
    expect(res.status).toBe(200);
    expect(res.body.shows).toEqual([
      expect.objectContaining({
        id: show,
        startsAt: startsAt.toISOString(),
        screen: expect.objectContaining({ name: 'Screen 1' }),
        movie: expect.objectContaining({ title: 'Test Show' }),
        prices: [{ category: 'STANDARD', price: 20000 }],
        totalSeats: 50,
        bookedSeats: 3,
        bookings: 1,
      }),
    ]);

    const otherDay = await get(`/api/admin/shows?theatreId=${theatre_id}&date=2020-01-01`);
    expect(otherDay.body.shows).toEqual([]);
    const unknown = await get(
      `/api/admin/shows?theatreId=00000000-0000-4000-8000-000000000000&date=${tomorrow}`,
    );
    expect(unknown.status).toBe(404);
    expect((await get(`/api/admin/shows?theatreId=${theatre_id}&date=tomorrow`)).status).toBe(400);
  });

  describe('editing a movie', () => {
    const patch = (id: string, body: object) =>
      request(app).patch(`/api/admin/movies/${id}`).set('Authorization', adminAuth).send(body);

    test('changes only the fields sent; everything else is kept', async () => {
      const show = await createShow(pool, { title: 'Old Title' });
      const { movie_id } = await theatreOfShow(show);
      await pool.query(
        `UPDATE movies SET synopsis = 'Keep me', cast_members = '{A,B}', rating = 7.5 WHERE id = $1`,
        [movie_id],
      );

      const res = await patch(movie_id, {
        title: 'New Title',
        genres: ['Drama'],
        posterUrl: 'https://example.com/p.jpg',
      });
      expect(res.status).toBe(200);
      expect(res.body.movie).toMatchObject({
        id: movie_id,
        title: 'New Title',
        genres: ['Drama'],
        posterUrl: 'https://example.com/p.jpg',
        synopsis: 'Keep me',
        cast: ['A', 'B'],
        rating: 7.5,
      });
      // The public page shows the edit, under the unchanged slug
      const pub = await request(app).get(`/api/movies/${res.body.movie.slug}`);
      expect(pub.body.movie.title).toBe('New Title');

      // Clearing a nullable field is an edit too
      expect((await patch(movie_id, { rating: null })).body.movie.rating).toBeNull();
    });

    test('rejects a slug change, unknown fields, an empty edit and bad values', async () => {
      const { movie_id } = await theatreOfShow(await createShow(pool));
      for (const body of [
        { slug: 'new-slug' },
        { colour: 'red' },
        {},
        { durationMinutes: 0 },
        { certificate: 'X' },
        { posterUrl: 'javascript:alert(1)' },
      ]) {
        const res = await patch(movie_id, body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
      }
    });

    test('an unknown movie is 404', async () => {
      const res = await patch('00000000-0000-4000-8000-000000000000', { title: 'X' });
      expect(res.status).toBe(404);
      expect((await patch('not-a-uuid', { title: 'X' })).status).toBe(404);
    });
  });

  describe('deleting a show', () => {
    const del = (id: string) =>
      request(app).delete(`/api/admin/shows/${id}`).set('Authorization', adminAuth);

    test('a show nobody booked is removed with its seats and prices', async () => {
      const show = await createShow(pool);
      expect((await del(show)).status).toBe(204);
      expect((await request(app).get(`/api/shows/${show}`)).status).toBe(404);
      const { rows } = await pool.query(
        `SELECT (SELECT count(*)::int FROM seats WHERE show_id = $1) AS seats,
                (SELECT count(*)::int FROM show_prices WHERE show_id = $1) AS prices`,
        [show],
      );
      expect(rows[0]).toEqual({ seats: 0, prices: 0 });
      expect((await del(show)).status).toBe(404);
    });

    test('a show with any booking, even an expired hold, is kept (409)', async () => {
      const show = await createShow(pool);
      const user = await createUser(pool);
      await holdSeatsDirectly(pool, {
        userId: user.id,
        showId: show,
        labels: ['A1'],
        expiresInSeconds: -60,
      });
      const res = await del(show);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('INVALID_STATE');
      expect((await request(app).get(`/api/shows/${show}`)).status).toBe(200);
    });

    test('a hold racing the delete waits on the show row, then gets a clean 404', async () => {
      const show = await createShow(pool);
      const user = await createUser(pool);

      // The delete has run but not committed: the show row is locked and deleted
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        expect(await deleteUnbookedShow(client, show)).toBe('deleted');

        const hold = request(app)
          .post('/api/holds')
          .set('Authorization', `Bearer ${user.token}`)
          .set('Idempotency-Key', randomUUID())
          .send({ showId: show, seats: ['A1'] })
          .then((r) => r);

        // The hold still sees the show and seats (uncommitted delete), inserts its booking,
        // and the foreign-key check blocks on the locked show row
        await waitFor(async () => {
          const { rows } = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          );
          return rows[0]!.n > 0;
        });
        await client.query('COMMIT');

        const res = await hold;
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('NOT_FOUND');
      } finally {
        client.release();
      }
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM bookings`);
      expect(rows[0]).toEqual({ n: 0 });
    });
  });
});
