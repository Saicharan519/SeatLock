/**
 * A worker that dies mid-handler, for T11. Run as a separate OS process by the test:
 *
 * 1. Claims due outbox events with a short lease (2 s).
 * 2. Runs the REAL BookingConfirmed consumer, so the side effect (the notification) happens.
 * 3. Prints SIDE_EFFECT_DONE and then hangs, never recording the result.
 *
 * The test then kills this process with SIGKILL: no cleanup, no graceful shutdown, exactly
 * like a crash or an OOM kill. The event is left PROCESSING with a lease that will expire.
 */
import { createPool } from '@seatlock/db';
import { createLogger, type GatewayClient } from '@seatlock/shared';
import { bookingConfirmedConsumer } from '../../apps/worker/src/consumers';
import { processOutbox } from '../../apps/worker/src/outbox/processOutbox';

const pool = createPool({
  connectionString: process.env.DATABASE_URL!,
  max: 2,
  acquireTimeoutMs: 10_000,
});
const notify = bookingConfirmedConsumer({
  pool,
  gateway: {} as GatewayClient,
  webhookUrl: 'http://unused',
});

void processOutbox(pool, {
  consumers: {
    BookingConfirmed: async (event) => {
      await notify(event);
      process.stdout.write('SIDE_EFFECT_DONE\n');
      await new Promise(() => {}); // hang until killed
    },
  },
  logger: createLogger('crashing-worker', 'silent'),
  leaseSeconds: 2,
  handlerTimeoutMs: 600_000,
  maxAttempts: 8,
  backoffBaseMs: 1000,
});
