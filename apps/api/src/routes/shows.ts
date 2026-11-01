import { Router, type RequestHandler } from 'express';
import type { createShowController } from '../controllers/showController';
import { requireAdmin } from '../middleware/auth';

export function showsRouter(
  controller: ReturnType<typeof createShowController>,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.get('/shows', controller.list);
  router.get('/shows/:id', controller.get);
  router.get('/shows/:id/seats', controller.seatMap);
  router.post('/admin/shows', authenticate, requireAdmin, controller.create);
  return router;
}
