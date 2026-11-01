import 'dotenv/config';
import { z } from 'zod';

/** Variables every process shares. Each app extends this with its own. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  PG_POOL_MAX: z.coerce.number().int().positive().default(20),
  PG_POOL_ACQUIRE_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
});

/**
 * Parses process.env against a schema. A missing or invalid variable is fatal:
 * the process exits rather than running half-configured. Values are never printed.
 */
export function loadEnv<T extends z.ZodType>(schema: T): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error(`Invalid environment configuration:\n${problems}`);
    process.exit(1);
  }
  return result.data;
}
