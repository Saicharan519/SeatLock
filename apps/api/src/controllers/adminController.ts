import type { RequestHandler } from 'express';
import { z } from 'zod';
import { currentUser } from '../middleware/auth';
import type { AdminService } from '../services/adminService';
import type { OutboxAdminService } from '../services/outboxAdminService';
import { AppError } from '../utils/errors';

const listQuery = z.object({
  status: z.enum(['PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED']).default('FAILED'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const idParams = z.object({ id: z.string().regex(/^\d{1,18}$/) });

const bookingsQuery = z.object({
  status: z.enum(['PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'FAILED']).optional(),
  q: z
    .string()
    .trim()
    .max(100)
    .transform((s) => s || undefined)
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const theatreShowsQuery = z.object({ theatreId: z.uuid(), date: z.iso.date() });

export function createAdminController(outbox: OutboxAdminService, admin: AdminService) {
  const listOutbox: RequestHandler = async (req, res) => {
    const { status, limit } = listQuery.parse(req.query);
    res.json({ events: await outbox.list(status, limit) });
  };

  const retryOutbox: RequestHandler = async (req, res) => {
    const parsed = idParams.safeParse(req.params);
    if (!parsed.success) throw new AppError('NOT_FOUND', 'Outbox event not found');
    res.json({ event: await outbox.retry(parsed.data.id, currentUser(req).id) });
  };

  const overview: RequestHandler = async (_req, res) => {
    res.json(await admin.overview());
  };

  const bookings: RequestHandler = async (req, res) => {
    res.json({ bookings: await admin.bookings(bookingsQuery.parse(req.query)) });
  };

  const theatres: RequestHandler = async (_req, res) => {
    res.json({ theatres: await admin.theatres() });
  };

  const theatreShows: RequestHandler = async (req, res) => {
    const { theatreId, date } = theatreShowsQuery.parse(req.query);
    res.json({ shows: await admin.theatreShows(theatreId, date) });
  };

  return { listOutbox, retryOutbox, overview, bookings, theatres, theatreShows };
}
