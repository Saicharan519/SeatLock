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
import type { CashfreeService } from './cashfreeService';

const PAY_ENDPOINT = 'POST /api/bookings/:id/pay';

export function createPaymentService(
  pool: Pool,
  config: ApiConfig,
  gateway: GatewayClient,
  logger: Logger,
  /** Present only when Cashfree keys are configured */
  cashfree: CashfreeService | null = null,
) {
  const callbackUrl = new URL('/api/webhooks/payment', config.API_PUBLIC_URL).toString();

  /**
   * The gateway definitively refused: no money moved, so fail the payment and the booking
   * and free the seats. The stored response becomes the error, so a retry with the same key
   * sees the same outcome.
   */
  async function failDefinitely(
    paymentId: string,
    bookingId: string,
    keyId: string,
    reason: string,
  ): Promise<StoredResponse> {
    const failure: StoredResponse = {
      status: 502,
      body: {
        error: { code: 'PAYMENT_GATEWAY_ERROR', message: `Payment was declined (${reason})` },
      },
    };
    await withTransaction(pool, async (client) => {
      await bookings.lockBooking(client, bookingId); // R3: booking -> payment -> seats
      if (await payments.transitionPayment(client, paymentId, 'INITIATED', 'FAILED')) {
        if (await bookings.transitionBooking(client, bookingId, 'PENDING', 'FAILED')) {
          await releaseHeldSeatsOfBookings(client, [bookingId]);
        }
      }
      await completeIdempotent(client, keyId, failure);
    });
    logger.info({ paymentId, bookingId, reason }, 'charge rejected');
    return failure;
  }

  return {
    providers(): payments.PaymentProvider[] {
      return cashfree ? ['MOCK', 'CASHFREE'] : ['MOCK'];
    },

    /**
     * PRD 9.2. Returns 202 once the payment is recorded; the gateway's webhook decides the
     * outcome. With Cashfree, the 202 also carries the checkout session the browser opens.
     */
    async pay(
      userId: string,
      idempotencyKey: string,
      bookingId: string,
      provider: payments.PaymentProvider = 'MOCK',
    ): Promise<StoredResponse & { replayed: boolean }> {
      if (provider === 'CASHFREE' && !cashfree) {
        throw new AppError('VALIDATION_ERROR', 'Cashfree payments are not enabled');
      }
      // The provider is part of the request: the same key can't be reused for another one
      const requestHash = hashRequest(
        'POST',
        `/api/bookings/${bookingId}/pay`,
        provider === 'MOCK' ? {} : { provider },
      );

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
          provider,
        );
        const response: StoredResponse = {
          status: 202,
          body: { paymentId: payment.id, status: 'INITIATED', provider },
        };
        await completeIdempotent(client, idem.keyId, response);
        return { kind: 'new' as const, payment, response, keyId: idem.keyId };
      });

      // A replay never calls the gateway again
      if (started.kind === 'replay') return { ...started.response, replayed: true };
      const { payment, response, keyId } = started;

      // Step 2 (Cashfree): create the order AFTER commit, then hand the browser its session
      if (provider === 'CASHFREE') {
        const { rows } = await pool.query<{ email: string }>(
          `SELECT email FROM users WHERE id = $1`,
          [userId],
        );
        const outcome = await cashfree!.ensureOrder({
          id: payment.id,
          booking_id: bookingId,
          amount: payment.amount,
          user_id: userId,
          email: rows[0]!.email,
        });
        if (outcome.kind === 'rejected') {
          return {
            ...(await failDefinitely(payment.id, bookingId, keyId, outcome.reason)),
            replayed: false,
          };
        }
        if (outcome.kind === 'created') {
          const withSession: StoredResponse = {
            status: 202,
            body: { ...(response.body as object), paymentSessionId: outcome.paymentSessionId },
          };
          await withTransaction(pool, (client) => completeIdempotent(client, keyId, withSession));
          return { ...withSession, replayed: false };
        }
        // Ambiguous: the payment stays INITIATED; the browser asks for a session again
        logger.warn(
          { paymentId: payment.id, reason: outcome.reason },
          'cashfree order not confirmed',
        );
        return { ...response, replayed: false };
      }

      // Step 2 (mock): call the gateway AFTER commit. It dedupes by payment id, so a retry is safe.
      const outcome = await gateway.charge({
        paymentId: payment.id,
        amount: payment.amount,
        callbackUrl,
      });

      // Step 3: interpret the outcome
      if (outcome.kind === 'rejected') {
        return {
          ...(await failDefinitely(payment.id, bookingId, keyId, outcome.reason)),
          replayed: false,
        };
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
