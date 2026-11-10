import { Router, type RequestHandler } from 'express';
import type { createBookingController } from '../controllers/bookingController';

export function bookingsRouter(
  controller: ReturnType<typeof createBookingController>,
  authenticate: RequestHandler,
  /** Per user, shared with holds */
  limitByUser: RequestHandler,
): Router {
  const router = Router();
  // /bookings/me before /bookings/:id, or "me" would be treated as an id
  router.get('/bookings/me', authenticate, controller.listMine);
  router.get('/bookings/:id', authenticate, controller.get);
  router.post('/bookings/:id/pay', authenticate, limitByUser, controller.pay);
  router.post('/bookings/:id/cancel', authenticate, controller.cancel);
  router.get('/payments/options', controller.paymentOptions);
  router.post(
    '/bookings/:id/payment/session',
    authenticate,
    limitByUser,
    controller.paymentSession,
  );
  router.post(
    '/bookings/:id/payment/refresh',
    authenticate,
    limitByUser,
    controller.refreshPayment,
  );
  return router;
}
