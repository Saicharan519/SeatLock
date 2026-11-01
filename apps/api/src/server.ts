import { createPool } from '@seatlock/db';
import { createLogger } from '@seatlock/shared';
import { createApp } from './app';
import { loadApiConfig } from './config/env';

const config = loadApiConfig();
const logger = createLogger('api', config.LOG_LEVEL);
const pool = createPool({
  connectionString: config.DATABASE_URL,
  max: config.PG_POOL_MAX,
  acquireTimeoutMs: config.PG_POOL_ACQUIRE_TIMEOUT_MS,
});

const server = createApp({ pool, config, logger }).listen(config.API_PORT, () => {
  logger.info({ port: config.API_PORT }, 'api listening');
});

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    pool.end().finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
