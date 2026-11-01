import { createPool } from '@seatlock/db';
import { createLogger } from '@seatlock/shared';
import { loadWorkerConfig } from './config';
import { cleanupIdempotencyKeys } from './jobs/cleanupIdempotencyKeys';
import { expireHolds } from './jobs/expireHolds';
import { sweepStuckPayments } from './jobs/sweepStuckPayments';

const config = loadWorkerConfig();
const logger = createLogger('worker', config.LOG_LEVEL);
const pool = createPool({
  connectionString: config.DATABASE_URL,
  max: config.PG_POOL_MAX,
  acquireTimeoutMs: config.PG_POOL_ACQUIRE_TIMEOUT_MS,
});

/** Jobs run in sequence each tick. The outbox processor joins in Phase 6. */
const jobs: { name: string; run: () => Promise<number> }[] = [
  { name: 'expireHolds', run: () => expireHolds(pool) },
  {
    name: 'sweepStuckPayments',
    run: () => sweepStuckPayments(pool, config.PAYMENT_STUCK_AFTER_SECONDS),
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
