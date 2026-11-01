import type { PoolClient } from 'pg';

export type OutboxEventType = 'BookingConfirmed' | 'RefundRequired';

/**
 * Transactional outbox (PRD 9.5): the event row is written in the SAME transaction as the
 * state change it describes, so either both commit or neither does. A crash can never
 * leave a confirmed booking without its event. The worker delivers events (Phase 6).
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
