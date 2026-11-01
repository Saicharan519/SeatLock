import express, { type Express } from 'express';
import type { Pool } from 'pg';
import type { Logger } from '@seatlock/shared';
import type { ApiConfig } from './config/env';
import { createAuthController } from './controllers/authController';
import { createShowController } from './controllers/showController';
import { requireAuth } from './middleware/auth';
import { errorHandler, notFound } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { authRouter } from './routes/auth';
import { healthRouter } from './routes/health';
import { showsRouter } from './routes/shows';
import { createAuthService } from './services/authService';
import { createShowService } from './services/showService';

export interface AppDeps {
  pool: Pool;
  config: ApiConfig;
  logger: Logger;
}

/** Builds the Express app. Tests call this directly with a test pool. */
export function createApp({ pool, config, logger }: AppDeps): Express {
  const authenticate = requireAuth(config.JWT_SECRET);
  const authController = createAuthController(createAuthService(pool, config));
  const showController = createShowController(createShowService(pool));

  const app = express();
  app.disable('x-powered-by');
  app.use(requestLogger(logger));
  app.use(express.json({ limit: '100kb' }));

  app.use('/api', healthRouter(pool));
  app.use('/api', authRouter(authController, authenticate));
  app.use('/api', showsRouter(showController, authenticate));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
