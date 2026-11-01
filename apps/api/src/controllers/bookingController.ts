import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { currentUser } from '../middleware/auth';
import type { BookingService } from '../services/bookingService';
import type { PaymentService } from '../services/paymentService';
import { AppError } from '../utils/errors';
import { requireIdempotencyKey } from '../utils/idempotency';

const idParams = z.object({ id: z.uuid() });

function parseBookingId(req: Request): string {
  const parsed = idParams.safeParse(req.params);
  if (!parsed.success) throw new AppError('NOT_FOUND', 'Booking not found');
  return parsed.data.id;
}

export function createBookingController(bookings: BookingService, payments: PaymentService) {
  const listMine: RequestHandler = async (req, res) => {
    res.json({ bookings: await bookings.listMine(currentUser(req).id) });
  };

  const get: RequestHandler = async (req, res) => {
    res.json({ booking: await bookings.get(currentUser(req).id, parseBookingId(req)) });
  };

  const pay: RequestHandler = async (req, res) => {
    const user = currentUser(req);
    const bookingId = parseBookingId(req);
    const key = requireIdempotencyKey(req);
    const result = await payments.pay(user.id, key, bookingId);
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    // A stored error response gets this request's id, like any other error
    const body = result.body as { error?: object };
    res
      .status(result.status)
      .json(body.error ? { error: { ...body.error, requestId: req.id } } : result.body);
  };

  return { listMine, get, pay };
}
