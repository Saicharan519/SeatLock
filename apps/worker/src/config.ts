import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@seatlock/shared';

const workerEnvSchema = baseEnvSchema.extend({
  WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  PG_POOL_MAX: z.coerce.number().int().positive().default(5),
  /** A payment INITIATED for longer than this with no webhook is marked FAILED */
  PAYMENT_STUCK_AFTER_SECONDS: z.coerce.number().int().positive().default(900),
  OUTBOX_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  OUTBOX_HANDLER_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),
  OUTBOX_BACKOFF_BASE_MS: z.coerce.number().int().min(0).default(1000),
  GATEWAY_URL: z.url().default('http://localhost:4000'),
  GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  /** Base URL of the API, for the refund webhook callback */
  API_PUBLIC_URL: z.url().default('http://localhost:3000'),
});

export type WorkerConfig = z.infer<typeof workerEnvSchema>;

export function loadWorkerConfig(): WorkerConfig {
  const config = loadEnv(workerEnvSchema);
  // A lease must outlive the handler, or a slow-but-alive handler gets its event re-claimed
  if (config.OUTBOX_LEASE_SECONDS * 1000 <= config.OUTBOX_HANDLER_TIMEOUT_MS) {
    console.error('OUTBOX_LEASE_SECONDS must be longer than OUTBOX_HANDLER_TIMEOUT_MS');
    process.exit(1);
  }
  return config;
}
