import { Router, type RequestHandler } from 'express';
import type { createHoldController } from '../controllers/holdController';

export function holdsRouter(
  controller: ReturnType<typeof createHoldController>,
  authenticate: RequestHandler,
  /** Per user, shared with pay. Runs after authenticate, which identifies the user */
  limitByUser: RequestHandler,
): Router {
  const router = Router();
  router.post('/holds', authenticate, limitByUser, controller.create);
  router.post('/holds/:bookingId/release', authenticate, controller.release);
  return router;
}
