import type { RequestHandler } from 'express';
import { SIGNATURE_HEADER } from '@seatlock/shared';
import type { CashfreeService } from '../services/cashfreeService';
import type { WebhookService } from '../services/webhookService';
import { AppError } from '../utils/errors';

export function createWebhookController(
  webhooks: WebhookService,
  cashfree: CashfreeService | null = null,
) {
  /** req.body is the raw Buffer: the signature covers the exact bytes the gateway sent. */
  const payment: RequestHandler = async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new AppError('VALIDATION_ERROR', 'Expected a JSON body');
    const result = await webhooks.handle(req.body, req.header(SIGNATURE_HEADER));
    res.json({ received: true, result });
  };

  /** Cashfree's notification: signed over x-webhook-timestamp + the raw body */
  const cashfreeWebhook: RequestHandler = async (req, res) => {
    if (!cashfree) throw new AppError('NOT_FOUND', 'Cashfree payments are not enabled');
    if (!Buffer.isBuffer(req.body)) throw new AppError('VALIDATION_ERROR', 'Expected a JSON body');
    const result = await cashfree.handleWebhook(
      req.body,
      req.header('x-webhook-timestamp'),
      req.header('x-webhook-signature'),
    );
    res.json({ received: true, result });
  };

  return { payment, cashfree: cashfreeWebhook };
}
