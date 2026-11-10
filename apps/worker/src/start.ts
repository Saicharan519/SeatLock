import { createPool } from '@seatlock/db';
import { createCashfreeClient, createHttpGatewayClient, createLogger } from '@seatlock/shared';
import { createWebhookService } from '../../api/src/services/webhookService';
import { loadWorkerConfig } from './config';
import { createConsumers } from './consumers';
import { cleanupIdempotencyKeys } from './jobs/cleanupIdempotencyKeys';
import { expireHolds } from './jobs/expireHolds';
import { maintainCatalog } from './jobs/maintainCatalog';
import { reconcileCashfree } from './jobs/reconcileCashfree';
import { sweepStuckPayments } from './jobs/sweepStuckPayments';
import { processOutbox } from './outbox/processOutbox';

/**
 * Starts the worker loop. Returns a function that stops it after the current tick.
 * The process does not exit by itself; the caller decides (all-in-one runs it alongside
 * the API).
 */
export function startWorker(): { stop: () => Promise<void> } {
  const config = loadWorkerConfig();
  const logger = createLogger('worker', config.LOG_LEVEL);
  const pool = createPool({
    connectionString: config.DATABASE_URL,
    max: config.PG_POOL_MAX,
    acquireTimeoutMs: config.PG_POOL_ACQUIRE_TIMEOUT_MS,
  });

  const cashfree =
    config.CASHFREE_APP_ID && config.CASHFREE_SECRET_KEY
      ? createCashfreeClient({
          appId: config.CASHFREE_APP_ID,
          secretKey: config.CASHFREE_SECRET_KEY,
          baseUrl: config.CASHFREE_BASE_URL,
        })
      : null;

  const outboxOptions = {
    consumers: createConsumers({
      pool,
      gateway: createHttpGatewayClient(config.GATEWAY_URL, config.GATEWAY_TIMEOUT_MS),
      webhookUrl: new URL('/api/webhooks/payment', config.API_PUBLIC_URL).toString(),
      cashfree,
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

  if (cashfree) {
    // The same state machine the API's webhooks use (its secret only matters for signed webhooks)
    const { apply } = createWebhookService(pool, 'unused-by-reconciliation', logger);
    let lastRun = 0;
    jobs.push({
      name: 'reconcileCashfree',
      run: async () => {
        if (Date.now() - lastRun < config.CASHFREE_RECONCILE_SECONDS * 1000) return 0;
        lastRun = Date.now();
        return reconcileCashfree(pool, cashfree, apply, logger);
      },
    });
  }

  // Off by default (tests, local dev); hosted demos turn it on so showtimes never run out
  if (config.CATALOG_MAINTENANCE_HOURS > 0) {
    let lastRun = 0;
    const everyMs = config.CATALOG_MAINTENANCE_HOURS * 3_600_000;
    jobs.push({
      name: 'maintainCatalog',
      run: async () => {
        if (Date.now() - lastRun < everyMs) return 0;
        lastRun = Date.now();
        return maintainCatalog(pool, config.CATALOG_DAYS);
      },
    });
  }

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

  const done = loop().catch((err) => {
    logger.fatal({ err }, 'worker crashed');
    process.exit(1);
  });

  return {
    stop: async () => {
      logger.info('worker stopping after the current tick');
      stopping = true;
      await done;
    },
  };
}
