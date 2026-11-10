import { Router, type RequestHandler } from 'express';
import type { createAdminController } from '../controllers/adminController';
import { requireAdmin } from '../middleware/auth';

/** Dashboard reads and background-event operations. Every route needs the ADMIN role. */
export function adminRouter(
  controller: ReturnType<typeof createAdminController>,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  const admin = [authenticate, requireAdmin];
  router.get('/admin/overview', ...admin, controller.overview);
  router.get('/admin/bookings', ...admin, controller.bookings);
  router.get('/admin/theatres', ...admin, controller.theatres);
  router.get('/admin/shows', ...admin, controller.theatreShows);
  router.get('/admin/outbox-events', ...admin, controller.listOutbox);
  router.post('/admin/outbox-events/:id/retry', ...admin, controller.retryOutbox);
  return router;
}
