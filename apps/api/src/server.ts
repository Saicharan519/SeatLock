import { createPool } from '@seatlock/db';
import { createLogger, createRedisClient } from '@seatlock/shared';
import { createApp } from './app';
import { loadApiConfig } from './config/env';
import { setTransitionLogger } from './utils/transitionLog';

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

const server = createApp({ pool, config, logger, redis }).listen(config.API_PORT, () => {
  logger.info({ port: config.API_PORT }, 'api listening');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    redis.disconnect();
    pool.end().finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
