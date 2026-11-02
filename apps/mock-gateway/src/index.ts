import { z } from 'zod';
import { createLogger, loadEnv } from '@seatlock/shared';
import { createGatewayApp } from './app';

const config = loadEnv(
  z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.string().default('info'),
    GATEWAY_PORT: z.coerce.number().int().positive().default(4000),
    WEBHOOK_SECRET: z.string().min(16, 'must be at least 16 characters'),
    /** POST /__control switches failure modes. Defaults to off in production; the local
     *  Docker stack turns it on so the demo scenarios can be driven. */
    GATEWAY_CONTROL_ENABLED: z.stringbool().optional(),
  }),
);

const logger = createLogger('mock-gateway', config.LOG_LEVEL);
const { app } = createGatewayApp({
  webhookSecret: config.WEBHOOK_SECRET,
  logger,
  controlEnabled: config.GATEWAY_CONTROL_ENABLED ?? config.NODE_ENV !== 'production',
});

app.listen(config.GATEWAY_PORT, () => {
  logger.info({ port: config.GATEWAY_PORT }, 'mock gateway listening');
});
