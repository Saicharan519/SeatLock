import { timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler } from 'express';
import type { ApiConfig } from '../config/env';
import { AppError } from '../utils/errors';

/**
 * Paths reachable without the origin secret: the gateway's webhooks (they carry their own
 * HMAC signature and arrive directly, not through the frontend proxy) and the health check
 * (used by the hosting platform).
 */
const OPEN_PATHS = ['/webhooks/', '/health'];

/**
 * Rejects requests that didn't come through the frontend proxy. The proxy sets the
 * X-Origin-Secret header on every request it forwards (replacing any value a visitor
 * sends), so only requests that went through it carry the right value.
 */
export function requireOriginSecret(secret: string): RequestHandler {
  const expected = Buffer.from(secret);
  return (req, _res, next) => {
    if (OPEN_PATHS.some((p) => req.path.startsWith(p))) return next();
    const given = Buffer.from(req.get('x-origin-secret') ?? '');
    // Compare in constant time, so response timing reveals nothing about the secret
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return next(new AppError('FORBIDDEN', 'Requests must come through the website'));
    }
    next();
  };
}

/**
 * The visitor's IP for rate limiting. Behind a trusted proxy that sets a client-IP header
 * (and with the origin secret proving the request came through it), use that header;
 * otherwise Express's req.ip (which honours TRUST_PROXY).
 */
export function clientIp(config: Pick<ApiConfig, 'CLIENT_IP_HEADER' | 'ORIGIN_SECRET'>) {
  const header = config.ORIGIN_SECRET ? config.CLIENT_IP_HEADER : undefined;
  return (req: Request): string | undefined => {
    if (header) {
      const value = req.get(header)?.split(',')[0]?.trim();
      if (value) return value;
    }
    return req.ip;
  };
}
