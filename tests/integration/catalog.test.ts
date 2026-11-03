import request from 'supertest';
import type { Pool } from 'pg';
import { createTestApp } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createUser } from '../helpers/factories';

/**
 * Phase 12: movies, theatres, screens, showtimes and seat categories, built through the
 * admin API exactly as a real admin would, then browsed through the public API.
 */
describe('catalogue: movies, theatres, screens, showtimes', () => {
  let pool: Pool;
  let app: ReturnType<typeof createTestApp>;
  let admin: { id: string; token: string };

  const DAY = 86_400_000;

  beforeAll(() => {
    pool = createTestPool(5);
    app = createTestApp(pool);
  });
  afterAll(() => pool.end());
  beforeEach(async () => {
    await resetDatabase(pool);
    admin = await createUser(pool, 'ADMIN');
  });

  const asAdmin = (method: 'post', path: string) =>
    request(app)[method](path).set('Authorization', `Bearer ${admin.token}`);

  const movieBody = (over: object = {}) => ({
    title: 'Dune: Part Two',
    synopsis: 'Paul joins the Fremen.',
    genres: ['Sci-Fi', 'Adventure'],
    language: 'English',
    durationMinutes: 166,
    certificate: 'UA',
    rating: 8.5,
    director: 'Denis Villeneuve',
    cast: ['Timothée Chalamet', 'Zendaya'],
    releaseDate: '2024-03-01',
    ...over,
  });

  /** Two categories: CLASSIC rows A-B (4 seats each), RECLINER row C (2 seats). */
  const layout = {
    rows: [
      { label: 'A', category: 'CLASSIC', seats: 4, aisleAfter: [2] },
      { label: 'B', category: 'CLASSIC', seats: 4, aisleAfter: [2] },
      { label: 'C', category: 'RECLINER', seats: 2 },
    ],
  };

  async function createMovie(over: object = {}) {
    const res = await asAdmin('post', '/api/admin/movies').send(movieBody(over));
    expect(res.status).toBe(201);
    return res.body.movie as { id: string; slug: string };
  }

  async function createScreen(city = 'Hyderabad', theatreName = 'Aurora Multiplex') {
    const t = await asAdmin('post', '/api/admin/theatres').send({
      name: theatreName,
      city,
      address: 'Madhapur',
    });
    expect(t.status).toBe(201);
    const s = await asAdmin('post', `/api/admin/theatres/${t.body.theatre.id}/screens`).send({
      name: 'Audi 1',
      layout,
    });
    expect(s.status).toBe(201);
    return { theatreId: t.body.theatre.id as string, screenId: s.body.screen.id as string };
  }

  async function createShow(movieId: string, screenId: string, startsAt: Date) {
    const res = await asAdmin('post', '/api/admin/shows').send({
      movieId,
      screenId,
      startsAt: startsAt.toISOString(),
      prices: { CLASSIC: 18000, RECLINER: 45000 },
    });
    expect(res.status).toBe(201);
    return res.body.show as { id: string };
  }

  describe('admin create', () => {
    test('every admin route requires authentication (401) and the ADMIN role (403)', async () => {
      const user = await createUser(pool);
      for (const path of [
        '/api/admin/movies',
        '/api/admin/theatres',
        '/api/admin/theatres/00000000-0000-4000-8000-000000000000/screens',
        '/api/admin/shows',
      ]) {
        expect((await request(app).post(path).send({})).status).toBe(401);
        const res = await request(app)
          .post(path)
          .set('Authorization', `Bearer ${user.token}`)
          .send({});
        expect(res.status).toBe(403);
      }
    });

    test('movie: slug derived from the title; a duplicate slug is 409', async () => {
      const movie = await createMovie();
      expect(movie.slug).toBe('dune-part-two');
      const dup = await asAdmin('post', '/api/admin/movies').send(movieBody());
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('ALREADY_EXISTS');
      const own = await createMovie({ slug: 'dune-2' });
      expect(own.slug).toBe('dune-2');
    });

    test('theatre: the same name in the same city is 409, in another city is fine', async () => {
      await createScreen('Hyderabad');
      const dup = await asAdmin('post', '/api/admin/theatres').send({
        name: 'Aurora Multiplex',
        city: 'Hyderabad',
      });
      expect(dup.status).toBe(409);
      await createScreen('Bengaluru');
    });

    test('screen: seat count comes from the layout; bad layouts are 400; unknown theatre 404', async () => {
      const t = await asAdmin('post', '/api/admin/theatres').send({ name: 'T', city: 'C' });
      const ok = await asAdmin('post', `/api/admin/theatres/${t.body.theatre.id}/screens`).send({
        name: 'Audi 1',
        layout,
      });
      expect(ok.body.screen).toMatchObject({ seatCount: 10, categories: ['CLASSIC', 'RECLINER'] });

      const bad = (l: object) =>
        asAdmin('post', `/api/admin/theatres/${t.body.theatre.id}/screens`).send({
          name: 'X',
          layout: l,
        });
      const dupRows = await bad({ rows: [layout.rows[0], layout.rows[0]] });
      expect(dupRows.status).toBe(400);
      const aisleOutside = await bad({
        rows: [{ label: 'A', category: 'CLASSIC', seats: 4, aisleAfter: [4] }],
      });
      expect(aisleOutside.status).toBe(400);
      const lowercase = await bad({ rows: [{ label: 'A', category: 'classic', seats: 4 }] });
      expect(lowercase.status).toBe(400);

      const missing = await asAdmin(
        'post',
        '/api/admin/theatres/00000000-0000-4000-8000-000000000000/screens',
      ).send({ name: 'Audi 1', layout });
      expect(missing.status).toBe(404);
    });

    test('show: creates prices and one seat per layout seat, with categories', async () => {
      const movie = await createMovie();
      const { screenId } = await createScreen();
      const show = await createShow(movie.id, screenId, new Date(Date.now() + DAY));

      const { rows } = await pool.query(
        `SELECT seat_label, category FROM seats WHERE show_id = $1 ORDER BY id`,
        [show.id],
      );
      expect(rows.map((r) => r.seat_label)).toEqual([
        'A1',
        'A2',
        'A3',
        'A4',
        'B1',
        'B2',
        'B3',
        'B4',
        'C1',
        'C2',
      ]);
      expect(rows.filter((r) => r.category === 'RECLINER').map((r) => r.seat_label)).toEqual([
        'C1',
        'C2',
      ]);
      expect(show).toMatchObject({
        seatCount: 10,
        prices: [
          { category: 'CLASSIC', price: 18000 },
          { category: 'RECLINER', price: 45000 },
        ],
        movie: { title: 'Dune: Part Two' },
      });
      // ends_at = start + 166 min running time + 15 min cleaning
      const s = await pool.query(`SELECT ends_at - starts_at AS len FROM shows WHERE id = $1`, [
        show.id,
      ]);
      expect(s.rows[0].len).toMatchObject({ hours: 3, minutes: 1 });
    });

    test('show: prices must match the layout categories exactly; past times are rejected', async () => {
      const movie = await createMovie();
      const { screenId } = await createScreen();
      const send = (body: object) =>
        asAdmin('post', '/api/admin/shows').send({
          movieId: movie.id,
          screenId,
          startsAt: new Date(Date.now() + DAY).toISOString(),
          prices: { CLASSIC: 18000, RECLINER: 45000 },
          ...body,
        });

      const missing = await send({ prices: { CLASSIC: 18000 } });
      expect(missing.status).toBe(400);
      expect(missing.body.error.message).toMatch(/Missing prices for: RECLINER/);
      const extra = await send({ prices: { CLASSIC: 1, RECLINER: 1, GOLD: 1 } });
      expect(extra.body.error.message).toMatch(/no seats in: GOLD/);
      const fractional = await send({ prices: { CLASSIC: 199.5, RECLINER: 45000 } });
      expect(fractional.status).toBe(400);
      const past = await send({ startsAt: new Date(Date.now() - 1000).toISOString() });
      expect(past.status).toBe(400);

      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM shows`);
      expect(rows[0].n).toBe(0);
    });

    test('show: an overlapping show on the same screen is 409 SHOW_OVERLAP', async () => {
      const movie = await createMovie();
      const { screenId } = await createScreen();
      const start = new Date(Date.now() + DAY);
      await createShow(movie.id, screenId, start);

      const clash = await asAdmin('post', '/api/admin/shows').send({
        movieId: movie.id,
        screenId,
        startsAt: new Date(start.getTime() + 60 * 60_000).toISOString(),
        prices: { CLASSIC: 18000, RECLINER: 45000 },
      });
      expect(clash.status).toBe(409);
      expect(clash.body.error.code).toBe('SHOW_OVERLAP');
      // Nothing half-created: still one show, still 10 seats
      const { rows } = await pool.query(
        `SELECT (SELECT count(*)::int FROM shows) AS shows, (SELECT count(*)::int FROM seats) AS seats`,
      );
      expect(rows[0]).toEqual({ shows: 1, seats: 10 });
    });
  });

  describe('browsing', () => {
    test('GET /movies: stats, filters and facets', async () => {
      const dune = await createMovie();
      const rrr = await createMovie({
        title: 'RRR',
        genres: ['Action', 'Drama'],
        language: 'Telugu',
        rating: 7.8,
      });
      await createMovie({ title: 'No Shows Yet', genres: ['Drama'], rating: 9.9 });
      const hyd = await createScreen('Hyderabad');
      const blr = await createScreen('Bengaluru');
      await createShow(dune.id, hyd.screenId, new Date(Date.now() + DAY));
      await createShow(dune.id, blr.screenId, new Date(Date.now() + 2 * DAY));
      await createShow(rrr.id, hyd.screenId, new Date(Date.now() + 2 * DAY));

      const all = await request(app).get('/api/movies');
      expect(all.status).toBe(200);
      // Movies with shows first (best rated first), then the rest
      expect(all.body.movies.map((m: { title: string }) => m.title)).toEqual([
        'Dune: Part Two',
        'RRR',
        'No Shows Yet',
      ]);
      expect(all.body.movies[0]).toMatchObject({
        nowShowing: true,
        showCount: 2,
        minPrice: 18000,
        rating: 8.5,
        durationMinutes: 166,
      });
      expect(all.body.movies[2]).toMatchObject({ nowShowing: false, showCount: 0, minPrice: null });
      expect(all.body.facets).toEqual({
        genres: ['Action', 'Adventure', 'Drama', 'Sci-Fi'],
        languages: ['English', 'Telugu'],
      });

      const titles = async (query: string) =>
        (await request(app).get(`/api/movies?${query}`)).body.movies.map(
          (m: { title: string }) => m.title,
        );
      expect(await titles('genre=Drama')).toEqual(['RRR', 'No Shows Yet']);
      expect(await titles('language=Telugu')).toEqual(['RRR']);
      expect(await titles('q=dune')).toEqual(['Dune: Part Two']);

      const inBlr = await request(app).get('/api/movies?city=Bengaluru');
      const byTitle = Object.fromEntries(
        inBlr.body.movies.map((m: { title: string; showCount: number }) => [m.title, m.showCount]),
      );
      expect(byTitle).toEqual({ 'Dune: Part Two': 1, RRR: 0, 'No Shows Yet': 0 });
    });

    test('GET /movies/:key by slug or id; unknown and malformed keys are 404', async () => {
      const movie = await createMovie();
      const bySlug = await request(app).get('/api/movies/dune-part-two');
      expect(bySlug.body.movie).toMatchObject({
        id: movie.id,
        synopsis: 'Paul joins the Fremen.',
        cast: ['Timothée Chalamet', 'Zendaya'],
        releaseDate: '2024-03-01',
      });
      expect((await request(app).get(`/api/movies/${movie.id}`)).body.movie.slug).toBe(
        'dune-part-two',
      );
      expect((await request(app).get('/api/movies/nope')).status).toBe(404);
      expect((await request(app).get('/api/movies/Not_A_Slug!')).status).toBe(404);
    });

    test('showtimes: grouped by theatre, filtered by city, and days counted in IST', async () => {
      const movie = await createMovie();
      const a = await createScreen('Hyderabad', 'Aurora');
      const b = await createScreen('Hyderabad', 'Bay');
      const c = await createScreen('Mumbai', 'Marine');

      // A date at least two days out, so "late on day X" is safely in the future
      const day = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
      const ist = (date: string, time: string) => new Date(`${date}T${time}:00+05:30`);
      const nextDay = new Date(new Date(`${day}T00:00:00Z`).getTime() + DAY)
        .toISOString()
        .slice(0, 10);

      // 23:30 IST on `day` is 18:00 UTC on `day`; 00:30 IST on the next day is 19:00 UTC on
      // `day`. A UTC date would put both on `day`; IST puts them on different days.
      await createShow(movie.id, a.screenId, ist(day, '10:00'));
      await createShow(movie.id, a.screenId, ist(day, '23:30'));
      await createShow(movie.id, b.screenId, ist(day, '14:00'));
      await createShow(movie.id, b.screenId, ist(nextDay, '00:30'));
      await createShow(movie.id, c.screenId, ist(day, '12:00'));

      const res = await request(app).get(
        `/api/movies/dune-part-two/showtimes?city=Hyderabad&date=${day}`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ date: day, timezone: 'Asia/Kolkata' });
      expect(res.body.dates).toEqual([day, nextDay]);
      expect(
        res.body.theatres.map((t: { theatre: { name: string }; shows: unknown[] }) => [
          t.theatre.name,
          t.shows.length,
        ]),
      ).toEqual([
        ['Aurora', 2],
        ['Bay', 1],
      ]);
      expect(res.body.theatres[0].shows[0]).toMatchObject({
        screen: { name: 'Audi 1' },
        totalSeats: 10,
        availableSeats: 10,
      });

      // No date: the first day that has shows
      const first = await request(app).get('/api/movies/dune-part-two/showtimes?city=Hyderabad');
      expect(first.body.date).toBe(day);
      // No shows at all in a city
      const none = await request(app).get('/api/movies/dune-part-two/showtimes?city=Pune');
      expect(none.body).toMatchObject({ date: null, dates: [], theatres: [] });
    });

    test('GET /cities lists cities with upcoming shows', async () => {
      const movie = await createMovie();
      const hyd = await createScreen('Hyderabad');
      await createScreen('Pune'); // no shows
      await createShow(movie.id, hyd.screenId, new Date(Date.now() + DAY));
      const res = await request(app).get('/api/cities');
      expect(res.body.cities).toEqual([{ city: 'Hyderabad', theatres: 1 }]);
    });

    test('availability counts live holds as taken and expired holds as free', async () => {
      const movie = await createMovie();
      const { screenId } = await createScreen();
      const show = await createShow(movie.id, screenId, new Date(Date.now() + DAY));
      const priya = await createUser(pool);

      const hold = await request(app)
        .post('/api/holds')
        .set('Authorization', `Bearer ${priya.token}`)
        .set('Idempotency-Key', 'k-avail')
        .send({ showId: show.id, seats: ['A1', 'A2'] });
      expect(hold.status).toBe(201);
      const seatsLeft = async () =>
        (await request(app).get(`/api/shows/${show.id}`)).body.show.availableSeats;
      expect(await seatsLeft()).toBe(8);

      await pool.query(`UPDATE bookings SET expires_at = now() - interval '1 second'`);
      expect(await seatsLeft()).toBe(10);
    });
  });

  describe('category pricing and price snapshots', () => {
    test('a hold costs the sum of each seat’s category price, stored per item', async () => {
      const movie = await createMovie();
      const { screenId } = await createScreen();
      const show = await createShow(movie.id, screenId, new Date(Date.now() + DAY));
      const user = await createUser(pool);

      const res = await request(app)
        .post('/api/holds')
        .set('Authorization', `Bearer ${user.token}`)
        .set('Idempotency-Key', 'k-mixed')
        .send({ showId: show.id, seats: ['A1', 'C1', 'C2'] });
      expect(res.status).toBe(201);
      expect(res.body.totalAmount).toBe(18000 + 45000 + 45000);

      const booking = await request(app)
        .get(`/api/bookings/${res.body.bookingId}`)
        .set('Authorization', `Bearer ${user.token}`);
      expect(booking.body.booking).toMatchObject({
        totalAmount: 108000,
        items: [
          { label: 'A1', category: 'CLASSIC', price: 18000 },
          { label: 'C1', category: 'RECLINER', price: 45000 },
          { label: 'C2', category: 'RECLINER', price: 45000 },
        ],
        show: {
          movie: { title: 'Dune: Part Two', slug: 'dune-part-two' },
          theatre: { name: 'Aurora Multiplex', city: 'Hyderabad' },
          screen: { name: 'Audi 1' },
        },
      });
    });

    test('changing a price later never changes an existing booking', async () => {
      const movie = await createMovie();
      const { screenId } = await createScreen();
      const show = await createShow(movie.id, screenId, new Date(Date.now() + DAY));
      const first = await createUser(pool);
      const second = await createUser(pool);
      const hold = (u: { token: string }, seat: string) =>
        request(app)
          .post('/api/holds')
          .set('Authorization', `Bearer ${u.token}`)
          .set('Idempotency-Key', `k-${seat}`)
          .send({ showId: show.id, seats: [seat] });

      const before = await hold(first, 'C1');
      await pool.query(
        `UPDATE show_prices SET price = 60000 WHERE show_id = $1 AND category = 'RECLINER'`,
        [show.id],
      );
      const after = await hold(second, 'C2');

      expect(before.body.totalAmount).toBe(45000);
      expect(after.body.totalAmount).toBe(60000);
      const { rows } = await pool.query(
        `SELECT b.total_amount, i.price FROM bookings b JOIN booking_items i ON i.booking_id = b.id
         WHERE b.id = $1`,
        [before.body.bookingId],
      );
      expect(rows).toEqual([{ total_amount: 45000, price: 45000 }]);
    });
  });
});
