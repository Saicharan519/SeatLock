import type { Pool } from 'pg';
import { createLogger } from '@seatlock/shared';
import { createApp } from '../../apps/api/src/app';
import { loadApiConfig } from '../../apps/api/src/config/env';

export function createTestApp(pool: Pool) {
  return createApp({ pool, config: loadApiConfig(), logger: createLogger('api-test', 'silent') });
}
