import { createPool } from '@seatlock/db';
import { createLogger, createRedisClient } from '@seatlock/shared';
import { createApp } from './app';
import { loadApiConfig } from './config/env';
import { setTransitionLogger } from './utils/transitionLog';

/** Starts the API. Returns a function that stops it (server, Redis, database pool). */
export function startApi(): { stop: () => Promise<void> } {
  const config = loadApiConfig();
  const logger = createLogger('api', config.LOG_LEVEL);
  setTransitionLogger(logger);
  const pool = createPool({
    connectionString: config.DATABASE_URL,
    max: config.PG_POOL_MAX,
    acquireTimeoutMs: config.PG_POOL_ACQUIRE_TIMEOUT_MS,
  });
  // Always connected so /health can report it; the limiter uses it only if RATE_LIMIT_ENABLED
  const redis = createRedisClient(config.REDIS_URL, logger);
  if (!config.RATE_LIMIT_ENABLED) logger.warn('rate limiting is DISABLED');
  if (config.ORIGIN_SECRET) logger.info('only requests through the website proxy are accepted');

  // The per-connection timeouts (R6) are sent when each connection opens; check the
  // database really applied them (some hosted Postgres proxies drop startup parameters)
  pool
    .query<{ s: string; l: string }>(
      `SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l`,
    )
    .then(({ rows }) => {
      const ok = rows[0]?.s === '5s' && rows[0]?.l === '3s';
      if (ok) logger.info(rows[0], 'database timeouts applied');
      else logger.warn(rows[0], 'database timeouts NOT applied as configured (R6)');
    })
    .catch((err) => logger.warn({ err: (err as Error).message }, 'database not reachable yet'));

  const server = createApp({ pool, config, logger, redis }).listen(config.API_PORT, () => {
    logger.info({ port: config.API_PORT }, 'api listening');
  });

  return {
    stop: () =>
      new Promise((resolve) => {
        logger.info('api stopping');
        server.close(() => {
          redis.disconnect();
          void pool.end().finally(() => resolve());
        });
      }),
  };
}
