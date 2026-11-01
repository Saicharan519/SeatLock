import { Router, type RequestHandler } from 'express';
import type { createHoldController } from '../controllers/holdController';

export function holdsRouter(
  controller: ReturnType<typeof createHoldController>,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.post('/holds', authenticate, controller.create);
  router.post('/holds/:bookingId/release', authenticate, controller.release);
  return router;
}
