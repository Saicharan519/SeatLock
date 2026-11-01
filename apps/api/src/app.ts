import express, { type Express } from 'express';
import type { Pool } from 'pg';
import { createHttpGatewayClient, type GatewayClient, type Logger } from '@seatlock/shared';
import type { ApiConfig } from './config/env';
import { createAuthController } from './controllers/authController';
import { createBookingController } from './controllers/bookingController';
import { createHoldController } from './controllers/holdController';
import { createShowController } from './controllers/showController';
import { createWebhookController } from './controllers/webhookController';
import { requireAuth } from './middleware/auth';
import { errorHandler, notFound } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { authRouter } from './routes/auth';
import { bookingsRouter } from './routes/bookings';
import { healthRouter } from './routes/health';
import { holdsRouter } from './routes/holds';
import { showsRouter } from './routes/shows';
import { webhooksRouter } from './routes/webhooks';
import { createAuthService } from './services/authService';
import { createBookingService } from './services/bookingService';
import { createHoldService } from './services/holdService';
import { createPaymentService } from './services/paymentService';
import { createShowService } from './services/showService';
import { createWebhookService } from './services/webhookService';

export interface AppDeps {
  pool: Pool;
  config: ApiConfig;
  logger: Logger;
  /** Defaults to the HTTP client for GATEWAY_URL */
  gateway?: GatewayClient;
}

/** Builds the Express app. Tests call this directly with a test pool. */
export function createApp({ pool, config, logger, gateway }: AppDeps): Express {
  const gatewayClient =
    gateway ?? createHttpGatewayClient(config.GATEWAY_URL, config.GATEWAY_TIMEOUT_MS);
  const authenticate = requireAuth(config.JWT_SECRET);

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

  const app = express();
  app.disable('x-powered-by');
  app.use(requestLogger(logger));
  // Raw body, so it must come before express.json()
  app.use('/api', webhooksRouter(webhookController));
  app.use(express.json({ limit: '100kb' }));

  app.use('/api', healthRouter(pool));
  app.use('/api', authRouter(authController, authenticate));
  app.use('/api', showsRouter(showController, authenticate));
  app.use('/api', holdsRouter(holdController, authenticate));
  app.use('/api', bookingsRouter(bookingController, authenticate));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
