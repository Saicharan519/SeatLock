import type { PoolClient } from 'pg';

/**
 * One row of a screen. Seats are numbered 1..seats. aisleAfter lists seat numbers followed
 * by an aisle, for display only.
 */
export interface LayoutRow {
  label: string;
  category: string;
  seats: number;
  aisleAfter: number[];
}

export interface ScreenLayout {
  rows: LayoutRow[];
}

/** One seat a layout produces. */
export interface LayoutSeat {
  label: string;
  row: string;
  number: number;
  category: string;
}

/**
 * The seats a layout produces, in row order then seat number. Order matters: seat ids
 * ascend in this order, and every multi-seat lock takes them in id order (R2).
 */
export function layoutSeats(layout: ScreenLayout): LayoutSeat[] {
  return layout.rows.flatMap((row) =>
    Array.from({ length: row.seats }, (_, i) => ({
      label: `${row.label}${i + 1}`,
      row: row.label,
      number: i + 1,
      category: row.category,
    })),
  );
}

export const layoutCategories = (layout: ScreenLayout): string[] => [
  ...new Set(layout.rows.map((r) => r.category)),
];

/**
 * The v1 layout: rows A-E of 10 seats, one STANDARD category. Tests, the race demo and
 * the load tests use it so "50 seats" keeps its meaning (T1: 1,000 users, 50 seats).
 */
export const STANDARD_LAYOUT: ScreenLayout = {
  rows: ['A', 'B', 'C', 'D', 'E'].map((label) => ({
    label,
    category: 'STANDARD',
    seats: 10,
    aisleAfter: [],
  })),
};

/** A1..A10, B1..B10, ... E10: the standard layout's labels in id order. */
export function seatLabels(): string[] {
  return layoutSeats(STANDARD_LAYOUT).map((s) => s.label);
}

/**
 * The order to fire T1-style requests in, so that same-seat requests really overlap.
 * User i still wants seat i mod 50 (PRD T1), but the users who share a seat are fired
 * together: i = 0, 50, 100, ... (all want A1), then 1, 51, 101, ... (A2), and so on.
 *
 * Firing in plain order i spaces same-seat users 50 apart, while a pool of 20 connections
 * runs at most 20 at a time, so two requests for one seat would never actually overlap.
 */
export function contendedOrder(users: number, seats = seatLabels().length): number[] {
  const order: number[] = [];
  for (let seat = 0; seat < seats; seat++) {
    for (let i = seat; i < users; i += seats) order.push(i);
  }
  return order;
}

/**
 * Creates a show with its prices and seats, in the caller's transaction, so a show never
 * exists without them. ends_at = start + running time + cleaning gap. Throws the
 * Postgres exclusion error (23P01, shows_no_overlap_per_screen) if the screen is busy.
 * Prices must cover every category in the screen's layout.
 */
export async function insertShowWithSeats(
  client: PoolClient,
  input: {
    movieId: string;
    screenId: string;
    startsAt: Date;
    prices: Record<string, number>;
    cleaningMinutes?: number;
  },
): Promise<{ id: string; starts_at: Date; ends_at: Date; seatCount: number }> {
  const { rows } = await client.query<{ id: string; starts_at: Date; ends_at: Date }>(
    `INSERT INTO shows (movie_id, screen_id, starts_at, ends_at)
     SELECT $1, $2, $3::timestamptz,
            $3::timestamptz + make_interval(mins => m.duration_minutes + $4)
     FROM movies m WHERE m.id = $1
     RETURNING id, starts_at, ends_at`,
    [input.movieId, input.screenId, input.startsAt, input.cleaningMinutes ?? 15],
  );
  const show = rows[0];
  if (!show) throw new Error(`Movie ${input.movieId} not found`);
  const seatCount = await insertPricesAndSeats(client, show.id, input.screenId, input.prices);
  return { ...show, seatCount };
}

/** Writes show_prices, then one seat row per layout seat (the seats reference the prices). */
export async function insertPricesAndSeats(
  client: PoolClient,
  showId: string,
  screenId: string,
  prices: Record<string, number>,
): Promise<number> {
  const { rows } = await client.query<{ layout: ScreenLayout }>(
    `SELECT layout FROM screens WHERE id = $1`,
    [screenId],
  );
  if (!rows[0]) throw new Error(`Screen ${screenId} not found`);
  const seats = layoutSeats(rows[0].layout);

  const categories = Object.keys(prices);
  await client.query(
    `INSERT INTO show_prices (show_id, category, price)
     SELECT $1, c, p FROM unnest($2::text[], $3::int[]) AS t(c, p)`,
    [showId, categories, categories.map((c) => prices[c])],
  );
  const result = await client.query(
    `INSERT INTO seats (show_id, seat_label, category)
     SELECT $1, label, category
     FROM unnest($2::text[], $3::text[]) WITH ORDINALITY AS t(label, category, ord)
     ORDER BY ord`,
    [showId, seats.map((s) => s.label), seats.map((s) => s.category)],
  );
  return result.rowCount ?? 0;
}

let fixtureCounter = 0;

/**
 * A complete show on the standard 50-seat layout, creating its own movie, theatre and
 * screen. For tests, the race demo and load-test setup. One STANDARD category at `price`.
 */
export async function createStandardShow(
  client: PoolClient,
  opts: { startsAt?: Date; price?: number; title?: string; durationMinutes?: number } = {},
): Promise<string> {
  fixtureCounter += 1;
  const tag = `${Date.now().toString(36)}-${process.pid}-${fixtureCounter}`;
  const { rows: movie } = await client.query<{ id: string }>(
    `INSERT INTO movies (slug, title, language, duration_minutes, certificate, release_date)
     VALUES ($1, $2, 'English', $3, 'UA', current_date) RETURNING id`,
    [`fixture-${tag}`, opts.title ?? 'Test Show', opts.durationMinutes ?? 120],
  );
  const { rows: theatre } = await client.query<{ id: string }>(
    `INSERT INTO theatres (name, city) VALUES ($1, 'Testville') RETURNING id`,
    [`Test Hall ${tag}`],
  );
  const { rows: screen } = await client.query<{ id: string }>(
    `INSERT INTO screens (theatre_id, name, layout, seat_count) VALUES ($1, 'Screen 1', $2, 50)
     RETURNING id`,
    [theatre[0]!.id, JSON.stringify(STANDARD_LAYOUT)],
  );
  const show = await insertShowWithSeats(client, {
    movieId: movie[0]!.id,
    screenId: screen[0]!.id,
    startsAt: opts.startsAt ?? new Date(Date.now() + 86_400_000),
    prices: { STANDARD: opts.price ?? 20000 },
  });
  return show.id;
}
