import type { Pool } from 'pg';
import { createLogger } from '@seatlock/shared';
import type { Consumer, OutboxOptions } from '../../apps/worker/src/outbox/processOutbox';

export const silentLogger = createLogger('worker-test', process.env.TEST_LOG_LEVEL ?? 'silent');

/** Fast settings for tests. Lease stays far above the handler timeout, as in production. */
export function outboxOptions(
  consumers: Record<string, Consumer>,
  overrides: Partial<OutboxOptions> = {},
): OutboxOptions {
  return {
    consumers,
    logger: silentLogger,
    leaseSeconds: 60,
    handlerTimeoutMs: 2000,
    maxAttempts: 8,
    backoffBaseMs: 1000,
    ...overrides,
  };
}

/** Inserts n PENDING outbox events of a given type. Returns their ids. */
export async function insertEvents(
  pool: Pool,
  n: number,
  eventType = 'Test',
  payload: object = {},
): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
     SELECT 'test', g::text, $2, $3 FROM generate_series(1, $1) g
     RETURNING id`,
    [n, eventType, JSON.stringify(payload)],
  );
  return rows.map((r) => r.id);
}

export async function eventRow(pool: Pool, id: string) {
  const { rows } = await pool.query(
    `SELECT status, retry_count, last_error, next_attempt_at > now() AS backing_off,
            locked_until, published_at IS NOT NULL AS published
     FROM outbox_events WHERE id = $1`,
    [id],
  );
  return rows[0];
}
