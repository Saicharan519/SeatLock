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
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** Disable for load tests (and say so when reporting the numbers) */
  RATE_LIMIT_ENABLED: z.stringbool().default(true),
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_BOOKING_PER_MINUTE: z.coerce.number().int().positive().default(30),
  /** The timezone calendar days are counted in ("shows on 4 Nov" means 4 Nov in this zone) */
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),
  /**
   * Only behind ONE trusted reverse proxy (the Docker stack's nginx, which overwrites
   * X-Forwarded-For): req.ip is then taken from that header, trusting exactly one hop.
   */
  TRUST_PROXY: z.stringbool().default(false),
  /**
   * When set, every request except webhooks and the health check must carry this value in
   * the X-Origin-Secret header. The hosted setup has Vercel add it on every proxied request,
   * so the backend can't be called directly, bypassing Vercel.
   */
  ORIGIN_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),
  /**
   * A header holding the visitor's IP, set by the trusted proxy in front (Vercel sets
   * x-real-ip). Only honoured together with ORIGIN_SECRET, because otherwise anyone could
   * send the header themselves and pick the IP the rate limiter sees.
   */
  CLIENT_IP_HEADER: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
});

export type ApiConfig = z.infer<typeof apiEnvSchema>;

export function loadApiConfig(): ApiConfig {
  const config = loadEnv(apiEnvSchema);
  if (config.CLIENT_IP_HEADER && !config.ORIGIN_SECRET) {
    console.error('CLIENT_IP_HEADER is only safe with ORIGIN_SECRET set');
    process.exit(1);
  }
  return config;
}
