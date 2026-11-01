import { Router, type RequestHandler } from 'express';
import type { createAuthController } from '../controllers/authController';

export function authRouter(
  controller: ReturnType<typeof createAuthController>,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  // Rate limiting (FR-18) is added in Phase 7
  router.post('/auth/register', controller.register);
  router.post('/auth/login', controller.login);
  router.get('/auth/me', authenticate, controller.me);
  return router;
}
