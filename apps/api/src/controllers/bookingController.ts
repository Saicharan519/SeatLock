import type { Request, RequestHandler } from 'express';
import { z } from 'zod';
import { currentUser } from '../middleware/auth';
import type { BookingService } from '../services/bookingService';
import type { CashfreeService } from '../services/cashfreeService';
import type { PaymentService } from '../services/paymentService';
import { AppError } from '../utils/errors';
import { requireIdempotencyKey } from '../utils/idempotency';

const idParams = z.object({ id: z.uuid() });

const payBody = z
  .object({ provider: z.enum(['MOCK', 'CASHFREE', 'mock', 'cashfree']).optional() })
  .default({});

function parseBookingId(req: Request): string {
  const parsed = idParams.safeParse(req.params);
  if (!parsed.success) throw new AppError('NOT_FOUND', 'Booking not found');
  return parsed.data.id;
}

export function createBookingController(
  bookings: BookingService,
  payments: PaymentService,
  cashfree: CashfreeService | null = null,
) {
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
    const { provider } = payBody.parse(req.body ?? {});
    const result = await payments.pay(
      user.id,
      key,
      bookingId,
      (provider?.toUpperCase() ?? 'MOCK') as 'MOCK' | 'CASHFREE',
    );
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    // A stored error response gets this request's id, like any other error
    const body = result.body as { error?: object };
    res
      .status(result.status)
      .json(body.error ? { error: { ...body.error, requestId: req.id } } : result.body);
  };

  const cancel: RequestHandler = async (req, res) => {
    res.json(await bookings.cancel(currentUser(req).id, parseBookingId(req)));
  };

  const paymentOptions: RequestHandler = (_req, res) => {
    res.json({ providers: payments.providers() });
  };

  const requireCashfree = () => {
    if (!cashfree) throw new AppError('NOT_FOUND', 'Cashfree payments are not enabled');
    return cashfree;
  };

  /** A Cashfree checkout session for the caller's open payment (retry or first-time timeout) */
  const paymentSession: RequestHandler = async (req, res) => {
    res.json(await requireCashfree().session(currentUser(req).id, parseBookingId(req)));
  };

  /** Ask Cashfree for the payment's status now: the customer is back from checkout */
  const refreshPayment: RequestHandler = async (req, res) => {
    res.json(await requireCashfree().refresh(currentUser(req).id, parseBookingId(req)));
  };

  return { listMine, get, pay, cancel, paymentOptions, paymentSession, refreshPayment };
}
