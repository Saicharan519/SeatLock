import type { Pool } from 'pg';
import type { Logger } from '@seatlock/shared';

export interface OutboxEvent {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  /** Failed attempts so far, including leases that expired without a result */
  retry_count: number;
  lease_token: string;
}

/** A consumer performs an event's side effect. It may run more than once, so it must be idempotent. */
export type Consumer = (event: OutboxEvent) => Promise<void>;

export interface OutboxOptions {
  consumers: Record<string, Consumer>;
  logger: Logger;
  /** How long a claim lasts. Must stay well above handlerTimeoutMs. */
  leaseSeconds: number;
  handlerTimeoutMs: number;
  maxAttempts: number;
  /** Retry delay = backoffBaseMs * 2^(attempt - 1), capped at 5 minutes */
  backoffBaseMs: number;
  /**
   * Small on purpose: a batch's handlers run concurrently, so the whole batch finishes within
   * one handler timeout, far inside the lease. A huge batch processed one by one could
   * outlive its own lease and get re-claimed by another worker mid-batch.
   */
  batchSize?: number;
}

const MAX_BACKOFF_MS = 5 * 60 * 1000;

/**
 * Transaction 1 (PRD 9.5): claim due events and commit immediately.
 * Due = PENDING and next_attempt_at has passed, or PROCESSING with an expired lease
 * (its worker crashed or stalled). SKIP LOCKED lets several workers claim different rows.
 * Re-claiming an expired lease counts as a failed attempt, so an event that keeps
 * crashing its worker eventually lands in FAILED instead of looping forever.
 */
export async function claimOutboxEvents(
  pool: Pool,
  batchSize: number,
  leaseSeconds: number,
): Promise<OutboxEvent[]> {
  const { rows } = await pool.query<OutboxEvent>(
    `WITH due AS (
       SELECT id FROM outbox_events
       WHERE (status = 'PENDING' AND next_attempt_at <= now())
          OR (status = 'PROCESSING' AND locked_until < now())
       ORDER BY id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE outbox_events o
     SET status = 'PROCESSING',
         locked_until = now() + make_interval(secs => $2),
         lease_token = gen_random_uuid(),
         retry_count = CASE WHEN o.status = 'PROCESSING' THEN o.retry_count + 1 ELSE o.retry_count END,
         last_error = CASE WHEN o.status = 'PROCESSING'
                           THEN 'lease expired before a result was recorded'
                           ELSE o.last_error END
     FROM due
     WHERE o.id = due.id
     RETURNING o.id, o.event_type, o.payload, o.retry_count, o.lease_token`,
    [batchSize, leaseSeconds],
  );
  return rows;
}

/**
 * Transaction 2: record success. Fenced by the lease token, so a worker whose lease expired
 * (and whose event was re-claimed) can't overwrite the newer claim. Returns whether it applied.
 */
export async function markPublished(pool: Pool, event: OutboxEvent): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE outbox_events
     SET status = 'PUBLISHED', published_at = now(), locked_until = NULL, last_error = NULL
     WHERE id = $1 AND status = 'PROCESSING' AND lease_token = $2`,
    [event.id, event.lease_token],
  );
  return rowCount === 1;
}

/** Record a failure: back to PENDING with exponential backoff, or FAILED after maxAttempts. */
export async function markFailed(
  pool: Pool,
  event: OutboxEvent,
  error: string,
  opts: Pick<OutboxOptions, 'maxAttempts' | 'backoffBaseMs'>,
): Promise<'retry' | 'dead' | 'stale'> {
  const attempts = event.retry_count + 1;
  const dead = attempts >= opts.maxAttempts;
  const delayMs = Math.min(opts.backoffBaseMs * 2 ** (attempts - 1), MAX_BACKOFF_MS);
  const { rowCount } = await pool.query(
    `UPDATE outbox_events
     SET status = $3,
         retry_count = $4,
         last_error = $5,
         next_attempt_at = now() + make_interval(secs => $6),
         locked_until = NULL
     WHERE id = $1 AND status = 'PROCESSING' AND lease_token = $2`,
    [
      event.id,
      event.lease_token,
      dead ? 'FAILED' : 'PENDING',
      attempts,
      error.slice(0, 1000),
      delayMs / 1000,
    ],
  );
  if (rowCount !== 1) return 'stale';
  return dead ? 'dead' : 'retry';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`handler timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Runs one claimed event OUTSIDE any transaction (R7), then records the outcome. */
async function runEvent(pool: Pool, event: OutboxEvent, opts: OutboxOptions): Promise<void> {
  const log = opts.logger.child({ eventId: event.id, eventType: event.event_type });

  // Re-claimed so many times its worker must keep dying on it: give up without running it
  if (event.retry_count >= opts.maxAttempts) {
    await markFailed(pool, event, 'too many expired leases', { ...opts, maxAttempts: 0 });
    log.error({ attempts: event.retry_count }, 'outbox event failed permanently');
    return;
  }

  const consumer = opts.consumers[event.event_type];
  try {
    if (!consumer) throw new Error(`no consumer for event type ${event.event_type}`);
    await withTimeout(consumer(event), opts.handlerTimeoutMs);
  } catch (err) {
    const outcome = await markFailed(pool, event, (err as Error).message, opts);
    const entry = { attempt: event.retry_count + 1, err: (err as Error).message, outcome };
    if (outcome === 'dead') log.error(entry, 'outbox event failed permanently');
    else log.warn(entry, 'outbox event failed');
    return;
  }

  if (await markPublished(pool, event)) log.info('outbox event published');
  else log.warn('lease lost before recording the result; another worker owns this event');
}

/**
 * One worker tick of the outbox (PRD 9.5). Claims batches until none are due, running each
 * batch's handlers concurrently. Delivery is at-least-once: a crash after the side effect but
 * before markPublished means the event runs again, which is why consumers are idempotent.
 * Returns the number of events handled (published or failed).
 */
export async function processOutbox(pool: Pool, opts: OutboxOptions): Promise<number> {
  const batchSize = opts.batchSize ?? 20;
  let total = 0;
  for (;;) {
    const events = await claimOutboxEvents(pool, batchSize, opts.leaseSeconds);
    await Promise.all(events.map((event) => runEvent(pool, event, opts)));
    total += events.length;
    if (events.length < batchSize) return total;
  }
}
