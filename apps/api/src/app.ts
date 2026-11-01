import express, { type Express } from 'express';
import type { Pool } from 'pg';
import {
  createHttpGatewayClient,
  type GatewayClient,
  type Logger,
  type Redis,
} from '@seatlock/shared';
import type { ApiConfig } from './config/env';
import { createAdminController } from './controllers/adminController';
import { createAuthController } from './controllers/authController';
import { createBookingController } from './controllers/bookingController';
import { createHoldController } from './controllers/holdController';
import { createShowController } from './controllers/showController';
import { createWebhookController } from './controllers/webhookController';
import { requireAuth } from './middleware/auth';
import { errorHandler, notFound } from './middleware/errorHandler';
import { rateLimit } from './middleware/rateLimit';
import { requestLogger } from './middleware/requestLogger';
import { adminRouter } from './routes/admin';
import { authRouter } from './routes/auth';
import { bookingsRouter } from './routes/bookings';
import { healthRouter } from './routes/health';
import { holdsRouter } from './routes/holds';
import { showsRouter } from './routes/shows';
import { webhooksRouter } from './routes/webhooks';
import { createAuthService } from './services/authService';
import { createBookingService } from './services/bookingService';
import { createHoldService } from './services/holdService';
import { createOutboxAdminService } from './services/outboxAdminService';
import { createPaymentService } from './services/paymentService';
import { createShowService } from './services/showService';
import { createWebhookService } from './services/webhookService';

export interface AppDeps {
  pool: Pool;
  config: ApiConfig;
  logger: Logger;
  /** Defaults to the HTTP client for GATEWAY_URL */
  gateway?: GatewayClient;
  /** For rate limiting and the health check. Null or absent means rate limiting is off. */
  redis?: Redis | null;
}

/** Builds the Express app. Tests call this directly with a test pool. */
export function createApp({ pool, config, logger, gateway, redis = null }: AppDeps): Express {
  const gatewayClient =
    gateway ?? createHttpGatewayClient(config.GATEWAY_URL, config.GATEWAY_TIMEOUT_MS);
  const authenticate = requireAuth(config.JWT_SECRET);

  const limiterRedis = config.RATE_LIMIT_ENABLED ? redis : null;
  const limitAuthByIp = rateLimit({
    redis: limiterRedis,
    name: 'auth',
    limit: config.RATE_LIMIT_AUTH_PER_MINUTE,
    windowSeconds: 60,
    keyOf: (req) => req.ip,
    logger,
  });
  const limitBookingByUser = rateLimit({
    redis: limiterRedis,
    name: 'booking',
    limit: config.RATE_LIMIT_BOOKING_PER_MINUTE,
    windowSeconds: 60,
    keyOf: (req) => req.user?.id,
    logger,
  });

  const authController = createAuthController(createAuthService(pool, config));
  const showController = createShowController(createShowService(pool));
  const holdController = createHoldController(
    createHoldService(pool, config),
    config.MAX_SEATS_PER_HOLD,
  );
  const bookingController = createBookingController(
    createBookingService(pool),
    createPaymentService(pool, config, gatewayClient, logger),
  );
  const webhookController = createWebhookController(
    createWebhookService(pool, config.WEBHOOK_SECRET, logger),
  );
  const adminController = createAdminController(createOutboxAdminService(pool, logger));

  const app = express();
  app.disable('x-powered-by');
  if (config.TRUST_PROXY) app.set('trust proxy', true);
  app.use(requestLogger(logger));
  // Raw body, so it must come before express.json()
  app.use('/api', webhooksRouter(webhookController));
  app.use(express.json({ limit: '100kb' }));

  app.use('/api', healthRouter(pool, redis));
  app.use('/api', authRouter(authController, authenticate, limitAuthByIp));
  app.use('/api', showsRouter(showController, authenticate));
  app.use('/api', holdsRouter(holdController, authenticate, limitBookingByUser));
  app.use('/api', bookingsRouter(bookingController, authenticate, limitBookingByUser));
  app.use('/api', adminRouter(adminController, authenticate));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
