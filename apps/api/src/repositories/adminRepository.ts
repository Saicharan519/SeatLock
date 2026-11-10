import type { Queryable, ScreenLayout } from '@seatlock/db';

/** pg returns bigint and numeric as strings; every count here fits a JS number. */
const n = (v: string | number | null | undefined) => Number(v ?? 0);

export interface OverviewTotals {
  confirmedBookings: number;
  revenue: number;
  ticketsSold: number;
  activeHolds: number;
  refundsPending: number;
  customers: number;
  upcomingShows: number;
  upcomingSeats: number;
  upcomingBooked: number;
}

/** Headline numbers for the dashboard. Revenue counts CONFIRMED bookings only. */
export async function overviewTotals(db: Queryable): Promise<OverviewTotals> {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*) FROM bookings WHERE status = 'CONFIRMED') AS confirmed_bookings,
       (SELECT coalesce(sum(total_amount), 0) FROM bookings WHERE status = 'CONFIRMED') AS revenue,
       (SELECT count(*) FROM booking_items bi JOIN bookings b ON b.id = bi.booking_id
         WHERE b.status = 'CONFIRMED') AS tickets_sold,
       (SELECT count(*) FROM bookings WHERE status = 'PENDING' AND expires_at > now()) AS active_holds,
       (SELECT count(*) FROM payments WHERE status = 'REFUND_REQUIRED') AS refunds_pending,
       (SELECT count(*) FROM users WHERE role = 'USER') AS customers,
       up.shows AS upcoming_shows, up.seats AS upcoming_seats,
       -- booking_id IS NOT NULL lets the partial index seats_booking find the few sold seats
       (SELECT count(*) FROM seats s JOIN shows sh ON sh.id = s.show_id
         WHERE s.booking_id IS NOT NULL AND s.status = 'BOOKED' AND sh.starts_at > now())
         AS upcoming_booked
     FROM (SELECT count(*) AS shows, coalesce(sum(sc.seat_count), 0) AS seats
           FROM shows sh JOIN screens sc ON sc.id = sh.screen_id
           WHERE sh.starts_at > now()) up`,
  );
  const r = rows[0];
  return {
    confirmedBookings: n(r.confirmed_bookings),
    revenue: n(r.revenue),
    ticketsSold: n(r.tickets_sold),
    activeHolds: n(r.active_holds),
    refundsPending: n(r.refunds_pending),
    customers: n(r.customers),
    upcomingShows: n(r.upcoming_shows),
    upcomingSeats: n(r.upcoming_seats),
    upcomingBooked: n(r.upcoming_booked),
  };
}

/** Confirmed bookings and revenue per calendar day (app timezone), oldest first, gaps as 0. */
export async function revenueByDay(
  db: Queryable,
  timezone: string,
  days: number,
): Promise<{ day: string; bookings: number; revenue: number }[]> {
  const { rows } = await db.query(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, count(b.id) AS bookings,
            coalesce(sum(b.total_amount), 0) AS revenue
     FROM generate_series((now() AT TIME ZONE $1)::date - ($2::int - 1), (now() AT TIME ZONE $1)::date,
                          interval '1 day') AS d(day)
     LEFT JOIN bookings b
       ON b.status = 'CONFIRMED' AND (b.created_at AT TIME ZONE $1)::date = d.day::date
     GROUP BY d.day ORDER BY d.day`,
    [timezone, days],
  );
  return rows.map((r) => ({ day: r.day, bookings: n(r.bookings), revenue: n(r.revenue) }));
}

export async function countsBy(
  db: Queryable,
  what: 'bookings' | 'outbox',
): Promise<Record<string, number>> {
  const table = what === 'bookings' ? 'bookings' : 'outbox_events';
  const { rows } = await db.query<{ status: string; count: string }>(
    `SELECT status, count(*) FROM ${table} GROUP BY status`,
  );
  return Object.fromEntries(rows.map((r) => [r.status, n(r.count)]));
}

/** Confirmed bookings and revenue per payment gateway. */
export async function revenueByProvider(
  db: Queryable,
): Promise<{ provider: string; bookings: number; revenue: number }[]> {
  const { rows } = await db.query(
    `SELECT p.provider, count(*) AS bookings, coalesce(sum(b.total_amount), 0) AS revenue
     FROM bookings b JOIN payments p ON p.booking_id = b.id
     WHERE b.status = 'CONFIRMED'
     GROUP BY p.provider ORDER BY p.provider`,
  );
  return rows.map((r) => ({
    provider: r.provider,
    bookings: n(r.bookings),
    revenue: n(r.revenue),
  }));
}

export async function topMovies(
  db: Queryable,
  limit: number,
): Promise<{ id: string; slug: string; title: string; tickets: number; revenue: number }[]> {
  const { rows } = await db.query(
    `SELECT m.id, m.slug, m.title, count(bi.id) AS tickets, coalesce(sum(bi.price), 0) AS revenue
     FROM bookings b
     JOIN booking_items bi ON bi.booking_id = b.id
     JOIN shows sh ON sh.id = b.show_id
     JOIN movies m ON m.id = sh.movie_id
     WHERE b.status = 'CONFIRMED'
     GROUP BY m.id ORDER BY count(bi.id) DESC, m.title LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    tickets: n(r.tickets),
    revenue: n(r.revenue),
  }));
}

export interface AdminBookingRow {
  id: string;
  status: string;
  total_amount: number;
  created_at: Date;
  expires_at: Date;
  user_name: string;
  user_email: string;
  movie_title: string;
  theatre_name: string;
  theatre_city: string;
  screen_name: string;
  starts_at: Date;
  seats: string[] | null;
  payment_status: string | null;
  payment_provider: string | null;
}

/**
 * Everyone's bookings, newest first. `q` matches part of the customer's email, or the start
 * of the booking id (the reference printed on tickets is its first 8 characters).
 */
export async function listBookings(
  db: Queryable,
  f: { status?: string; q?: string; limit: number },
): Promise<AdminBookingRow[]> {
  const { rows } = await db.query<AdminBookingRow>(
    `SELECT b.id, b.status, b.total_amount, b.created_at, b.expires_at,
            u.name AS user_name, u.email AS user_email,
            m.title AS movie_title, t.name AS theatre_name, t.city AS theatre_city,
            sc.name AS screen_name, sh.starts_at,
            (SELECT array_agg(s.seat_label ORDER BY s.id)
             FROM booking_items bi JOIN seats s ON s.id = bi.seat_id
             WHERE bi.booking_id = b.id) AS seats,
            p.status AS payment_status, p.provider AS payment_provider
     FROM bookings b
     JOIN users u ON u.id = b.user_id
     JOIN shows sh ON sh.id = b.show_id
     JOIN movies m ON m.id = sh.movie_id
     JOIN screens sc ON sc.id = sh.screen_id
     JOIN theatres t ON t.id = sc.theatre_id
     LEFT JOIN payments p ON p.booking_id = b.id
     WHERE ($1::text IS NULL OR b.status = $1)
       AND ($2::text IS NULL
            OR position(lower($2) IN lower(u.email)) > 0
            OR left(b.id::text, length($2)) = lower($2))
     ORDER BY b.created_at DESC, b.id
     LIMIT $3`,
    [f.status ?? null, f.q ?? null, f.limit],
  );
  return rows;
}

export interface AdminTheatreRow {
  id: string;
  name: string;
  city: string;
  address: string;
  screens: {
    id: string;
    name: string;
    seatCount: number;
    layout: ScreenLayout;
    upcomingShows: number;
  }[];
}

export async function listTheatres(db: Queryable): Promise<AdminTheatreRow[]> {
  const { rows } = await db.query<AdminTheatreRow>(
    `SELECT t.id, t.name, t.city, t.address,
            coalesce((
              SELECT json_agg(json_build_object(
                       'id', sc.id, 'name', sc.name, 'seatCount', sc.seat_count, 'layout', sc.layout,
                       'upcomingShows', (SELECT count(*) FROM shows sh
                                         WHERE sh.screen_id = sc.id AND sh.starts_at > now()))
                     ORDER BY sc.name)
              FROM screens sc WHERE sc.theatre_id = t.id), '[]') AS screens
     FROM theatres t
     ORDER BY t.city, t.name`,
  );
  return rows;
}

export interface AdminShowRow {
  id: string;
  starts_at: Date;
  ends_at: Date;
  screen_id: string;
  screen_name: string;
  movie_id: string;
  movie_title: string;
  prices: { category: string; price: number }[];
  total_seats: number;
  booked_seats: number;
  bookings: number;
}

/** One theatre's schedule for one calendar day (app timezone), past shows included. */
export async function listTheatreShows(
  db: Queryable,
  f: { theatreId: string; date: string; timezone: string },
): Promise<AdminShowRow[]> {
  const { rows } = await db.query<AdminShowRow>(
    `SELECT sh.id, sh.starts_at, sh.ends_at, sh.screen_id, sc.name AS screen_name,
            m.id AS movie_id, m.title AS movie_title,
            (SELECT coalesce(json_agg(json_build_object('category', p.category, 'price', p.price)
                                      ORDER BY p.price, p.category), '[]')
             FROM show_prices p WHERE p.show_id = sh.id) AS prices,
            sc.seat_count AS total_seats,
            (SELECT count(*)::int FROM seats s
             WHERE s.show_id = sh.id AND s.status = 'BOOKED') AS booked_seats,
            (SELECT count(*)::int FROM bookings b WHERE b.show_id = sh.id) AS bookings
     FROM shows sh
     JOIN screens sc ON sc.id = sh.screen_id
     JOIN movies m ON m.id = sh.movie_id
     WHERE sc.theatre_id = $1 AND (sh.starts_at AT TIME ZONE $3)::date = $2::date
     ORDER BY sc.name, sh.starts_at`,
    [f.theatreId, f.date, f.timezone],
  );
  return rows;
}
