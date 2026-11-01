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
  title: string;
  venue: string;
  starts_at: Date;
  payment_id: string | null;
  payment_status: string | null;
  seats: string[];
}

const BOOKING_VIEW_SQL = `
  SELECT b.id, b.status, b.total_amount, b.expires_at, b.created_at,
         s.id AS show_id, s.title, s.venue, s.starts_at,
         p.id AS payment_id, p.status AS payment_status,
         COALESCE(
           (SELECT array_agg(st.seat_label ORDER BY st.id)
            FROM booking_items i JOIN seats st ON st.id = i.seat_id
            WHERE i.booking_id = b.id),
           '{}') AS seats
  FROM bookings b
  JOIN shows s ON s.id = b.show_id
  LEFT JOIN payments p ON p.booking_id = b.id`;

const toView = (r: BookingViewRow) => ({
  id: r.id,
  status: r.status,
  totalAmount: r.total_amount,
  expiresAt: r.expires_at.toISOString(),
  createdAt: r.created_at.toISOString(),
  seats: r.seats,
  show: { id: r.show_id, title: r.title, venue: r.venue, startsAt: r.starts_at.toISOString() },
  payment: r.payment_id ? { id: r.payment_id, status: r.payment_status } : null,
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
