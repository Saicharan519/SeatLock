import { Router, type RequestHandler } from 'express';
import type { createAdminController } from '../controllers/adminController';
import { requireAdmin } from '../middleware/auth';

export function adminRouter(
  controller: ReturnType<typeof createAdminController>,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.get('/admin/outbox-events', authenticate, requireAdmin, controller.listOutbox);
  router.post('/admin/outbox-events/:id/retry', authenticate, requireAdmin, controller.retryOutbox);
  return router;
}
