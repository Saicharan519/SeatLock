import { Router, type RequestHandler } from 'express';
import type { createBookingController } from '../controllers/bookingController';

export function bookingsRouter(
  controller: ReturnType<typeof createBookingController>,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  // /bookings/me before /bookings/:id, or "me" would be treated as an id
  router.get('/bookings/me', authenticate, controller.listMine);
  router.get('/bookings/:id', authenticate, controller.get);
  router.post('/bookings/:id/pay', authenticate, controller.pay);
  return router;
}
