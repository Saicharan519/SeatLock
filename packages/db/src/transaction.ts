import type { Pool, PoolClient } from 'pg';

/** deadlock_detected, serialization_failure, lock_not_available (lock_timeout) */
const RETRYABLE_CODES = new Set(['40P01', '40001', '55P03']);
const MAX_ATTEMPTS = 3;

/** Thrown when R4's retries are exhausted. The API maps it to 503 RETRY_LATER. */
export class RetryExhaustedError extends Error {
  constructor(override readonly cause: unknown) {
    super('Transaction retries exhausted');
    this.name = 'RetryExhaustedError';
  }
}

export function isRetryable(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    RETRYABLE_CODES.has((err as { code?: string }).code ?? '')
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs fn inside BEGIN/COMMIT at READ COMMITTED (R1). Deadlocks, serialization
 * failures and lock timeouts are retried up to 3 times with jitter (R4).
 * Any other error rolls back and is rethrown unchanged.
 *
 * fn must not make external HTTP calls (R7) and must be safe to re-run,
 * since a retry executes it again from the start.
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (!isRetryable(err)) throw err;
      if (attempt >= MAX_ATTEMPTS) throw new RetryExhaustedError(err);
      await sleep(10 * 2 ** attempt + Math.random() * 50);
    } finally {
      client.release();
    }
  }
}
