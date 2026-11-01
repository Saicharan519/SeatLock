import type { Pool } from 'pg';
import { releaseHeldSeatsOfBookings, withTransaction } from '@seatlock/db';
import type { Logger } from '@seatlock/shared';
import type { ApiConfig } from '../config/env';
import * as bookings from '../repositories/bookingRepository';
import {
  beginIdempotent,
  completeIdempotent,
  type StoredResponse,
} from '../repositories/idempotencyRepository';
import * as payments from '../repositories/paymentRepository';
import { AppError } from '../utils/errors';
import { hashRequest } from '../utils/idempotency';
import type { GatewayClient } from '@seatlock/shared';

const PAY_ENDPOINT = 'POST /api/bookings/:id/pay';

export function createPaymentService(
  pool: Pool,
  config: ApiConfig,
  gateway: GatewayClient,
  logger: Logger,
) {
  const callbackUrl = new URL('/api/webhooks/payment', config.API_PUBLIC_URL).toString();

  return {
    /** PRD 9.2. Returns 202 once the payment is recorded; the webhook decides the outcome. */
    async pay(
      userId: string,
      idempotencyKey: string,
      bookingId: string,
    ): Promise<StoredResponse & { replayed: boolean }> {
      const requestHash = hashRequest('POST', `/api/bookings/${bookingId}/pay`, {});

      // Step 1: record the payment. One transaction, no external calls (R7).
      const started = await withTransaction(pool, async (client) => {
        const idem = await beginIdempotent(client, {
          userId,
          key: idempotencyKey,
          endpoint: PAY_ENDPOINT,
          requestHash,
        });
        if (idem.kind === 'replay') return { kind: 'replay' as const, response: idem.response };

        const booking = await bookings.lockBookingOfUser(client, bookingId, userId);
        if (!booking) throw new AppError('NOT_FOUND', 'Booking not found');
        if (booking.status !== 'PENDING' || !booking.live) {
          throw new AppError('BOOKING_NOT_PAYABLE', 'This booking is no longer payable');
        }
        // One payment per booking (payments_booking_unique); a failed payment fails the booking
        if (await bookings.lockPaymentOfBooking(client, bookingId)) {
          throw new AppError('PAYMENT_IN_PROGRESS', 'A payment for this booking already exists');
        }

        const payment = await payments.insertInitiatedPayment(
          client,
          bookingId,
          booking.total_amount,
        );
        const response: StoredResponse = {
          status: 202,
          body: { paymentId: payment.id, status: 'INITIATED' },
        };
        await completeIdempotent(client, idem.keyId, response);
        return { kind: 'new' as const, payment, response, keyId: idem.keyId };
      });

      // A replay never calls the gateway again
      if (started.kind === 'replay') return { ...started.response, replayed: true };
      const { payment, response, keyId } = started;

      // Step 2: call the gateway AFTER commit. It dedupes by payment id, so a retry is safe.
      const outcome = await gateway.charge({
        paymentId: payment.id,
        amount: payment.amount,
        callbackUrl,
      });

      // Step 3: interpret the outcome
      if (outcome.kind === 'rejected') {
        // Definite rejection: no money moved, so fail the booking and free the seats
        const failure: StoredResponse = {
          status: 502,
          body: {
            error: {
              code: 'PAYMENT_GATEWAY_ERROR',
              message: `Payment was declined (${outcome.reason})`,
            },
          },
        };
        await withTransaction(pool, async (client) => {
          await bookings.lockBooking(client, bookingId); // R3: booking -> payment -> seats
          if (await payments.transitionPayment(client, payment.id, 'INITIATED', 'FAILED')) {
            if (await bookings.transitionBooking(client, bookingId, 'PENDING', 'FAILED')) {
              await releaseHeldSeatsOfBookings(client, [bookingId]);
            }
          }
          await completeIdempotent(client, keyId, failure);
        });
        logger.info(
          { paymentId: payment.id, bookingId, reason: outcome.reason },
          'charge rejected',
        );
        return { ...failure, replayed: false };
      }

      if (outcome.kind === 'ambiguous') {
        // The charge may have gone through. Change NOTHING: the webhook decides, and the
        // stuck-payment sweep fails the payment if no webhook ever arrives.
        logger.warn(
          { paymentId: payment.id, bookingId, reason: outcome.reason },
          'charge outcome unknown, waiting for webhook',
        );
      }
      return { ...response, replayed: false };
    },
  };
}

export type PaymentService = ReturnType<typeof createPaymentService>;
