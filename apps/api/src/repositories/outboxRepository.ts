import type { PoolClient } from 'pg';
import type { Queryable } from '@seatlock/db';

export type OutboxEventType = 'BookingConfirmed' | 'RefundRequired';
export type OutboxStatus = 'PENDING' | 'PROCESSING' | 'PUBLISHED' | 'FAILED';

/**
 * Transactional outbox (PRD 9.5): the event row is written in the SAME transaction as the
 * state change it describes, so either both commit or neither does. A crash can never
 * leave a confirmed booking without its event. The worker delivers events.
 */
export async function insertOutboxEvent(
  client: PoolClient,
  event: {
    aggregateType: 'booking' | 'payment';
    aggregateId: string;
    eventType: OutboxEventType;
    payload: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
     VALUES ($1, $2, $3, $4)`,
    [event.aggregateType, event.aggregateId, event.eventType, JSON.stringify(event.payload)],
  );
}

export interface OutboxEventRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  retry_count: number;
  last_error: string | null;
  next_attempt_at: Date;
  created_at: Date;
  published_at: Date | null;
}

const COLUMNS = `id, aggregate_type, aggregate_id, event_type, payload, status, retry_count,
                 last_error, next_attempt_at, created_at, published_at`;

/** Newest first. */
export async function listOutboxEvents(
  db: Queryable,
  status: OutboxStatus,
  limit: number,
): Promise<OutboxEventRow[]> {
  const { rows } = await db.query<OutboxEventRow>(
    `SELECT ${COLUMNS} FROM outbox_events WHERE status = $1 ORDER BY id DESC LIMIT $2`,
    [status, limit],
  );
  return rows;
}

/**
 * Guarded FAILED -> PENDING with a fresh attempt budget, due immediately. last_error is kept
 * so the history of why it failed isn't lost. Returns undefined if the event isn't FAILED.
 */
export async function requeueFailedEvent(
  db: Queryable,
  id: string,
): Promise<OutboxEventRow | undefined> {
  const { rows } = await db.query<OutboxEventRow>(
    `UPDATE outbox_events
     SET status = 'PENDING', retry_count = 0, next_attempt_at = now(), locked_until = NULL
     WHERE id = $1 AND status = 'FAILED'
     RETURNING ${COLUMNS}`,
    [id],
  );
  return rows[0];
}

export async function outboxEventExists(db: Queryable, id: string): Promise<boolean> {
  const { rowCount } = await db.query(`SELECT 1 FROM outbox_events WHERE id = $1`, [id]);
  return rowCount === 1;
}
