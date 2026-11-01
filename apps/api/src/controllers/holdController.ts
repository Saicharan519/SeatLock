import type { RequestHandler } from 'express';
import { currentUser } from '../middleware/auth';
import type { HoldService } from '../services/holdService';
import { AppError } from '../utils/errors';
import { requireIdempotencyKey } from '../utils/idempotency';
import { bookingIdParams, createHoldSchema } from '../validators/holds';

export function createHoldController(holds: HoldService, maxSeats: number) {
  const holdSchema = createHoldSchema(maxSeats);

  const create: RequestHandler = async (req, res) => {
    const user = currentUser(req);
    const key = requireIdempotencyKey(req);
    const result = await holds.hold(user.id, key, holdSchema.parse(req.body));
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  };

  const release: RequestHandler = async (req, res) => {
    const parsed = bookingIdParams.safeParse(req.params);
    if (!parsed.success) throw new AppError('NOT_FOUND', 'Booking not found');
    res.json(await holds.release(currentUser(req).id, parsed.data.bookingId));
  };

  return { create, release };
}
