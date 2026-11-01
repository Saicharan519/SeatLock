import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@seatlock/shared';

const workerEnvSchema = baseEnvSchema.extend({
  WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  PG_POOL_MAX: z.coerce.number().int().positive().default(5),
});

export type WorkerConfig = z.infer<typeof workerEnvSchema>;

export function loadWorkerConfig(): WorkerConfig {
  return loadEnv(workerEnvSchema);
}
