import type { Pool } from 'pg';
import { z } from 'zod';
import {
  cashfreeCustomerId,
  cashfreePaymentEventId,
  cashfreeRefundEventId,
  cashfreeRefundId,
  parseCashfreeWebhook,
  verifyCashfreeWebhook,
  type CashfreeClient,
  type Logger,
  type PaymentEvent,
} from '@seatlock/shared';
import { AppError } from '../utils/errors';
import type { WebhookResult } from './webhookService';

type Apply = (event: PaymentEvent, rawText: string) => Promise<WebhookResult>;

interface OpenPayment {
  id: string;
  booking_id: string;
  amount: number;
  status: string;
  user_id: string;
  email: string;
  live: boolean;
}

/**
 * Asks Cashfree about one payment and applies what it reports, through the same state
 * machine as webhooks (same event ids, so a webhook and a reconciliation of the same payment
 * are applied once). Used when the customer returns from checkout, and by the worker as a
 * backstop for lost or delayed webhooks. Returns what it did, or null if there was nothing
 * to apply yet.
 */
export async function reconcileCashfreePayment(
  pool: Pool,
  cashfree: CashfreeClient,
  apply: Apply,
  paymentId: string,
): Promise<WebhookResult | null> {
  const { rows } = await pool.query<{ status: string; amount: number }>(
    `SELECT status, amount FROM payments WHERE id = $1 AND provider = 'CASHFREE'`,
    [paymentId],
  );
  const payment = rows[0];
  if (!payment) return null;

  if (payment.status === 'INITIATED' || payment.status === 'FAILED') {
    const paid = (await cashfree.getPayments(paymentId)).find((p) => p.status === 'SUCCESS');
    if (!paid) return null;
    const event: PaymentEvent = {
      id: cashfreePaymentEventId(paid.cfPaymentId),
      type: 'payment.succeeded',
      data: { paymentId, chargeId: paid.cfPaymentId, amount: paid.amountPaise },
    };
    return apply(event, JSON.stringify({ source: 'reconciliation', ...event }));
  }

  if (payment.status === 'REFUND_REQUIRED') {
    const refund = await cashfree.getRefund(paymentId, cashfreeRefundId(paymentId));
    if (refund?.status !== 'SUCCESS') return null;
    const event: PaymentEvent = {
      id: cashfreeRefundEventId(refund.cfRefundId),
      type: 'refund.succeeded',
      data: {
        paymentId,
        chargeId: refund.cfRefundId,
        amount: refund.amountPaise,
        refundId: refund.cfRefundId,
      },
    };
    return apply(event, JSON.stringify({ source: 'reconciliation', ...event }));
  }
  return null;
}

const uuid = z.uuid();

export function createCashfreeService(opts: {
  pool: Pool;
  cashfree: CashfreeClient;
  secretKey: string;
  apply: Apply;
  logger: Logger;
  notifyUrl?: string;
  siteUrl?: string;
  customerPhone: string;
}) {
  const { pool, cashfree, apply, logger } = opts;

  /** The caller's own Cashfree payment for a booking, with what a new order needs. */
  async function openPaymentOf(userId: string, bookingId: string): Promise<OpenPayment> {
    const { rows } = await pool.query<OpenPayment>(
      `SELECT p.id, p.booking_id, p.amount, p.status, b.user_id, u.email,
              (b.status = 'PENDING' AND b.expires_at > now()) AS live
       FROM payments p
       JOIN bookings b ON b.id = p.booking_id
       JOIN users u ON u.id = b.user_id
       WHERE p.booking_id = $1 AND b.user_id = $2 AND p.provider = 'CASHFREE'`,
      [bookingId, userId],
    );
    if (!rows[0]) throw new AppError('NOT_FOUND', 'No Cashfree payment for this booking');
    return rows[0];
  }

  /**
   * Creates the Cashfree order for a payment (order id = SeatLock's payment id, amount from
   * SeatLock's database, never from the browser). If an earlier attempt already created it,
   * the existing order's session is returned instead.
   */
  async function ensureOrder(p: {
    id: string;
    booking_id: string;
    amount: number;
    user_id: string;
    email: string;
  }) {
    const outcome = await cashfree.createOrder({
      orderId: p.id,
      amountPaise: p.amount,
      customerId: cashfreeCustomerId(p.user_id),
      customerEmail: p.email,
      customerPhone: opts.customerPhone,
      returnUrl: opts.siteUrl
        ? `${opts.siteUrl}/checkout/${p.booking_id}?order_id={order_id}`
        : undefined,
      notifyUrl: opts.notifyUrl,
    });
    if (outcome.kind === 'exists') {
      const order = await cashfree.getOrder(p.id);
      return order?.paymentSessionId
        ? ({ kind: 'created', paymentSessionId: order.paymentSessionId } as const)
        : ({ kind: 'ambiguous', reason: 'order exists without a session' } as const);
    }
    return outcome;
  }

  return {
    ensureOrder,

    /**
     * A checkout session for the caller's open Cashfree payment, for when the first attempt
     * didn't return one (a timeout) or the customer closed the checkout and wants to retry.
     */
    async session(userId: string, bookingId: string) {
      const p = await openPaymentOf(userId, bookingId);
      if (p.status !== 'INITIATED') {
        throw new AppError('INVALID_STATE', 'This payment is no longer open');
      }
      const outcome = await ensureOrder(p);
      if (outcome.kind !== 'created') {
        throw new AppError('PAYMENT_GATEWAY_ERROR', 'Cashfree checkout is unavailable, try again');
      }
      return { paymentSessionId: outcome.paymentSessionId };
    },

    /** Checks Cashfree now (the customer just came back from checkout). */
    async refresh(userId: string, bookingId: string) {
      const p = await openPaymentOf(userId, bookingId);
      const result = await reconcileCashfreePayment(pool, cashfree, apply, p.id);
      return { result: result ?? 'pending' };
    },

    /** Cashfree's server-to-server notification. Signature first, then parse, then apply. */
    async handleWebhook(rawBody: Buffer, timestamp?: string, signature?: string) {
      if (!verifyCashfreeWebhook(opts.secretKey, rawBody, timestamp, signature)) {
        throw new AppError('INVALID_SIGNATURE', 'Invalid webhook signature');
      }
      const event = parseCashfreeWebhook(rawBody);
      // Not a uuid: not an order SeatLock created
      if (!event || !uuid.safeParse(event.data.paymentId).success) return 'ignored' as const;
      // Only Cashfree payments can be settled by Cashfree events
      const { rows } = await pool.query(
        `SELECT 1 FROM payments WHERE id = $1 AND provider = 'CASHFREE'`,
        [event.data.paymentId],
      );
      if (!rows[0]) {
        logger.warn({ eventId: event.id }, 'cashfree webhook for an unknown payment, ignoring');
        return 'ignored' as const;
      }
      return apply(event, rawBody.toString('utf8'));
    },
  };
}

export type CashfreeService = ReturnType<typeof createCashfreeService>;
