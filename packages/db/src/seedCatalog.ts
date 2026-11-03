import type { PoolClient } from 'pg';
import type { ScreenLayout } from './catalog';
import { insertShowWithSeats } from './catalog';

/**
 * Demo catalogue: real, well-known films (posters and backdrops from TMDB's image CDN;
 * synopses written for this project; ratings approximate), fictional theatres in four
 * cities, and showtimes rolling forward from the day the seed runs.
 */

const TMDB = 'https://image.tmdb.org/t/p';
const poster = (path: string) => `${TMDB}/w500/${path}.jpg`;
const backdrop = (path: string) => `${TMDB}/w1280/${path}.jpg`;

export interface SeedMovie {
  slug: string;
  title: string;
  synopsis: string;
  genres: string[];
  language: string;
  durationMinutes: number;
  certificate: 'U' | 'UA' | 'A';
  rating: number;
  director: string;
  cast: string[];
  posterUrl: string;
  backdropUrl: string | null;
  releaseDate: string;
}

export const SEED_MOVIES: SeedMovie[] = [
  {
    slug: 'interstellar',
    title: 'Interstellar',
    synopsis:
      'With Earth’s crops failing, a former pilot leads a small crew through a wormhole near Saturn to find humanity a new home, knowing every hour away may cost his children years.',
    genres: ['Sci-Fi', 'Adventure', 'Drama'],
    language: 'English',
    durationMinutes: 169,
    certificate: 'UA',
    rating: 8.7,
    director: 'Christopher Nolan',
    cast: ['Matthew McConaughey', 'Anne Hathaway', 'Jessica Chastain', 'Michael Caine'],
    posterUrl: poster('gEU2QniE6E77NI6lCU6MxlNBvIx'),
    backdropUrl: backdrop('xJHokMbljvjADYdit5fK5VQsXEG'),
    releaseDate: '2014-11-07',
  },
  {
    slug: 'the-dark-knight',
    title: 'The Dark Knight',
    synopsis:
      'Batman, Lieutenant Gordon and District Attorney Harvey Dent set out to dismantle Gotham’s mob, until the Joker arrives with a plan to prove anyone can be pushed into chaos.',
    genres: ['Action', 'Crime', 'Drama'],
    language: 'English',
    durationMinutes: 152,
    certificate: 'UA',
    rating: 9.0,
    director: 'Christopher Nolan',
    cast: ['Christian Bale', 'Heath Ledger', 'Aaron Eckhart', 'Gary Oldman'],
    posterUrl: poster('qJ2tW6WMUDux911r6m7haRef0WH'),
    backdropUrl: backdrop('nMKdUUepR0i5zn0y1T4CsSB5chy'),
    releaseDate: '2008-07-18',
  },
  {
    slug: 'inception',
    title: 'Inception',
    synopsis:
      'A thief who steals secrets from inside dreams is offered a way home if he can do the reverse: plant an idea in a target’s mind, three dream layers deep.',
    genres: ['Sci-Fi', 'Action', 'Thriller'],
    language: 'English',
    durationMinutes: 148,
    certificate: 'UA',
    rating: 8.8,
    director: 'Christopher Nolan',
    cast: ['Leonardo DiCaprio', 'Joseph Gordon-Levitt', 'Elliot Page', 'Tom Hardy'],
    posterUrl: poster('9gk7adHYeDvHkCSEqAvQNLV5Uge'),
    backdropUrl: backdrop('s3TBrRGB1iav7gFOCNx3H31MoES'),
    releaseDate: '2010-07-16',
  },
  {
    slug: 'oppenheimer',
    title: 'Oppenheimer',
    synopsis:
      'The story of J. Robert Oppenheimer, the physicist who led the Manhattan Project, and of the security hearing that later put his loyalty on trial.',
    genres: ['Biography', 'Drama', 'History'],
    language: 'English',
    durationMinutes: 180,
    certificate: 'UA',
    rating: 8.3,
    director: 'Christopher Nolan',
    cast: ['Cillian Murphy', 'Emily Blunt', 'Matt Damon', 'Robert Downey Jr.'],
    posterUrl: poster('8Gxv8gSFCU0XGDykEGv7zR1n2ua'),
    backdropUrl: backdrop('fm6KqXpk3M2HVveHwCrBSSBaO0V'),
    releaseDate: '2023-07-21',
  },
  {
    slug: 'dune-part-two',
    title: 'Dune: Part Two',
    synopsis:
      'Paul Atreides joins the Fremen of Arrakis to fight the empire that destroyed his family, while visions warn him of the holy war his rise could unleash.',
    genres: ['Sci-Fi', 'Adventure'],
    language: 'English',
    durationMinutes: 166,
    certificate: 'UA',
    rating: 8.5,
    director: 'Denis Villeneuve',
    cast: ['Timothée Chalamet', 'Zendaya', 'Rebecca Ferguson', 'Javier Bardem'],
    posterUrl: poster('1pdfLvkbY9ohJlCjQH2CZjjYVvJ'),
    backdropUrl: backdrop('xOMo8BRK7PfcJv9JCnx7s5hj0PX'),
    releaseDate: '2024-03-01',
  },
  {
    slug: 'spider-man-across-the-spider-verse',
    title: 'Spider-Man: Across the Spider-Verse',
    synopsis:
      'Miles Morales is pulled across the multiverse, where a society of Spider-People insists that some tragedies are fixed points he isn’t allowed to change.',
    genres: ['Animation', 'Action', 'Adventure'],
    language: 'English',
    durationMinutes: 140,
    certificate: 'U',
    rating: 8.6,
    director: 'Joaquim Dos Santos, Kemp Powers, Justin K. Thompson',
    cast: ['Shameik Moore', 'Hailee Steinfeld', 'Oscar Isaac', 'Jake Johnson'],
    posterUrl: poster('8Vt6mWEReuy4Of61Lnj5Xj704m8'),
    backdropUrl: backdrop('4HodYYKEIsGOdinkGi2Ucz6X9i0'),
    releaseDate: '2023-06-02',
  },
  {
    slug: 'avatar-the-way-of-water',
    title: 'Avatar: The Way of Water',
    synopsis:
      'Years after settling on Pandora, Jake Sully’s family flees to the ocean clans when an old enemy returns, and must learn the ways of the reef to survive.',
    genres: ['Sci-Fi', 'Adventure'],
    language: 'English',
    durationMinutes: 192,
    certificate: 'UA',
    rating: 7.6,
    director: 'James Cameron',
    cast: ['Sam Worthington', 'Zoe Saldaña', 'Sigourney Weaver', 'Kate Winslet'],
    posterUrl: poster('t6HIqrRAclMCA60NsSmeqe9RmNV'),
    backdropUrl: backdrop('s16H6tpK2utvwDtzZ8Qy4qm5Emw'),
    releaseDate: '2022-12-16',
  },
  {
    slug: 'rrr',
    title: 'RRR',
    synopsis:
      'In 1920s India, a tribal guardian on a rescue mission and a police officer serving the Raj become close friends without knowing they stand on opposite sides.',
    genres: ['Action', 'Drama'],
    language: 'Telugu',
    durationMinutes: 187,
    certificate: 'UA',
    rating: 7.8,
    director: 'S. S. Rajamouli',
    cast: ['N. T. Rama Rao Jr.', 'Ram Charan', 'Alia Bhatt', 'Ajay Devgn'],
    posterUrl: poster('nEufeZlyAOLqO2brrs0yeF1lgXO'),
    backdropUrl: null,
    releaseDate: '2022-03-25',
  },
  {
    slug: 'baahubali-2-the-conclusion',
    title: 'Baahubali 2: The Conclusion',
    synopsis:
      'The answer to why Kattappa killed Amarendra Baahubali unfolds alongside his son’s fight to reclaim the kingdom of Mahishmati from a tyrant.',
    genres: ['Action', 'Drama', 'Fantasy'],
    language: 'Telugu',
    durationMinutes: 167,
    certificate: 'UA',
    rating: 8.2,
    director: 'S. S. Rajamouli',
    cast: ['Prabhas', 'Rana Daggubati', 'Anushka Shetty', 'Ramya Krishnan'],
    posterUrl: poster('21sC2assImQIYCEDA84Qh9d1RsK'),
    backdropUrl: null,
    releaseDate: '2017-04-28',
  },
  {
    slug: 'kgf-chapter-2',
    title: 'K.G.F: Chapter 2',
    synopsis:
      'Rocky now rules the Kolar Gold Fields, but rival warlords, a ruthless enemy and the Indian government all close in on his empire.',
    genres: ['Action', 'Crime', 'Drama'],
    language: 'Kannada',
    durationMinutes: 168,
    certificate: 'UA',
    rating: 8.2,
    director: 'Prashanth Neel',
    cast: ['Yash', 'Sanjay Dutt', 'Raveena Tandon', 'Srinidhi Shetty'],
    posterUrl: poster('khNVygolU0TxLIDWff5tQlAhZ23'),
    backdropUrl: null,
    releaseDate: '2022-04-14',
  },
  {
    slug: 'jawan',
    title: 'Jawan',
    synopsis:
      'A man with a team of women hijacks a Mumbai metro train to force the state to answer for corruption, while a past tied to the army slowly catches up with him.',
    genres: ['Action', 'Thriller'],
    language: 'Hindi',
    durationMinutes: 169,
    certificate: 'UA',
    rating: 7.0,
    director: 'Atlee',
    cast: ['Shah Rukh Khan', 'Nayanthara', 'Vijay Sethupathi', 'Deepika Padukone'],
    posterUrl: poster('jFt1gS4BGHlK8xt76Y81Alp4dbt'),
    backdropUrl: null,
    releaseDate: '2023-09-07',
  },
  {
    slug: '3-idiots',
    title: '3 Idiots',
    synopsis:
      'Two friends search for the college roommate who vanished after graduation, remembering how he questioned an engineering college that valued marks over learning.',
    genres: ['Comedy', 'Drama'],
    language: 'Hindi',
    durationMinutes: 170,
    certificate: 'UA',
    rating: 8.4,
    director: 'Rajkumar Hirani',
    cast: ['Aamir Khan', 'R. Madhavan', 'Sharman Joshi', 'Kareena Kapoor'],
    posterUrl: poster('66A9MqXOyVFCssoloscw79z8Tew'),
    backdropUrl: null,
    releaseDate: '2009-12-25',
  },
  {
    slug: 'dangal',
    title: 'Dangal',
    synopsis:
      'A former wrestler from a Haryana village trains his daughters, against the expectations of everyone around them, to compete for India at the highest level.',
    genres: ['Biography', 'Drama', 'Sport'],
    language: 'Hindi',
    durationMinutes: 161,
    certificate: 'U',
    rating: 8.3,
    director: 'Nitesh Tiwari',
    cast: ['Aamir Khan', 'Fatima Sana Shaikh', 'Sanya Malhotra', 'Sakshi Tanwar'],
    posterUrl: poster('p2lVAcPuRPSO8Al6hDDGw0OgMi8'),
    backdropUrl: null,
    releaseDate: '2016-12-23',
  },
  {
    slug: 'kalki-2898-ad',
    title: 'Kalki 2898 AD',
    synopsis:
      'In a ruined future ruled from a towering city, a bounty hunter crosses paths with a woman whose unborn child could fulfil an ancient prophecy.',
    genres: ['Sci-Fi', 'Action'],
    language: 'Telugu',
    durationMinutes: 181,
    certificate: 'UA',
    rating: 7.1,
    director: 'Nag Ashwin',
    cast: ['Prabhas', 'Amitabh Bachchan', 'Kamal Haasan', 'Deepika Padukone'],
    posterUrl: poster('rstcAnBeCkxNQjNp3YXrF6IP1tW'),
    backdropUrl: null,
    releaseDate: '2024-06-27',
  },
];

/** Rows skip I, as many cinemas do (it reads like 1). */
const rows = (
  spec: [labels: string, category: string, seats: number, aisleAfter: number[]][],
): ScreenLayout => ({
  rows: spec.flatMap(([labels, category, seats, aisleAfter]) =>
    labels.split('').map((label) => ({ label, category, seats, aisleAfter })),
  ),
});

/** 134 seats: Classic at the front, Prime in the middle, a recliner row at the back. */
const STANDARD_SCREEN = rows([
  ['ABC', 'CLASSIC', 14, [3, 11]],
  ['DEFGHJ', 'PRIME', 14, [3, 11]],
  ['K', 'RECLINER', 8, [4]],
]);

/** 182 seats: a large format screen. */
const IMAX_SCREEN = rows([
  ['ABCD', 'CLASSIC', 18, [4, 14]],
  ['EFGHJ', 'PRIME', 18, [4, 14]],
  ['KL', 'RECLINER', 10, [5]],
]);

/** 76 seats: a small screen. */
const COMPACT_SCREEN = rows([
  ['ABC', 'CLASSIC', 10, [5]],
  ['DEFG', 'PRIME', 10, [5]],
  ['H', 'RECLINER', 6, [3]],
]);

type Prices = Record<'CLASSIC' | 'PRIME' | 'RECLINER', number>;

interface SeedScreen {
  name: string;
  layout: ScreenLayout;
  /** Rupees; stored as paise */
  prices: Prices;
}

interface SeedTheatre {
  name: string;
  city: string;
  address: string;
  screens: SeedScreen[];
}

const standard = (name: string, prices: Prices): SeedScreen => ({
  name,
  layout: STANDARD_SCREEN,
  prices,
});

export const SEED_THEATRES: SeedTheatre[] = [
  {
    name: 'Aurora Multiplex',
    city: 'Hyderabad',
    address: 'Hitech City Road, Madhapur',
    screens: [
      standard('Audi 1', { CLASSIC: 180, PRIME: 250, RECLINER: 450 }),
      { name: 'IMAX', layout: IMAX_SCREEN, prices: { CLASSIC: 280, PRIME: 380, RECLINER: 650 } },
    ],
  },
  {
    name: 'Galaxy Talkies',
    city: 'Hyderabad',
    address: 'Mythrivanam Road, Ameerpet',
    screens: [
      standard('Screen 1', { CLASSIC: 150, PRIME: 200, RECLINER: 380 }),
      {
        name: 'Screen 2',
        layout: COMPACT_SCREEN,
        prices: { CLASSIC: 150, PRIME: 200, RECLINER: 380 },
      },
    ],
  },
  {
    name: 'Skyline Cinemas',
    city: 'Hyderabad',
    address: 'Financial District, Gachibowli',
    screens: [standard('Audi 1', { CLASSIC: 200, PRIME: 270, RECLINER: 500 })],
  },
  {
    name: 'Aurora Multiplex',
    city: 'Bengaluru',
    address: '80 Feet Road, Koramangala',
    screens: [
      standard('Audi 1', { CLASSIC: 200, PRIME: 280, RECLINER: 520 }),
      { name: 'IMAX', layout: IMAX_SCREEN, prices: { CLASSIC: 300, PRIME: 420, RECLINER: 700 } },
    ],
  },
  {
    name: 'Lakeview Cinemas',
    city: 'Bengaluru',
    address: 'ITPL Main Road, Whitefield',
    screens: [standard('Screen 1', { CLASSIC: 180, PRIME: 240, RECLINER: 450 })],
  },
  {
    name: 'Marine Screens',
    city: 'Mumbai',
    address: 'Link Road, Andheri West',
    screens: [
      standard('Screen 1', { CLASSIC: 220, PRIME: 300, RECLINER: 550 }),
      {
        name: 'Screen 2',
        layout: COMPACT_SCREEN,
        prices: { CLASSIC: 220, PRIME: 300, RECLINER: 550 },
      },
    ],
  },
  {
    name: 'Bay Cinemas',
    city: 'Chennai',
    address: 'Velachery Main Road, Velachery',
    screens: [standard('Screen 1', { CLASSIC: 160, PRIME: 210, RECLINER: 400 })],
  },
];

/** Show slots in IST. Gaps of 3h45m fit the longest film (192 min) plus 15 min cleaning. */
const SLOTS = ['09:30', '13:15', '17:00', '20:45'];
/** Evening shows cost a little more */
const EVENING_SURCHARGE_RUPEES = 30;
const IST = '+05:30';

/** YYYY-MM-DD of `date` in India Standard Time (no DST, so a fixed offset is exact). */
export function istDate(date: Date): string {
  return new Date(date.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface SeedResult {
  movies: number;
  theatres: number;
  screens: number;
  showsCreated: number;
  showsSkipped: number;
}

/**
 * Upserts the demo catalogue and tops up showtimes for `days` days from today (IST).
 * Idempotent: re-running adds only missing future slots, so a demo started next month
 * still has a week of shows. Slots less than 15 minutes away are skipped, and a slot that
 * clashes with a show an admin created is skipped too (savepoint per show).
 */
export async function seedCatalog(
  client: PoolClient,
  opts: { now?: Date; days?: number } = {},
): Promise<SeedResult> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 7;
  const result: SeedResult = {
    movies: 0,
    theatres: 0,
    screens: 0,
    showsCreated: 0,
    showsSkipped: 0,
  };

  const movieIds: string[] = [];
  for (const m of SEED_MOVIES) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO movies (slug, title, synopsis, genres, language, duration_minutes, certificate,
                           rating, director, cast_members, poster_url, backdrop_url, release_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (slug) DO UPDATE SET
         title = EXCLUDED.title, synopsis = EXCLUDED.synopsis, genres = EXCLUDED.genres,
         language = EXCLUDED.language, certificate = EXCLUDED.certificate,
         rating = EXCLUDED.rating, director = EXCLUDED.director,
         cast_members = EXCLUDED.cast_members, poster_url = EXCLUDED.poster_url,
         backdrop_url = EXCLUDED.backdrop_url, release_date = EXCLUDED.release_date
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
    movieIds.push(rows[0]!.id);
    result.movies += 1;
  }

  const screens: { id: string; index: number; prices: Prices }[] = [];
  for (const t of SEED_THEATRES) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO theatres (name, city, address) VALUES ($1, $2, $3)
       ON CONFLICT (name, city) DO UPDATE SET address = EXCLUDED.address
       RETURNING id`,
      [t.name, t.city, t.address],
    );
    const theatreId = rows[0]!.id;
    result.theatres += 1;
    for (const s of t.screens) {
      const seatCount = s.layout.rows.reduce((n, r) => n + r.seats, 0);
      // Layouts are not overwritten: existing shows' seats were generated from them
      const { rows: sc } = await client.query<{ id: string }>(
        `INSERT INTO screens (theatre_id, name, layout, seat_count) VALUES ($1, $2, $3, $4)
         ON CONFLICT (theatre_id, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [theatreId, s.name, JSON.stringify(s.layout), seatCount],
      );
      screens.push({ id: sc[0]!.id, index: screens.length, prices: s.prices });
      result.screens += 1;
    }
  }

  const today = istDate(now);
  const earliest = now.getTime() + 15 * 60_000;
  for (let d = 0; d < days; d++) {
    const day = addDays(today, d);
    for (const screen of screens) {
      for (let slot = 0; slot < SLOTS.length; slot++) {
        const startsAt = new Date(`${day}T${SLOTS[slot]}:00${IST}`);
        if (startsAt.getTime() < earliest) continue;

        const { rowCount } = await client.query(
          `SELECT 1 FROM shows WHERE screen_id = $1 AND starts_at = $2`,
          [screen.id, startsAt],
        );
        if (rowCount) {
          result.showsSkipped += 1;
          continue;
        }

        // A deterministic spread: each screen and day gets a different mix of films
        const movieId = movieIds[(screen.index * 3 + d * 5 + slot * 7) % movieIds.length]!;
        const evening = slot >= 2 ? EVENING_SURCHARGE_RUPEES : 0;
        const prices = Object.fromEntries(
          Object.entries(screen.prices).map(([c, rupees]) => [c, (rupees + evening) * 100]),
        );

        await client.query('SAVEPOINT seed_show');
        try {
          await insertShowWithSeats(client, { movieId, screenId: screen.id, startsAt, prices });
          await client.query('RELEASE SAVEPOINT seed_show');
          result.showsCreated += 1;
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT seed_show');
          // 23P01: overlaps a show someone else scheduled on this screen
          if ((err as { code?: string }).code !== '23P01') throw err;
          result.showsSkipped += 1;
        }
      }
    }
  }
  return result;
}
