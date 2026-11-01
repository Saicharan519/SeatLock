import { Pool } from 'pg';

export interface PoolOptions {
  connectionString: string;
  max: number;
  /** How long a request may wait for a free connection. Generous so T1's queue drains as 409s, not pool errors (R6). */
  acquireTimeoutMs: number;
}

/**
 * Every connection gets statement_timeout = 5 s and lock_timeout = 3 s (R6),
 * so no request can hang indefinitely on a lock.
 */
export function createPool({ connectionString, max, acquireTimeoutMs }: PoolOptions): Pool {
  return new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: acquireTimeoutMs,
    statement_timeout: 5000,
    lock_timeout: 3000,
    // Fail fast instead of leaving a session idle inside an open transaction
    idle_in_transaction_session_timeout: 10000,
  });
}
