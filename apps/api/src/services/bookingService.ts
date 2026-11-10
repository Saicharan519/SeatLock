import type { Pool } from 'pg';
import { lockSeatsInIdOrder, withTransaction } from '@seatlock/db';
import * as bookings from '../repositories/bookingRepository';
import { insertOutboxEvent } from '../repositories/outboxRepository';
import * as payments from '../repositories/paymentRepository';
import { AppError } from '../utils/errors';

interface BookingViewRow {
  id: string;
  status: string;
  total_amount: number;
  expires_at: Date;
  created_at: Date;
  show_id: string;
  starts_at: Date;
  movie_id: string;
  movie_slug: string;
  movie_title: string;
  poster_url: string | null;
  certificate: string;
  language: string;
  duration_minutes: number;
  theatre_name: string;
  theatre_city: string;
  theatre_address: string;
  screen_name: string;
  payment_id: string | null;
  payment_status: string | null;
  payment_provider: string | null;
  items: { label: string; category: string; price: number }[];
}

const BOOKING_VIEW_SQL = `
  SELECT b.id, b.status, b.total_amount, b.expires_at, b.created_at,
         sh.id AS show_id, sh.starts_at,
         m.id AS movie_id, m.slug AS movie_slug, m.title AS movie_title, m.poster_url,
         m.certificate, m.language, m.duration_minutes,
         t.name AS theatre_name, t.city AS theatre_city, t.address AS theatre_address,
         sc.name AS screen_name,
         p.id AS payment_id, p.status AS payment_status, p.provider AS payment_provider,
         COALESCE(
           (SELECT json_agg(json_build_object('label', st.seat_label,
                                              'category', st.category,
                                              'price', i.price) ORDER BY st.id)
            FROM booking_items i JOIN seats st ON st.id = i.seat_id
            WHERE i.booking_id = b.id),
           '[]') AS items
  FROM bookings b
  JOIN shows sh ON sh.id = b.show_id
  JOIN movies m ON m.id = sh.movie_id
  JOIN screens sc ON sc.id = sh.screen_id
  JOIN theatres t ON t.id = sc.theatre_id
  LEFT JOIN payments p ON p.booking_id = b.id`;

/** items carry the price paid per seat (the snapshot), not the show's current price. */
const toView = (r: BookingViewRow) => ({
  id: r.id,
  status: r.status,
  totalAmount: r.total_amount,
  expiresAt: r.expires_at.toISOString(),
  createdAt: r.created_at.toISOString(),
  seats: r.items.map((i) => i.label),
  items: r.items,
  show: {
    id: r.show_id,
    startsAt: r.starts_at.toISOString(),
    movie: {
      id: r.movie_id,
      slug: r.movie_slug,
      title: r.movie_title,
      posterUrl: r.poster_url,
      certificate: r.certificate,
      language: r.language,
      durationMinutes: r.duration_minutes,
    },
    theatre: { name: r.theatre_name, city: r.theatre_city, address: r.theatre_address },
    screen: { name: r.screen_name },
  },
  payment: r.payment_id
    ? { id: r.payment_id, status: r.payment_status, provider: r.payment_provider }
    : null,
});

export function createBookingService(pool: Pool) {
  return {
    async listMine(userId: string) {
      const { rows } = await pool.query<BookingViewRow>(
        `${BOOKING_VIEW_SQL} WHERE b.user_id = $1 ORDER BY b.created_at DESC, b.id LIMIT 100`,
        [userId],
      );
      return rows.map(toView);
    },

    /** Owner only. Another user's booking is indistinguishable from a missing one. */
    async get(userId: string, bookingId: string) {
      const { rows } = await pool.query<BookingViewRow>(
        `${BOOKING_VIEW_SQL} WHERE b.id = $1 AND b.user_id = $2`,
        [bookingId, userId],
      );
      if (!rows[0]) throw new AppError('NOT_FOUND', 'Booking not found');
      return toView(rows[0]);
    },

    /**
     * PRD 9.6: whole-booking cancellation before the show. One transaction, lock order
     * booking -> payment -> seats (R3). Seats are freed, the confirmed flag cleared, and a
     * RefundRequired event written alongside. Naturally idempotent: cancelling again
     * returns the current state.
     */
    async cancel(userId: string, bookingId: string) {
      return withTransaction(pool, async (client) => {
        const booking = await bookings.lockBookingOfUser(client, bookingId, userId);
        if (!booking) throw new AppError('NOT_FOUND', 'Booking not found');

        const payment = await bookings.lockPaymentOfBooking(client, bookingId);
        const refund = payment ? { paymentId: payment.id } : null;
        if (booking.status === 'CANCELLED') {
          return { bookingId, status: 'CANCELLED' as const, refund };
        }
        if (booking.status !== 'CONFIRMED') {
          throw new AppError('INVALID_STATE', `Cannot cancel a ${booking.status} booking`);
        }
        const show = await bookings.findShowForHold(client, booking.show_id);
        if (!show?.upcoming) {
          throw new AppError('INVALID_STATE', 'The show has already started');
        }

        const seatIds = (await bookings.itemSeatsOfBooking(client, bookingId)).map((s) => s.id);
        await lockSeatsInIdOrder(client, seatIds);

        await bookings.transitionBooking(client, bookingId, 'CONFIRMED', 'CANCELLED');
        await bookings.releaseBookedSeats(client, seatIds, bookingId);
        await bookings.setItemsConfirmed(client, bookingId, false);
        // A CONFIRMED booking always has a SUCCESS payment; the guard makes that explicit
        if (
          payment &&
          (await payments.transitionPayment(client, payment.id, 'SUCCESS', 'REFUND_REQUIRED'))
        ) {
          await insertOutboxEvent(client, {
            aggregateType: 'payment',
            aggregateId: payment.id,
            eventType: 'RefundRequired',
            payload: {
              paymentId: payment.id,
              bookingId,
              amount: booking.total_amount,
              reason: 'booking_cancelled',
            },
          });
        }
        return { bookingId, status: 'CANCELLED' as const, refund };
      });
    },
  };
}

export type BookingService = ReturnType<typeof createBookingService>;
