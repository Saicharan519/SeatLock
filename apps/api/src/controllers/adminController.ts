import type { RequestHandler } from 'express';
import { z } from 'zod';
import { currentUser } from '../middleware/auth';
import type { OutboxAdminService } from '../services/outboxAdminService';
import { AppError } from '../utils/errors';

const listQuery = z.object({
  status: z.enum(['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED']).default('FAILED'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const idParams = z.object({ id: z.string().regex(/^\d{1,18}$/) });

export function createAdminController(outbox: OutboxAdminService) {
  const listOutbox: RequestHandler = async (req, res) => {
    const { status, limit } = listQuery.parse(req.query);
    res.json({ events: await outbox.list(status, limit) });
  };

  const retryOutbox: RequestHandler = async (req, res) => {
    const parsed = idParams.safeParse(req.params);
    if (!parsed.success) throw new AppError('NOT_FOUND', 'Outbox event not found');
    res.json({ event: await outbox.retry(parsed.data.id, currentUser(req).id) });
  };

  return { listOutbox, retryOutbox };
}
