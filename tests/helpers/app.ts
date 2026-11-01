import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { createLogger } from '@seatlock/shared';
import { createApp } from '../../apps/api/src/app';
import { loadApiConfig, type ApiConfig } from '../../apps/api/src/config/env';

/** Test env uses HOLD_TTL_SECONDS = 5 so expiry tests are fast; override per test file. */
export function createTestApp(pool: Pool, overrides: Partial<ApiConfig> = {}) {
  return createApp({
    pool,
    config: { ...loadApiConfig(), ...overrides },
    logger: createLogger('api-test', 'silent'),
  });
}

/**
 * A single listening server for concurrency tests. Passing the app itself to supertest
 * starts a new server per request, which is wasteful with 1,000 concurrent requests.
 *
 * The backlog is raised from Node's default (511) so simultaneous connections queue
 * in the kernel instead of being refused before the app ever sees them.
 */
export function startTestServer(pool: Pool, overrides: Partial<ApiConfig> = {}): Promise<Server> {
  return new Promise((resolve) => {
    const server = createTestApp(pool, overrides).listen(0, '127.0.0.1', 4096, () =>
      resolve(server),
    );
  });
}

export function stopServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
