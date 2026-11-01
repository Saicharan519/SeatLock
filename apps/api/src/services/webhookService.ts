import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { lockSeatsInIdOrder, releaseHeldSeatsOfBookings, withTransaction } from '@seatlock/db';
import { verifyWebhook, type Logger } from '@seatlock/shared';
import * as bookings from '../repositories/bookingRepository';
import { insertOutboxEvent } from '../repositories/outboxRepository';
import * as payments from '../repositories/paymentRepository';
import { AppError } from '../utils/errors';

const eventSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.enum(['payment.succeeded', 'payment.failed', 'refund.succeeded']),
  data: z.object({
    paymentId: z.uuid(),
    chargeId: z.string().min(1).max(200),
    amount: z.number().int().positive(),
    refundId: z.string().min(1).max(200).optional(),
  }),
  createdAt: z.string(),
});
type GatewayEvent = z.infer<typeof eventSchema>;

/** What handling an event did. Returned to the caller and logged. */
export type WebhookResult =
  'duplicate' | 'ignored' | 'confirmed' | 'refund_required' | 'payment_failed' | 'refunded';

export function createWebhookService(pool: Pool, webhookSecret: string, logger: Logger) {
  /** PRD 9.3: payment success, booking still live. Lock, verify, then update. */
  async function confirmInTime(
    client: PoolClient,
    booking: bookings.LockedBooking,
    payment: payments.PaymentRow,
    event: GatewayEvent,
  ): Promise<boolean> {
    const seats = await bookings.itemSeatsOfBooking(client, booking.id);
    const seatIds = seats.map((s) => s.id);
    await lockSeatsInIdOrder(client, seatIds);
    // With the seats locked nothing can change them, so checking first and updating second
    // is all-or-nothing by construction. No savepoint needed.
    if ((await bookings.countSeatsHeldBy(client, seatIds, booking.id)) !== seatIds.length) {
      return false;
    }
    await bookings.markSeatsBooked(client, seatIds, booking.id);
    await bookings.setItemsConfirmed(client, booking.id, true);
    await bookings.transitionBooking(client, booking.id, 'PENDING', 'CONFIRMED');
    await payments.transitionPayment(client, payment.id, 'INITIATED', 'SUCCESS', {
      providerReference: event.data.chargeId,
    });
    await insertOutboxEvent(client, {
      aggregateType: 'booking',
      aggregateId: booking.id,
      eventType: 'BookingConfirmed',
      payload: {
        bookingId: booking.id,
        userId: booking.user_id,
        showId: booking.show_id,
        seats: seats.map((s) => s.seat_label),
        totalAmount: booking.total_amount,
      },
    });
    return true;
  }

  /** The customer was charged but can't have the booking: record that a refund is owed. */
  async function requireRefund(
    client: PoolClient,
    payment: payments.PaymentRow,
    from: payments.PaymentStatus,
    event: GatewayEvent,
    reason: string,
  ): Promise<WebhookResult> {
    await payments.transitionPayment(client, payment.id, from, 'REFUND_REQUIRED', {
      providerReference: event.data.chargeId,
    });
    await insertOutboxEvent(client, {
      aggregateType: 'payment',
      aggregateId: payment.id,
      eventType: 'RefundRequired',
      payload: {
        paymentId: payment.id,
        bookingId: payment.booking_id,
        amount: payment.amount,
        reason,
      },
    });
    return 'refund_required';
  }

  async function onPaymentSucceeded(
    client: PoolClient,
    booking: bookings.LockedBooking,
    payment: payments.PaymentRow,
    event: GatewayEvent,
  ): Promise<WebhookResult> {
    switch (payment.status) {
      case 'SUCCESS':
      case 'REFUND_REQUIRED':
      case 'REFUNDED':
        return 'ignored'; // Already handled
      case 'FAILED':
        // Swept or failed earlier, yet the customer WAS charged: never ignore this
        return requireRefund(client, payment, 'FAILED', event, 'payment_previously_failed');
      case 'INITIATED':
        break;
    }

    if (booking.status === 'PENDING' && booking.live) {
      if (await confirmInTime(client, booking, payment, event)) return 'confirmed';
      // Seats no longer all ours: fall through to the late path
    }

    if (booking.status === 'PENDING' || booking.status === 'EXPIRED') {
      // Late payment. Phase 4 takes the always-safe route: refund, never confirm.
      // Phase 5 upgrades this to "re-claim all seats atomically, else refund" (PRD 9.3).
      if (booking.status === 'PENDING') {
        await bookings.transitionBooking(client, booking.id, 'PENDING', 'EXPIRED');
        await releaseHeldSeatsOfBookings(client, [booking.id]);
      }
      return requireRefund(client, payment, 'INITIATED', event, 'late_payment');
    }

    // FAILED or CANCELLED booking: no re-claim, the money goes back
    return requireRefund(
      client,
      payment,
      'INITIATED',
      event,
      `booking_${booking.status.toLowerCase()}`,
    );
  }

  async function onPaymentFailed(
    client: PoolClient,
    booking: bookings.LockedBooking,
    payment: payments.PaymentRow,
  ): Promise<WebhookResult> {
    if (payment.status !== 'INITIATED') return 'ignored';
    await payments.transitionPayment(client, payment.id, 'INITIATED', 'FAILED');
    if (booking.status === 'PENDING') {
      await bookings.transitionBooking(client, booking.id, 'PENDING', 'FAILED');
      // Guarded by booking_id: seats already taken over by another hold are untouched
      await releaseHeldSeatsOfBookings(client, [booking.id]);
    }
    return 'payment_failed';
  }

  async function onRefundSucceeded(
    client: PoolClient,
    payment: payments.PaymentRow,
    event: GatewayEvent,
  ): Promise<WebhookResult> {
    if (payment.status !== 'REFUND_REQUIRED') return 'ignored';
    await payments.transitionPayment(client, payment.id, 'REFUND_REQUIRED', 'REFUNDED', {
      refundReference: event.data.refundId,
    });
    return 'refunded';
  }

  return {
    async handle(rawBody: Buffer, signature: string | undefined): Promise<WebhookResult> {
      // 1. Authenticate before parsing anything
      if (!verifyWebhook(webhookSecret, rawBody, signature)) {
        throw new AppError('INVALID_SIGNATURE', 'Invalid webhook signature');
      }
      let event: GatewayEvent;
      try {
        event = eventSchema.parse(JSON.parse(rawBody.toString('utf8')));
      } catch {
        throw new AppError('VALIDATION_ERROR', 'Malformed webhook payload');
      }

      const result = await withTransaction(pool, async (client) => {
        // 2. Dedupe. Same transaction as the effects, so a crash rolls both back and the
        //    gateway's redelivery is processed normally.
        const fresh = await client.query(
          `INSERT INTO webhook_events (provider_event_id, event_type, payload)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [event.id, event.type, rawBody.toString('utf8')],
        );
        if (fresh.rowCount === 0) return 'duplicate' as const;

        // 3. Lock booking, then payment (R3)
        const bookingId = await payments.findBookingIdOfPayment(client, event.data.paymentId);
        if (!bookingId) return 'ignored' as const;
        const booking = (await bookings.lockBooking(client, bookingId))!;
        const payment = (await payments.lockPayment(client, event.data.paymentId))!;
        if (event.data.amount !== payment.amount) {
          logger.error(
            {
              eventId: event.id,
              paymentId: payment.id,
              expected: payment.amount,
              got: event.data.amount,
            },
            'webhook amount mismatch, ignoring',
          );
          return 'ignored' as const;
        }

        switch (event.type) {
          case 'payment.succeeded':
            return onPaymentSucceeded(client, booking, payment, event);
          case 'payment.failed':
            return onPaymentFailed(client, booking, payment);
          case 'refund.succeeded':
            return onRefundSucceeded(client, payment, event);
        }
      });

      logger.info(
        { eventId: event.id, type: event.type, paymentId: event.data.paymentId, result },
        'webhook handled',
      );
      return result;
    },
  };
}

export type WebhookService = ReturnType<typeof createWebhookService>;
