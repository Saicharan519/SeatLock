import { signWebhook, SIGNATURE_HEADER, type GatewayEvent, type Logger } from '@seatlock/shared';

const MAX_ATTEMPTS = 4;

/**
 * Delivers a signed webhook. Like a real gateway, it retries on network errors and
 * non-2xx responses with exponential backoff, which is one reason the receiver must
 * treat duplicate deliveries as no-ops.
 */
export async function sendWebhook(
  callbackUrl: string,
  event: GatewayEvent,
  secret: string,
  logger: Logger,
): Promise<void> {
  const body = JSON.stringify(event);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(callbackUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: signWebhook(secret, body),
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        logger.info({ eventId: event.id, type: event.type, attempt }, 'webhook delivered');
        return;
      }
      logger.warn({ eventId: event.id, status: res.status, attempt }, 'webhook rejected');
    } catch (err) {
      logger.warn({ eventId: event.id, err: (err as Error).message, attempt }, 'webhook failed');
    }
    await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
  }
  logger.error({ eventId: event.id }, 'webhook abandoned after retries');
}
