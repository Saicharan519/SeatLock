import type { Server } from 'node:http';
import { z } from 'zod';
import { createPool } from '@seatlock/db';
import { createLogger, loadEnv } from '@seatlock/shared';
import { createGatewayApp } from './app';
import { createPgGatewayStore } from './pgStore';

const gatewayEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  GATEWAY_PORT: z.coerce.number().int().positive().default(4000),
  /** 127.0.0.1 when the gateway runs inside the same process host as the API (all-in-one) */
  GATEWAY_HOST: z.string().default('0.0.0.0'),
  WEBHOOK_SECRET: z.string().min(16, 'must be at least 16 characters'),
  /** POST /__control switches failure modes. Defaults to off in production; the local
   *  Docker stack turns it on so the demo scenarios can be driven. */
  GATEWAY_CONTROL_ENABLED: z.stringbool().optional(),
  /** If set, charges and refunds are kept in Postgres and survive a restart */
  DATABASE_URL: z.url().optional(),
});

/** Starts the mock gateway. Returns a function that stops it. */
export function startGateway(): { stop: () => Promise<void> } {
  const config = loadEnv(gatewayEnvSchema);
  const logger = createLogger('mock-gateway', config.LOG_LEVEL);
  const pool = config.DATABASE_URL
    ? createPool({ connectionString: config.DATABASE_URL, max: 2, acquireTimeoutMs: 10000 })
    : null;

  const gateway = createGatewayApp({
    webhookSecret: config.WEBHOOK_SECRET,
    logger,
    controlEnabled: config.GATEWAY_CONTROL_ENABLED ?? config.NODE_ENV !== 'production',
    store: pool ? createPgGatewayStore(pool) : undefined,
  });

  const server: Server = gateway.app.listen(config.GATEWAY_PORT, config.GATEWAY_HOST, () => {
    logger.info(
      { port: config.GATEWAY_PORT, host: config.GATEWAY_HOST, persistent: Boolean(pool) },
      'mock gateway listening',
    );
  });

  return {
    stop: () =>
      new Promise((resolve) => {
        gateway.stop();
        server.close(() => {
          void (pool?.end() ?? Promise.resolve()).finally(() => resolve());
        });
      }),
  };
}
