import type { Pool } from 'pg';
import { pruneOldShows, seedCatalog, withTransaction } from '@seatlock/db';

/**
 * Keeps a long-running demo bookable and small: tops up showtimes for the next `days` days
 * (idempotent; existing slots are skipped) and deletes old shows that were never booked.
 * Returns the number of shows added plus removed.
 */
export async function maintainCatalog(pool: Pool, days: number): Promise<number> {
  const added = await withTransaction(pool, async (client) => {
    const result = await seedCatalog(client, { days });
    return result.showsCreated;
  });
  const removed = await withTransaction(pool, (client) => pruneOldShows(client));
  return added + removed;
}
