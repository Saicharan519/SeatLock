import type { Pool } from 'pg';
import { insertShowWithSeats, layoutCategories, layoutSeats, withTransaction } from '@seatlock/db';
import type { ScreenLayout } from '@seatlock/db';
import * as catalog from '../repositories/catalogRepository';
import { AppError } from '../utils/errors';
import { slugify } from '../validators/catalog';

const toMovieSummary = (m: catalog.MovieRow) => ({
  id: m.id,
  slug: m.slug,
  title: m.title,
  genres: m.genres,
  language: m.language,
  durationMinutes: m.duration_minutes,
  certificate: m.certificate,
  rating: m.rating === null ? null : Number(m.rating),
  posterUrl: m.poster_url,
  backdropUrl: m.backdrop_url,
  releaseDate: m.release_date,
});

const toMovieDetail = (m: catalog.MovieRow) => ({
  ...toMovieSummary(m),
  synopsis: m.synopsis,
  director: m.director,
  cast: m.cast_members,
});

const toShow = (s: catalog.ShowRow) => ({
  id: s.id,
  startsAt: s.starts_at.toISOString(),
  endsAt: s.ends_at.toISOString(),
  movieId: s.movie_id,
  theatre: {
    id: s.theatre_id,
    name: s.theatre_name,
    city: s.theatre_city,
    address: s.theatre_address,
  },
  screen: { id: s.screen_id, name: s.screen_name },
  prices: s.prices,
  totalSeats: s.total_seats,
  availableSeats: s.available_seats,
});

export type PublicShow = ReturnType<typeof toShow>;

const pgCode = (err: unknown) => (err as { code?: string }).code;
const pgConstraint = (err: unknown) => (err as { constraint?: string }).constraint;

export function createCatalogService(pool: Pool, opts: { timezone: string }) {
  async function movieOrThrow(key: string) {
    const movie = await catalog.findMovie(pool, key);
    if (!movie) throw new AppError('NOT_FOUND', 'Movie not found');
    return movie;
  }

  async function withMovies(shows: catalog.ShowRow[]) {
    const ids = [...new Set(shows.map((s) => s.movie_id))];
    const movies = await Promise.all(ids.map((id) => catalog.findMovie(pool, id)));
    const byId = new Map(movies.filter((m) => m).map((m) => [m!.id, toMovieSummary(m!)]));
    return shows.map((s) => ({ ...toShow(s), movie: byId.get(s.movie_id)! }));
  }

  return {
    /** Movies with their upcoming-show stats, plus the genre and language filter values. */
    async listMovies(f: { city?: string; genre?: string; language?: string; q?: string }) {
      const [rows, facets] = await Promise.all([
        catalog.listMovies(pool, f),
        catalog.movieFacets(pool),
      ]);
      const movies = rows.map((m) => ({
        ...toMovieSummary(m),
        nowShowing: m.next_show_at !== null,
        nextShowAt: m.next_show_at?.toISOString() ?? null,
        showCount: m.show_count,
        minPrice: m.min_price,
      }));
      return { movies, facets };
    },

    async getMovie(key: string) {
      return toMovieDetail(await movieOrThrow(key));
    },

    /**
     * Showtimes of a movie for one calendar day, grouped by theatre. Without a date, the
     * first day that has shows. `dates` lists every day with shows, for a date picker.
     */
    async showtimes(key: string, f: { city?: string; date?: string }) {
      const movie = await movieOrThrow(key);
      const dates = await catalog.showDates(pool, {
        movieId: movie.id,
        city: f.city,
        timezone: opts.timezone,
      });
      const date = f.date ?? dates[0] ?? null;
      const shows = date
        ? await catalog.listUpcomingShows(pool, {
            movieId: movie.id,
            city: f.city,
            date,
            timezone: opts.timezone,
            limit: 500,
          })
        : [];

      const theatres = new Map<string, { theatre: PublicShow['theatre']; shows: unknown[] }>();
      for (const s of shows.map(toShow)) {
        const entry = theatres.get(s.theatre.id) ?? { theatre: s.theatre, shows: [] };
        entry.shows.push({
          id: s.id,
          startsAt: s.startsAt,
          endsAt: s.endsAt,
          screen: s.screen,
          prices: s.prices,
          totalSeats: s.totalSeats,
          availableSeats: s.availableSeats,
        });
        theatres.set(s.theatre.id, entry);
      }
      return {
        movie: toMovieSummary(movie),
        timezone: opts.timezone,
        date,
        dates,
        theatres: [...theatres.values()].sort((a, b) =>
          a.theatre.name.localeCompare(b.theatre.name),
        ),
      };
    },

    async listCities() {
      return catalog.listCities(pool);
    },

    async listShows(f: { movieId?: string; city?: string; date?: string; limit: number }) {
      return withMovies(await catalog.listUpcomingShows(pool, { ...f, timezone: opts.timezone }));
    },

    async getShow(id: string) {
      const show = await catalog.findShow(pool, id);
      if (!show) throw new AppError('NOT_FOUND', 'Show not found');
      return (await withMovies([show]))[0]!;
    },

    /** The layout (for drawing rows and aisles), the prices, and every seat's live status. */
    async seatMap(showId: string) {
      const [show, layout, seats] = await Promise.all([
        catalog.findShow(pool, showId),
        catalog.screenLayoutOfShow(pool, showId),
        catalog.getSeatMap(pool, showId),
      ]);
      if (!show || !layout) throw new AppError('NOT_FOUND', 'Show not found');
      return { showId, layout, prices: show.prices, seats };
    },

    // ---- Admin ----

    async createMovie(input: {
      slug?: string;
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
    }) {
      const slug = input.slug ?? slugify(input.title);
      try {
        const id = await catalog.insertMovie(pool, { ...input, slug });
        return this.getMovie(id);
      } catch (err) {
        if (pgConstraint(err) === 'movies_slug_unique') {
          throw new AppError('ALREADY_EXISTS', `A movie with slug "${slug}" already exists`);
        }
        throw err;
      }
    },

    async createTheatre(input: { name: string; city: string; address: string }) {
      try {
        return await catalog.insertTheatre(pool, input);
      } catch (err) {
        if (pgConstraint(err) === 'theatres_name_city') {
          throw new AppError('ALREADY_EXISTS', `${input.name} already exists in ${input.city}`);
        }
        throw err;
      }
    },

    async createScreen(theatreId: string, input: { name: string; layout: ScreenLayout }) {
      if (!(await catalog.theatreExists(pool, theatreId))) {
        throw new AppError('NOT_FOUND', 'Theatre not found');
      }
      const seatCount = layoutSeats(input.layout).length;
      try {
        const screen = await catalog.insertScreen(pool, { theatreId, ...input, seatCount });
        return {
          id: screen.id,
          theatreId,
          name: screen.name,
          seatCount: screen.seat_count,
          categories: layoutCategories(input.layout),
          layout: input.layout,
        };
      } catch (err) {
        if (pgConstraint(err) === 'screens_theatre_name') {
          throw new AppError('ALREADY_EXISTS', `This theatre already has a screen "${input.name}"`);
        }
        throw err;
      }
    },

    /**
     * Creates a showtime with its prices and seats in one transaction. Prices must cover
     * exactly the categories in the screen's layout. The database refuses a show that
     * overlaps another on the same screen (exclusion constraint), reported as 409.
     */
    async createShow(input: {
      movieId: string;
      screenId: string;
      startsAt: Date;
      prices: Record<string, number>;
    }) {
      if (input.startsAt.getTime() <= Date.now()) {
        throw new AppError('VALIDATION_ERROR', 'startsAt must be in the future');
      }
      if (!(await catalog.findMovie(pool, input.movieId))) {
        throw new AppError('NOT_FOUND', 'Movie not found');
      }
      const screen = await catalog.findScreen(pool, input.screenId);
      if (!screen) throw new AppError('NOT_FOUND', 'Screen not found');

      const needed = layoutCategories(screen.layout);
      const given = Object.keys(input.prices);
      const missing = needed.filter((c) => !given.includes(c));
      const extra = given.filter((c) => !needed.includes(c));
      if (missing.length || extra.length) {
        throw new AppError(
          'VALIDATION_ERROR',
          [
            missing.length ? `Missing prices for: ${missing.join(', ')}` : '',
            extra.length ? `This screen has no seats in: ${extra.join(', ')}` : '',
          ]
            .filter(Boolean)
            .join('. '),
        );
      }

      try {
        const created = await withTransaction(pool, (client) => insertShowWithSeats(client, input));
        return { ...(await this.getShow(created.id)), seatCount: created.seatCount };
      } catch (err) {
        if (pgCode(err) === '23P01') {
          throw new AppError('SHOW_OVERLAP', 'Another show is running on this screen at that time');
        }
        throw err;
      }
    },
  };
}

export type CatalogService = ReturnType<typeof createCatalogService>;
