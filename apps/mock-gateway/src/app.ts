import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import { z } from 'zod';
import type { GatewayEvent, Logger } from '@seatlock/shared';
import { sendWebhook } from './webhookSender';

/**
 * How the gateway behaves for the next charges (set via POST /__control):
 * - success            accept, then a payment.succeeded webhook
 * - fail               accept, then a payment.failed webhook
 * - reject             definite rejection: 402, no charge, no webhook
 * - delayed            accept, success webhook after delayMs
 * - timeout            accept the charge but never answer the HTTP call; success webhook later
 * - duplicate-webhook  accept, success webhook delivered twice (same event id)
 * - late-webhook       accept, success webhook after lateMs (past the hold expiry)
 */
export const MODES = [
  'success',
  'fail',
  'reject',
  'delayed',
  'timeout',
  'duplicate-webhook',
  'late-webhook',
] as const;
export type Mode = (typeof MODES)[number];

const controlSchema = z.object({
  mode: z.enum(MODES),
  delayMs: z.number().int().min(0).max(120_000).optional(),
  lateMs: z.number().int().min(0).max(600_000).optional(),
});

const chargeSchema = z.object({
  paymentId: z.uuid(),
  amount: z.number().int().positive(),
  callbackUrl: z.url(),
});

const refundSchema = z.object({
  paymentId: z.uuid(),
  amount: z.number().int().positive(),
  callbackUrl: z.url(),
});

interface Charge {
  chargeId: string;
  amount: number;
  callbackUrl: string;
}

export interface GatewayOptions {
  webhookSecret: string;
  logger: Logger;
  /** Enables POST /__control. Off in production. */
  controlEnabled: boolean;
  webhookDelayMs?: number;
}

export function createGatewayApp(opts: GatewayOptions) {
  const settings = { mode: 'success' as Mode, delayMs: 2000, lateMs: 10_000 };
  const defaultWebhookDelay = opts.webhookDelayMs ?? 100;

  // In-memory state, inspectable by tests
  const charges = new Map<string, Charge>();
  const refunds = new Map<string, string>();
  const chargeCalls = new Map<string, number>();
  const refundCalls = new Map<string, number>();
  const timers = new Set<NodeJS.Timeout>();

  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
  };

  const emit = (callbackUrl: string, event: GatewayEvent, delayMs: number, times = 1) => {
    for (let i = 0; i < times; i++) {
      later(delayMs + i * 50, () => {
        void sendWebhook(callbackUrl, event, opts.webhookSecret, opts.logger);
      });
    }
  };

  const paymentEvent = (
    type: 'payment.succeeded' | 'payment.failed',
    paymentId: string,
    charge: Charge,
  ): GatewayEvent => ({
    // Stable per charge and outcome, so a redelivery carries the same id
    id: `evt_${charge.chargeId}_${type}`,
    type,
    data: { paymentId, chargeId: charge.chargeId, amount: charge.amount },
    createdAt: new Date().toISOString(),
  });

  const app: Express = express();
  app.use(express.json());

  /** Idempotent by paymentId: a retried charge returns the original and sends no new webhook. */
  app.post('/charges', (req, res) => {
    const input = chargeSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'invalid_request' });
    const { paymentId, amount, callbackUrl } = input.data;
    chargeCalls.set(paymentId, (chargeCalls.get(paymentId) ?? 0) + 1);

    const existing = charges.get(paymentId);
    if (existing) return res.status(200).json({ chargeId: existing.chargeId, status: 'accepted' });

    const { mode, delayMs, lateMs } = settings;
    if (mode === 'reject') return res.status(402).json({ error: 'card_declined' });

    const charge: Charge = { chargeId: `ch_${randomUUID()}`, amount, callbackUrl };
    charges.set(paymentId, charge);
    opts.logger.info({ paymentId, chargeId: charge.chargeId, mode }, 'charge accepted');

    const succeeded = paymentEvent('payment.succeeded', paymentId, charge);
    switch (mode) {
      case 'success':
        emit(callbackUrl, succeeded, defaultWebhookDelay);
        break;
      case 'fail':
        emit(callbackUrl, paymentEvent('payment.failed', paymentId, charge), defaultWebhookDelay);
        break;
      case 'delayed':
        emit(callbackUrl, succeeded, delayMs);
        break;
      case 'duplicate-webhook':
        emit(callbackUrl, succeeded, defaultWebhookDelay, 2);
        break;
      case 'late-webhook':
        emit(callbackUrl, succeeded, lateMs);
        break;
      case 'timeout':
        // The charge went through, but the response is lost: the caller can't know
        emit(callbackUrl, succeeded, delayMs);
        return;
    }
    res.status(201).json({ chargeId: charge.chargeId, status: 'accepted' });
  });

  /** Idempotent by paymentId. Confirms asynchronously with a refund.succeeded webhook. */
  app.post('/refunds', (req, res) => {
    const input = refundSchema.safeParse(req.body);
    if (!input.success) return res.status(400).json({ error: 'invalid_request' });
    const { paymentId, callbackUrl } = input.data;
    refundCalls.set(paymentId, (refundCalls.get(paymentId) ?? 0) + 1);
    const charge = charges.get(paymentId);
    if (!charge) return res.status(404).json({ error: 'unknown_payment' });

    const existing = refunds.get(paymentId);
    if (existing) return res.status(200).json({ refundId: existing, status: 'accepted' });

    const refundId = `rf_${randomUUID()}`;
    refunds.set(paymentId, refundId);
    emit(
      callbackUrl,
      {
        id: `evt_${refundId}_refund.succeeded`,
        type: 'refund.succeeded',
        data: { paymentId, chargeId: charge.chargeId, amount: charge.amount, refundId },
        createdAt: new Date().toISOString(),
      },
      defaultWebhookDelay,
    );
    res.status(201).json({ refundId, status: 'accepted' });
  });

  if (opts.controlEnabled) {
    app.post('/__control', (req, res) => {
      const input = controlSchema.safeParse(req.body);
      if (!input.success) return res.status(400).json({ error: 'invalid_request' });
      Object.assign(settings, input.data);
      res.json(settings);
    });
  }

  return {
    app,
    state: { settings, charges, refunds, chargeCalls, refundCalls },
    /** Cancels pending webhooks so tests can shut down cleanly. */
    stop: () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
