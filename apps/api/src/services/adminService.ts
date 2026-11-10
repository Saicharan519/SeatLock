import type { Pool } from 'pg';
import { layoutCategories } from '@seatlock/db';
import * as admin from '../repositories/adminRepository';
import { theatreExists } from '../repositories/catalogRepository';
import { AppError } from '../utils/errors';

/**
 * Read models for the admin dashboard: how the business is doing, everyone's bookings, and
 * the theatres and schedules an admin edits. Reads only; catalogue writes live in the
 * catalogue service, next to the public reads they must stay consistent with.
 */
export function createAdminService(pool: Pool, opts: { timezone: string }) {
  return {
    async overview() {
      const [totals, byDay, bookingsByStatus, byProvider, outbox, movies, recent] =
        await Promise.all([
          admin.overviewTotals(pool),
          admin.revenueByDay(pool, opts.timezone, 7),
          admin.countsBy(pool, 'bookings'),
          admin.revenueByProvider(pool),
          admin.countsBy(pool, 'outbox'),
          admin.topMovies(pool, 5),
          admin.listBookings(pool, { limit: 8 }),
        ]);
      return {
        timezone: opts.timezone,
        totals: {
          ...totals,
          /** Share of seats sold across all upcoming shows, 0..1 */
          upcomingOccupancy: totals.upcomingSeats
            ? totals.upcomingBooked / totals.upcomingSeats
            : 0,
        },
        revenueByDay: byDay,
        bookingsByStatus,
        revenueByProvider: byProvider,
        outbox,
        topMovies: movies,
        recentBookings: recent.map(toBooking),
      };
    },

    async bookings(f: { status?: string; q?: string; limit: number }) {
      return (await admin.listBookings(pool, f)).map(toBooking);
    },

    async theatres() {
      return (await admin.listTheatres(pool)).map((t) => ({
        ...t,
        screens: t.screens.map((s) => ({ ...s, categories: layoutCategories(s.layout) })),
      }));
    },

    async theatreShows(theatreId: string, date: string) {
      if (!(await theatreExists(pool, theatreId))) {
        throw new AppError('NOT_FOUND', 'Theatre not found');
      }
      const rows = await admin.listTheatreShows(pool, {
        theatreId,
        date,
        timezone: opts.timezone,
      });
      return rows.map((s) => ({
        id: s.id,
        startsAt: s.starts_at.toISOString(),
        endsAt: s.ends_at.toISOString(),
        screen: { id: s.screen_id, name: s.screen_name },
        movie: { id: s.movie_id, title: s.movie_title },
        prices: s.prices,
        totalSeats: s.total_seats,
        bookedSeats: s.booked_seats,
        bookings: s.bookings,
      }));
    },
  };
}

const toBooking = (b: admin.AdminBookingRow) => ({
  id: b.id,
  status: b.status,
  totalAmount: b.total_amount,
  createdAt: b.created_at.toISOString(),
  expiresAt: b.expires_at.toISOString(),
  user: { name: b.user_name, email: b.user_email },
  movieTitle: b.movie_title,
  theatre: { name: b.theatre_name, city: b.theatre_city },
  screenName: b.screen_name,
  startsAt: b.starts_at.toISOString(),
  seats: b.seats ?? [],
  payment: b.payment_status ? { status: b.payment_status, provider: b.payment_provider } : null,
});

export type AdminService = ReturnType<typeof createAdminService>;
