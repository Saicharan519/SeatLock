import type { RequestHandler } from 'express';
import { SIGNATURE_HEADER } from '@seatlock/shared';
import type { WebhookService } from '../services/webhookService';
import { AppError } from '../utils/errors';

export function createWebhookController(webhooks: WebhookService) {
  /** req.body is the raw Buffer: the signature covers the exact bytes the gateway sent. */
  const payment: RequestHandler = async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new AppError('VALIDATION_ERROR', 'Expected a JSON body');
    const result = await webhooks.handle(req.body, req.header(SIGNATURE_HEADER));
    res.json({ received: true, result });
  };

  return { payment };
}
