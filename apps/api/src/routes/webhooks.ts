import express, { Router } from 'express';
import type { createWebhookController } from '../controllers/webhookController';

/**
 * Mounted BEFORE the global JSON parser: HMAC verification needs the raw bytes,
 * and re-serialising parsed JSON would not reproduce them exactly.
 */
export function webhooksRouter(controller: ReturnType<typeof createWebhookController>): Router {
  const router = Router();
  router.post(
    '/webhooks/payment',
    express.raw({ type: () => true, limit: '100kb' }),
    controller.payment,
  );
  router.post(
    '/webhooks/cashfree',
    express.raw({ type: () => true, limit: '100kb' }),
    controller.cashfree,
  );
  return router;
}
