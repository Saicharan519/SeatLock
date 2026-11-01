import { Redis } from 'ioredis';
import type { Logger } from './logger';

/**
 * Redis is used for rate limiting only, and the API must keep working without it (PRD 6).
 * The defaults of most Redis clients work against that: while disconnected they QUEUE
 * commands and wait for the connection to come back, so every request would hang.
 * These settings make a Redis problem fail fast instead:
 *
 * - enableOfflineQueue: false  -> while disconnected, commands are rejected immediately
 * - maxRetriesPerRequest: 0    -> a command isn't retried across reconnects
 * - commandTimeout: 250 ms     -> a connected-but-stuck Redis can't stall a request
 * - retryStrategy              -> keep reconnecting in the background (backoff, max 2 s)
 */
export function createRedisClient(url: string, logger: Logger): Redis {
  const redis = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    commandTimeout: 250,
    connectTimeout: 1000,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });

  // Without an error listener, a connection error would crash the process
  let lastLogged = 0;
  redis.on('error', (err) => {
    if (Date.now() - lastLogged > 10_000) {
      lastLogged = Date.now();
      logger.warn({ err: err.message }, 'redis unavailable');
    }
  });
  redis.on('ready', () => logger.info('redis connected'));
  return redis;
}

export type { Redis };
