import type { Pool } from 'pg';
import { createPool } from '@seatlock/db';

export function createTestPool(max = 20): Pool {
  return createPool({ connectionString: process.env.DATABASE_URL!, max, acquireTimeoutMs: 60000 });
}

const TABLES = [
  'notifications',
  'outbox_events',
  'webhook_events',
  'idempotency_keys',
  'payments',
  'booking_items',
  'seats',
  'show_prices',
  'bookings',
  'shows',
  'screens',
  'theatres',
  'movies',
  'users',
];

/**
 * Empties every table. In end-to-end tests a webhook from the previous test can still be
 * in flight; if TRUNCATE collides with it, Postgres reports a deadlock and we retry.
 */
export async function resetDatabase(pool: Pool): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== '40P01' || attempt >= 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
