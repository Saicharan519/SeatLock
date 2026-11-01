import { Router, type RequestHandler } from 'express';
import type { createAuthController } from '../controllers/authController';

export function authRouter(
  controller: ReturnType<typeof createAuthController>,
  authenticate: RequestHandler,
  /** Per IP: slows password guessing and signup spam */
  limitByIp: RequestHandler,
): Router {
  const router = Router();
  router.post('/auth/register', limitByIp, controller.register);
  router.post('/auth/login', limitByIp, controller.login);
  router.get('/auth/me', authenticate, controller.me);
  return router;
}
