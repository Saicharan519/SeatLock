import type { Pool } from 'pg';
import type { Logger } from '@seatlock/shared';
import * as outbox from '../repositories/outboxRepository';
import { AppError } from '../utils/errors';

const toView = (e: outbox.OutboxEventRow) => ({
  id: e.id,
  eventType: e.event_type,
  aggregateType: e.aggregate_type,
  aggregateId: e.aggregate_id,
  status: e.status,
  retryCount: e.retry_count,
  lastError: e.last_error,
  payload: e.payload,
  createdAt: e.created_at.toISOString(),
  nextAttemptAt: e.next_attempt_at.toISOString(),
  publishedAt: e.published_at?.toISOString() ?? null,
});

/** FR-19: lets an admin see dead events, and send one back for another try once fixed. */
export function createOutboxAdminService(pool: Pool, logger: Logger) {
  return {
    async list(status: outbox.OutboxStatus, limit: number) {
      return (await outbox.listOutboxEvents(pool, status, limit)).map(toView);
    },

    async retry(id: string, adminId: string) {
      const event = await outbox.requeueFailedEvent(pool, id);
      if (!event) {
        if (!(await outbox.outboxEventExists(pool, id))) {
          throw new AppError('NOT_FOUND', 'Outbox event not found');
        }
        throw new AppError('INVALID_STATE', 'Only FAILED events can be retried');
      }
      logger.info({ eventId: id, adminId }, 'outbox event requeued by admin');
      return toView(event);
    },
  };
}

export type OutboxAdminService = ReturnType<typeof createOutboxAdminService>;
