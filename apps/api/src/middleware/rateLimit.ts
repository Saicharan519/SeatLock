import type { Request, RequestHandler } from 'express';
import type { Logger, Redis } from '@seatlock/shared';
import { AppError } from '../utils/errors';

/**
 * Fixed-window counter, atomic in Redis. INCR and setting the expiry happen in one Lua
 * script, so two concurrent first requests can't both skip setting the expiry (which would
 * leave a counter that never resets). Returns [count in this window, ms until it resets].
 */
const SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}
`;

export interface RateLimitOptions {
  /** null when rate limiting is disabled or Redis isn't configured */
  redis: Redis | null;
  name: string;
  limit: number;
  windowSeconds: number;
  /** Who is being limited: an IP address or a user id */
  keyOf: (req: Request) => string | undefined;
  logger: Logger;
}

/**
 * FR-18. Postgres is the source of truth; Redis only protects it from abuse. So if Redis is
 * down or slow, the request is ALLOWED (fail open) and a warning is logged, at most every
 * 10 s. Failing closed would turn a Redis outage into a full outage.
 */
export function rateLimit(opts: RateLimitOptions): RequestHandler {
  const { redis, name, limit, windowSeconds, keyOf, logger } = opts;
  if (!redis) return (_req, _res, next) => next();

  let lastWarned = 0;
  return async (req, res, next) => {
    const who = keyOf(req);
    if (!who) return next();

    let count: number;
    let resetMs: number;
    try {
      [count, resetMs] = (await redis.eval(
        SCRIPT,
        1,
        `rl:${name}:${who}`,
        windowSeconds * 1000,
      )) as [number, number];
    } catch (err) {
      if (Date.now() - lastWarned > 10_000) {
        lastWarned = Date.now();
        logger.warn({ err: (err as Error).message, limiter: name }, 'rate limiter failing open');
      }
      return next();
    }

    const resetSeconds = Math.max(1, Math.ceil(resetMs / 1000));
    res.setHeader('RateLimit-Limit', limit);
    res.setHeader('RateLimit-Remaining', Math.max(0, limit - count));
    res.setHeader('RateLimit-Reset', resetSeconds);
    if (count > limit) {
      res.setHeader('Retry-After', resetSeconds);
      return next(new AppError('RATE_LIMITED', `Too many requests, retry in ${resetSeconds} s`));
    }
    next();
  };
}
