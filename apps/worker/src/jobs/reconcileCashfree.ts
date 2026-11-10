import type { Pool } from 'pg';
import type { CashfreeClient, Logger, PaymentEvent } from '@seatlock/shared';
import { reconcileCashfreePayment } from '../../../api/src/services/cashfreeService';
import type { WebhookResult } from '../../../api/src/services/webhookService';

const BATCH = 20;

/**
 * The backstop for Cashfree's webhooks: asks Cashfree about open payments (INITIATED, or
 * FAILED by the sweep but possibly paid) and requested refunds, and applies what it reports.
 * Webhooks can be lost or delayed, refund webhooks need dashboard setup, and Cashfree can't
 * reach a laptop at all; this makes the outcome arrive anyway. Same event ids as webhooks,
 * so a result reported both ways is applied once.
 */
export async function reconcileCashfree(
  pool: Pool,
  cashfree: CashfreeClient,
  apply: (event: PaymentEvent, rawText: string) => Promise<WebhookResult>,
  logger: Logger,
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM payments
     WHERE provider = 'CASHFREE'
       AND (status IN ('INITIATED', 'REFUND_REQUIRED')
            OR (status = 'FAILED' AND updated_at > now() - interval '1 day'))
       AND created_at > now() - interval '3 days'
     ORDER BY updated_at
     LIMIT $1`,
    [BATCH],
  );
  let applied = 0;
  for (const { id } of rows) {
    try {
      const result = await reconcileCashfreePayment(pool, cashfree, apply, id);
      if (result && result !== 'duplicate' && result !== 'ignored') applied += 1;
    } catch (err) {
      // One payment failing (Cashfree down, say) must not stop the others
      logger.warn({ paymentId: id, err: (err as Error).message }, 'cashfree reconcile failed');
    }
  }
  return applied;
}
