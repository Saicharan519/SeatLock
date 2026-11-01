import { createPool } from '@seatlock/db';
import { createHttpGatewayClient, createLogger } from '@seatlock/shared';
import { loadWorkerConfig } from './config';
import { createConsumers } from './consumers';
import { cleanupIdempotencyKeys } from './jobs/cleanupIdempotencyKeys';
import { expireHolds } from './jobs/expireHolds';
import { sweepStuckPayments } from './jobs/sweepStuckPayments';
import { processOutbox } from './outbox/processOutbox';

const config = loadWorkerConfig();
const logger = createLogger('worker', config.LOG_LEVEL);
const pool = createPool({
  connectionString: config.DATABASE_URL,
  max: config.PG_POOL_MAX,
  acquireTimeoutMs: config.PG_POOL_ACQUIRE_TIMEOUT_MS,
});

const outboxOptions = {
  consumers: createConsumers({
    pool,
    gateway: createHttpGatewayClient(config.GATEWAY_URL, config.GATEWAY_TIMEOUT_MS),
    webhookUrl: new URL('/api/webhooks/payment', config.API_PUBLIC_URL).toString(),
  }),
  logger,
  leaseSeconds: config.OUTBOX_LEASE_SECONDS,
  handlerTimeoutMs: config.OUTBOX_HANDLER_TIMEOUT_MS,
  maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
  backoffBaseMs: config.OUTBOX_BACKOFF_BASE_MS,
};

/** Jobs run in sequence each tick. */
const jobs: { name: string; run: () => Promise<number> }[] = [
  { name: 'processOutbox', run: () => processOutbox(pool, outboxOptions) },
  { name: 'expireHolds', run: () => expireHolds(pool, undefined, logger) },
  {
    name: 'sweepStuckPayments',
    run: () => sweepStuckPayments(pool, config.PAYMENT_STUCK_AFTER_SECONDS, undefined, logger),
  },
  { name: 'cleanupIdempotencyKeys', run: () => cleanupIdempotencyKeys(pool) },
];

let stopping = false;

async function tick() {
  for (const job of jobs) {
    const started = Date.now();
    try {
      const count = await job.run();
      const entry = { job: job.name, count, durationMs: Date.now() - started };
      if (count > 0) logger.info(entry, 'job run');
      else logger.debug(entry, 'job run');
    } catch (err) {
      // One failing job must not stop the others or the loop
      logger.error({ err, job: job.name }, 'job failed');
    }
  }
}

/** The next tick is scheduled only after the current one finishes, so ticks never overlap. */
async function loop() {
  logger.info({ intervalMs: config.WORKER_INTERVAL_MS }, 'worker started');
  while (!stopping) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, config.WORKER_INTERVAL_MS));
  }
  await pool.end();
  logger.info('worker stopped');
}

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down after the current tick');
  stopping = true;
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

loop().catch((err) => {
  logger.fatal({ err }, 'worker crashed');
  process.exit(1);
});
