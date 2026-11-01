import { Router } from 'express';
import type { Pool } from 'pg';
import type { Redis } from '@seatlock/shared';

/**
 * Database down -> 503: the API can't serve anything.
 * Redis down -> 200 "degraded": everything still works, only rate limiting is off (fail open).
 */
export function healthRouter(pool: Pool, redis: Redis | null): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const [db, cache] = await Promise.all([
      pool
        .query('SELECT 1')
        .then(() => 'up' as const)
        .catch(() => 'down' as const),
      redis
        ? redis
            .ping()
            .then(() => 'up' as const)
            .catch(() => 'down' as const)
        : Promise.resolve('disabled' as const),
    ]);
    const status = db === 'down' ? 'down' : cache === 'down' ? 'degraded' : 'ok';
    res.status(db === 'up' ? 200 : 503).json({ status, db, redis: cache });
  });

  return router;
}
