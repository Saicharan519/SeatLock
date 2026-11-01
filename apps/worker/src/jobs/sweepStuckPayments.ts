import type { Pool } from 'pg';
import type { Logger } from '@seatlock/shared';

const BATCH_SIZE = 100;

/**
 * PRD 9.4: a payment still INITIATED long after it started (default 15 minutes) never got
 * a webhook, typically after an ambiguous gateway outcome. Mark it FAILED.
 *
 * This is safe even if the customer WAS charged: a success webhook that arrives later for a
 * FAILED payment becomes REFUND_REQUIRED (PRD 9.3), never a silent no-op.
 *
 * The booking is left alone. Its hold expired long ago and the expiry job handles it.
 * Only payment rows are locked, so this cannot deadlock with the booking -> payment order.
 *
 * Returns the number of payments failed.
 */
export async function sweepStuckPayments(
  pool: Pool,
  stuckAfterSeconds: number,
  batchSize = BATCH_SIZE,
  logger?: Logger,
): Promise<number> {
  let total = 0;
  for (;;) {
    // A single statement commits on its own, so logging after it reflects committed state
    const { rows } = await pool.query<{ id: string }>(
      `UPDATE payments SET status = 'FAILED', updated_at = now()
       WHERE id IN (
         SELECT id FROM payments
         WHERE status = 'INITIATED' AND created_at < now() - make_interval(secs => $1)
         ORDER BY id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       AND status = 'INITIATED'
       RETURNING id`,
      [stuckAfterSeconds, batchSize],
    );
    for (const { id } of rows) {
      logger?.info({ entity: 'payment', id, from: 'INITIATED', to: 'FAILED' }, 'state transition');
    }
    const swept = rows.length;
    total += swept;
    if (swept < batchSize) return total;
  }
}
