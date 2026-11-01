import { Router } from 'express';
import type { Pool } from 'pg';

export function healthRouter(pool: Pool): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const db = await pool
      .query('SELECT 1')
      .then(() => 'up' as const)
      .catch(() => 'down' as const);
    // Redis reachability is added with rate limiting (Phase 7).
    res.status(db === 'up' ? 200 : 503).json({ status: db === 'up' ? 'ok' : 'degraded', db });
  });

  return router;
}
