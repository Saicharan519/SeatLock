export { baseEnvSchema, loadEnv } from './env';
export { createLogger, type Logger } from './logger';
export {
  signWebhook,
  verifyWebhook,
  SIGNATURE_HEADER,
  SIGNATURE_TOLERANCE_SECONDS,
} from './webhookSignature';
export { createHttpGatewayClient, type ChargeOutcome, type GatewayClient } from './gatewayClient';

/** Webhook event payload, shared by the mock gateway (sender) and the API (receiver). */
export interface GatewayEvent {
  id: string;
  type: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded';
  data: { paymentId: string; chargeId: string; amount: number; refundId?: string };
  createdAt: string;
}
