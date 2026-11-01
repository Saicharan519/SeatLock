import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@seatlock/shared';

const apiEnvSchema = baseEnvSchema.extend({
  API_PORT: z.coerce.number().int().positive().default(3000),
  JWT_SECRET: z.string().min(16, 'must be at least 16 characters'),
  WEBHOOK_SECRET: z.string().min(16, 'must be at least 16 characters'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(10),
  HOLD_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  MAX_SEATS_PER_HOLD: z.coerce.number().int().min(1).max(50).default(6),
  GATEWAY_URL: z.url().default('http://localhost:4000'),
  GATEWAY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  /** Base URL the gateway uses to reach our webhook endpoint */
  API_PUBLIC_URL: z.url().default('http://localhost:3000'),
});

export type ApiConfig = z.infer<typeof apiEnvSchema>;

export function loadApiConfig(): ApiConfig {
  return loadEnv(apiEnvSchema);
}
