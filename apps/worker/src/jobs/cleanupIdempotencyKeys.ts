import type { Pool } from 'pg';

const BATCH_SIZE = 1000;

/** Deletes idempotency keys past their 24-hour lifetime, in batches. Returns the count. */
export async function cleanupIdempotencyKeys(pool: Pool, batchSize = BATCH_SIZE): Promise<number> {
  let total = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM idempotency_keys
       WHERE id IN (
         SELECT id FROM idempotency_keys WHERE expires_at < now()
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )`,
      [batchSize],
    );
    const deleted = rowCount ?? 0;
    total += deleted;
    if (deleted < batchSize) return total;
  }
}
