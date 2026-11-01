import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-seatlock-signature';
/** Webhooks older (or further in the future) than this are rejected, which blocks replays. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

function hmac(secret: string, timestamp: number, rawBody: string | Buffer): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest('hex');
}

/**
 * Header value "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${rawBody}`>".
 * Signing the timestamp together with the body stops an attacker reusing an old
 * signature with a fresh timestamp.
 */
export function signWebhook(
  secret: string,
  rawBody: string | Buffer,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  return `t=${timestamp},v1=${hmac(secret, timestamp, rawBody)}`;
}

/** True only for a well-formed, correctly signed header with a fresh timestamp. */
export function verifyWebhook(
  secret: string,
  rawBody: Buffer,
  header: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!Number.isInteger(timestamp) || !signature || !/^[0-9a-f]{64}$/.test(signature)) {
    return false;
  }
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = Buffer.from(hmac(secret, timestamp, rawBody), 'hex');
  // Constant-time compare: response time must not reveal how many bytes matched
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
