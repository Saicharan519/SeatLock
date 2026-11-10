import type { Pool } from 'pg';
import { cashfreeRefundId, type CashfreeClient, type GatewayClient } from '@seatlock/shared';
import type { Consumer } from '../outbox/processOutbox';

export interface ConsumerDeps {
  pool: Pool;
  gateway: GatewayClient;
  /** Where the gateway sends refund webhooks (the API's webhook endpoint) */
  webhookUrl: string;
  /** Present only when Cashfree keys are configured */
  cashfree?: CashfreeClient | null;
}

/**
 * BookingConfirmed -> a notification row. The real product would send an email or SMS here;
 * the row stands in for it (PRD non-goal: no real messaging).
 *
 * Idempotent through notifications.event_id UNIQUE: a second delivery of the same event
 * hits the constraint and inserts nothing.
 */
export function bookingConfirmedConsumer({ pool }: ConsumerDeps): Consumer {
  return async (event) => {
    const p = event.payload as { bookingId: string; userId: string };
    await pool.query(
      `INSERT INTO notifications (event_id, user_id, type, payload)
       VALUES ($1, $2, 'BOOKING_CONFIRMED', $3)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.id, p.userId, JSON.stringify(event.payload)],
    );
  };
}

/**
 * RefundRequired -> ask the gateway to refund. Idempotent because the gateway dedupes refunds
 * by payment id: a repeat call returns the original refund instead of paying out twice.
 * The gateway confirms with a refund.succeeded webhook, which moves the payment to REFUNDED.
 */
export function refundRequiredConsumer({
  pool,
  gateway,
  webhookUrl,
  cashfree,
}: ConsumerDeps): Consumer {
  return async (event) => {
    const p = event.payload as { paymentId: string; amount: number };
    const { rows } = await pool.query<{ provider: string }>(
      `SELECT provider FROM payments WHERE id = $1`,
      [p.paymentId],
    );
    if (rows[0]?.provider === 'CASHFREE') {
      // Idempotent by our refund id (one refund per payment). Cashfree confirms it later; the
      // reconciliation job (or a refund webhook) then moves the payment to REFUNDED.
      if (!cashfree) throw new Error('Cashfree refund needed but Cashfree is not configured');
      await cashfree.createRefund({
        orderId: p.paymentId,
        refundId: cashfreeRefundId(p.paymentId),
        amountPaise: p.amount,
      });
      return;
    }
    await gateway.refund({ paymentId: p.paymentId, amount: p.amount, callbackUrl: webhookUrl });
  };
}

export function createConsumers(deps: ConsumerDeps): Record<string, Consumer> {
  return {
    BookingConfirmed: bookingConfirmedConsumer(deps),
    RefundRequired: refundRequiredConsumer(deps),
  };
}
