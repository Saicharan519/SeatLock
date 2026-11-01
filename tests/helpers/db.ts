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
  'bookings',
  'shows',
  'users',
];

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}
