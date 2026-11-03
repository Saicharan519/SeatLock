import type { PoolClient } from 'pg';
import type { Queryable, ScreenLayout } from '@seatlock/db';

export interface MovieRow {
  id: string;
  slug: string;
  title: string;
  synopsis: string;
  genres: string[];
  language: string;
  duration_minutes: number;
  certificate: 'U' | 'UA' | 'A';
  /** numeric comes back from pg as a string */
  rating: string | null;
  director: string;
  cast_members: string[];
  poster_url: string | null;
  backdrop_url: string | null;
  release_date: string;
  created_at: Date;
}

export interface MovieListRow extends MovieRow {
  next_show_at: Date | null;
  show_count: number;
  min_price: number | null;
}

/** release_date as YYYY-MM-DD text, so no timezone shifts it */
const MOVIE_COLUMNS = `m.id, m.slug, m.title, m.synopsis, m.genres, m.language, m.duration_minutes,
  m.certificate, m.rating, m.director, m.cast_members, m.poster_url, m.backdrop_url,
  to_char(m.release_date, 'YYYY-MM-DD') AS release_date, m.created_at`;

/**
 * Movies matching the filters, each with its upcoming-show stats (optionally within one
 * city). Movies with upcoming shows come first, best rated first.
 */
export async function listMovies(
  db: Queryable,
  f: { city?: string; genre?: string; language?: string; q?: string },
): Promise<MovieListRow[]> {
  const { rows } = await db.query<MovieListRow>(
    `SELECT ${MOVIE_COLUMNS}, st.next_show_at, st.show_count, st.min_price
     FROM movies m
     CROSS JOIN LATERAL (
       SELECT min(sh.starts_at) AS next_show_at,
              count(DISTINCT sh.id)::int AS show_count,
              min(p.price)::int AS min_price
       FROM shows sh
       JOIN show_prices p ON p.show_id = sh.id
       JOIN screens sc ON sc.id = sh.screen_id
       JOIN theatres t ON t.id = sc.theatre_id
       WHERE sh.movie_id = m.id AND sh.starts_at > now()
         AND ($1::text IS NULL OR t.city = $1)
     ) st
     WHERE ($2::text IS NULL OR m.genres @> ARRAY[$2::text])
       AND ($3::text IS NULL OR m.language = $3)
       AND ($4::text IS NULL OR position(lower($4) IN lower(m.title)) > 0)
     ORDER BY (st.next_show_at IS NULL), m.rating DESC NULLS LAST, m.title`,
    [f.city ?? null, f.genre ?? null, f.language ?? null, f.q ?? null],
  );
  return rows;
}

export async function movieFacets(
  db: Queryable,
): Promise<{ genres: string[]; languages: string[] }> {
  const { rows } = await db.query<{ genres: string[] | null; languages: string[] | null }>(
    `SELECT (SELECT array_agg(DISTINCT g ORDER BY g) FROM movies, unnest(genres) AS g) AS genres,
            (SELECT array_agg(DISTINCT language ORDER BY language) FROM movies) AS languages`,
  );
  return { genres: rows[0]?.genres ?? [], languages: rows[0]?.languages ?? [] };
}

/** By slug, or by id when the key is a UUID. */
export async function findMovie(db: Queryable, key: string): Promise<MovieRow | undefined> {
  const byId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
  const { rows } = await db.query<MovieRow>(
    `SELECT ${MOVIE_COLUMNS} FROM movies m WHERE ${byId ? 'm.id = $1::uuid' : 'm.slug = $1'}`,
    [key],
  );
  return rows[0];
}

export async function listCities(db: Queryable): Promise<{ city: string; theatres: number }[]> {
  const { rows } = await db.query<{ city: string; theatres: number }>(
    `SELECT t.city, count(DISTINCT t.id)::int AS theatres
     FROM theatres t
     WHERE EXISTS (SELECT 1 FROM screens sc JOIN shows sh ON sh.screen_id = sc.id
                   WHERE sc.theatre_id = t.id AND sh.starts_at > now())
     GROUP BY t.city ORDER BY t.city`,
  );
  return rows;
}

export interface ShowRow {
  id: string;
  starts_at: Date;
  ends_at: Date;
  movie_id: string;
  screen_id: string;
  screen_name: string;
  theatre_id: string;
  theatre_name: string;
  theatre_city: string;
  theatre_address: string;
  prices: { category: string; price: number }[];
  total_seats: number;
  available_seats: number;
}

/**
 * Show columns plus availability by the seat-map read rule: a seat counts as available if
 * it is AVAILABLE, or HELD under a booking whose hold has expired (R5: database clock).
 */
const SHOW_SELECT = `
  SELECT sh.id, sh.starts_at, sh.ends_at, sh.movie_id, sh.screen_id,
         sc.name AS screen_name, t.id AS theatre_id, t.name AS theatre_name,
         t.city AS theatre_city, t.address AS theatre_address,
         (SELECT coalesce(json_agg(json_build_object('category', p.category, 'price', p.price)
                                   ORDER BY p.price, p.category), '[]')
          FROM show_prices p WHERE p.show_id = sh.id) AS prices,
         sc.seat_count AS total_seats,
         (SELECT count(*)::int FROM seats s LEFT JOIN bookings b ON b.id = s.booking_id
          WHERE s.show_id = sh.id
            AND (s.status = 'AVAILABLE'
                 OR (s.status = 'HELD' AND (b.status <> 'PENDING' OR b.expires_at <= now())))
         ) AS available_seats
  FROM shows sh
  JOIN screens sc ON sc.id = sh.screen_id
  JOIN theatres t ON t.id = sc.theatre_id`;

export async function findShow(db: Queryable, id: string): Promise<ShowRow | undefined> {
  const { rows } = await db.query<ShowRow>(`${SHOW_SELECT} WHERE sh.id = $1`, [id]);
  return rows[0];
}

/**
 * Upcoming shows, soonest first. `date` is a calendar day (YYYY-MM-DD) in the app's
 * timezone, so "today in Hyderabad" doesn't depend on the server's timezone.
 */
export async function listUpcomingShows(
  db: Queryable,
  f: { movieId?: string; city?: string; date?: string; timezone: string; limit: number },
): Promise<ShowRow[]> {
  const { rows } = await db.query<ShowRow>(
    `${SHOW_SELECT}
     WHERE sh.starts_at > now()
       AND ($1::uuid IS NULL OR sh.movie_id = $1)
       AND ($2::text IS NULL OR t.city = $2)
       AND ($3::date IS NULL OR (sh.starts_at AT TIME ZONE $4)::date = $3)
     ORDER BY sh.starts_at, t.name, sc.name, sh.id
     LIMIT $5`,
    [f.movieId ?? null, f.city ?? null, f.date ?? null, f.timezone, f.limit],
  );
  return rows;
}

/** Calendar days (app timezone) that have upcoming shows of this movie, optionally in a city. */
export async function showDates(
  db: Queryable,
  f: { movieId: string; city?: string; timezone: string },
): Promise<string[]> {
  const { rows } = await db.query<{ day: string }>(
    `SELECT DISTINCT to_char((sh.starts_at AT TIME ZONE $3)::date, 'YYYY-MM-DD') AS day
     FROM shows sh
     JOIN screens sc ON sc.id = sh.screen_id
     JOIN theatres t ON t.id = sc.theatre_id
     WHERE sh.movie_id = $1 AND sh.starts_at > now() AND ($2::text IS NULL OR t.city = $2)
     ORDER BY day`,
    [f.movieId, f.city ?? null, f.timezone],
  );
  return rows.map((r) => r.day);
}

export type SeatDisplayStatus = 'AVAILABLE' | 'HELD' | 'BOOKED';

/**
 * Seat-map read rule (PRD section 10): a seat is shown HELD only if its booking is
 * PENDING and not yet expired. A stale hold the worker hasn't swept yet shows AVAILABLE.
 * Uses the database clock (R5).
 */
export async function getSeatMap(
  db: Queryable,
  showId: string,
): Promise<{ label: string; status: SeatDisplayStatus; category: string }[]> {
  const { rows } = await db.query<{ label: string; status: SeatDisplayStatus; category: string }>(
    `SELECT s.seat_label AS label,
            CASE
              WHEN s.status = 'BOOKED' THEN 'BOOKED'
              WHEN s.status = 'HELD' AND b.status = 'PENDING' AND b.expires_at > now() THEN 'HELD'
              ELSE 'AVAILABLE'
            END AS status,
            s.category
     FROM seats s
     LEFT JOIN bookings b ON b.id = s.booking_id
     WHERE s.show_id = $1
     ORDER BY s.id`,
    [showId],
  );
  return rows;
}

export async function screenLayoutOfShow(
  db: Queryable,
  showId: string,
): Promise<ScreenLayout | undefined> {
  const { rows } = await db.query<{ layout: ScreenLayout }>(
    `SELECT sc.layout FROM shows sh JOIN screens sc ON sc.id = sh.screen_id WHERE sh.id = $1`,
    [showId],
  );
  return rows[0]?.layout;
}

// ---- Admin writes ----

export async function insertMovie(
  client: Queryable,
  m: {
    slug: string;
    title: string;
    synopsis: string;
    genres: string[];
    language: string;
    durationMinutes: number;
    certificate: string;
    rating: number | null;
    director: string;
    cast: string[];
    posterUrl: string | null;
    backdropUrl: string | null;
    releaseDate: string;
  },
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO movies (slug, title, synopsis, genres, language, duration_minutes, certificate,
                         rating, director, cast_members, poster_url, backdrop_url, release_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      m.slug,
      m.title,
      m.synopsis,
      m.genres,
      m.language,
      m.durationMinutes,
      m.certificate,
      m.rating,
      m.director,
      m.cast,
      m.posterUrl,
      m.backdropUrl,
      m.releaseDate,
    ],
  );
  return rows[0]!.id;
}

export async function insertTheatre(
  client: Queryable,
  t: { name: string; city: string; address: string },
): Promise<{ id: string; name: string; city: string; address: string }> {
  const { rows } = await client.query<{ id: string; name: string; city: string; address: string }>(
    `INSERT INTO theatres (name, city, address) VALUES ($1, $2, $3)
     RETURNING id, name, city, address`,
    [t.name, t.city, t.address],
  );
  return rows[0]!;
}

export async function theatreExists(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query(`SELECT 1 FROM theatres WHERE id = $1`, [id]);
  return rowCount === 1;
}

export async function insertScreen(
  client: Queryable,
  s: { theatreId: string; name: string; layout: ScreenLayout; seatCount: number },
): Promise<{ id: string; name: string; seat_count: number }> {
  const { rows } = await client.query<{ id: string; name: string; seat_count: number }>(
    `INSERT INTO screens (theatre_id, name, layout, seat_count) VALUES ($1, $2, $3, $4)
     RETURNING id, name, seat_count`,
    [s.theatreId, s.name, JSON.stringify(s.layout), s.seatCount],
  );
  return rows[0]!;
}

export async function findScreen(
  db: Queryable | PoolClient,
  id: string,
): Promise<{ id: string; layout: ScreenLayout } | undefined> {
  const { rows } = await db.query<{ id: string; layout: ScreenLayout }>(
    `SELECT id, layout FROM screens WHERE id = $1`,
    [id],
  );
  return rows[0];
}
