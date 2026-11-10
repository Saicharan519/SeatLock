import express, { type Express } from 'express';
import type { Pool } from 'pg';
import {
  createCashfreeClient,
  createHttpGatewayClient,
  type GatewayClient,
  type Logger,
  type Redis,
} from '@seatlock/shared';
import type { ApiConfig } from './config/env';
import { createAdminController } from './controllers/adminController';
import { createAdminService } from './services/adminService';
import { createAuthController } from './controllers/authController';
import { createCatalogController } from './controllers/catalogController';
import { createBookingController } from './controllers/bookingController';
import { createHoldController } from './controllers/holdController';
import { createWebhookController } from './controllers/webhookController';
import { requireAuth } from './middleware/auth';
import { clientIp, requireOriginSecret } from './middleware/origin';
import { errorHandler, notFound } from './middleware/errorHandler';
import { rateLimit } from './middleware/rateLimit';
import { requestLogger } from './middleware/requestLogger';
import { adminRouter } from './routes/admin';
import { authRouter } from './routes/auth';
import { catalogRouter } from './routes/catalog';
import { bookingsRouter } from './routes/bookings';
import { healthRouter } from './routes/health';
import { holdsRouter } from './routes/holds';
import { webhooksRouter } from './routes/webhooks';
import { createAuthService } from './services/authService';
import { createCatalogService } from './services/catalogService';
import { createBookingService } from './services/bookingService';
import { createCashfreeService } from './services/cashfreeService';
import { createHoldService } from './services/holdService';
import { createOutboxAdminService } from './services/outboxAdminService';
import { createPaymentService } from './services/paymentService';
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
    keyOf: clientIp(config),
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

  const authController = createAuthController(createAuthService(pool, config), config);
  const catalogController = createCatalogController(
    createCatalogService(pool, { timezone: config.APP_TIMEZONE }),
  );
  const holdController = createHoldController(
    createHoldService(pool, config),
    config.MAX_SEATS_PER_HOLD,
  );
  const webhookService = createWebhookService(pool, config.WEBHOOK_SECRET, logger);
  // Cashfree (sandbox) only when its keys are configured; the simulated gateway is always on
  const cashfreeService =
    config.CASHFREE_APP_ID && config.CASHFREE_SECRET_KEY
      ? createCashfreeService({
          pool,
          cashfree: createCashfreeClient({
            appId: config.CASHFREE_APP_ID,
            secretKey: config.CASHFREE_SECRET_KEY,
            baseUrl: config.CASHFREE_BASE_URL,
          }),
          secretKey: config.CASHFREE_SECRET_KEY,
          apply: webhookService.apply,
          logger,
          notifyUrl:
            config.CASHFREE_NOTIFY_URL ??
            (config.RENDER_EXTERNAL_URL
              ? new URL('/api/webhooks/cashfree', config.RENDER_EXTERNAL_URL).toString()
              : undefined),
          siteUrl: config.SITE_URL,
          customerPhone: config.CASHFREE_CUSTOMER_PHONE,
        })
      : null;
  const bookingController = createBookingController(
    createBookingService(pool),
    createPaymentService(pool, config, gatewayClient, logger, cashfreeService),
    cashfreeService,
  );
  const webhookController = createWebhookController(webhookService, cashfreeService);
  const adminController = createAdminController(
    createOutboxAdminService(pool, logger),
    createAdminService(pool, { timezone: config.APP_TIMEZONE }),
  );

  const app = express();
  app.disable('x-powered-by');
  // Exactly one hop: the proxy directly in front, never a client-supplied chain
  if (config.TRUST_PROXY) app.set('trust proxy', 1);
  app.use(requestLogger(logger));
  // API answers are personal (bookings, holds) or live (seat maps): no shared cache may keep them
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  // Every response is JSON: nothing in it may run, be framed, or be sniffed as another type
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });
  if (config.ORIGIN_SECRET) app.use('/api', requireOriginSecret(config.ORIGIN_SECRET));
  // Raw body, so it must come before express.json()
  app.use('/api', webhooksRouter(webhookController));
  app.use(express.json({ limit: '100kb' }));

  app.use('/api', healthRouter(pool, redis));
  app.use('/api', authRouter(authController, authenticate, limitAuthByIp));
  app.use('/api', catalogRouter(catalogController, authenticate));
  app.use('/api', holdsRouter(holdController, authenticate, limitBookingByUser));
  app.use('/api', bookingsRouter(bookingController, authenticate, limitBookingByUser));
  app.use('/api', adminRouter(adminController, authenticate));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
