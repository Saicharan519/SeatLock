import type { Pool } from 'pg';
import { afterCommit, releaseHeldSeatsOfBookings, withTransaction } from '@seatlock/db';
import type { Logger } from '@seatlock/shared';

const BATCH_SIZE = 100;

/**
 * PRD 9.4. Marks overdue PENDING bookings EXPIRED and releases their seats.
 *
 * Safe with several workers: FOR UPDATE SKIP LOCKED means each worker claims a different
 * batch, and a booking locked by an in-flight hold or webhook is skipped, not waited on.
 *
 * Returns the number of bookings expired. With a logger, each committed transition is logged.
 */
export async function expireHolds(
  pool: Pool,
  batchSize = BATCH_SIZE,
  logger?: Logger,
): Promise<number> {
  let total = 0;
  for (;;) {
    const expired = await withTransaction(pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM bookings
         WHERE status = 'PENDING' AND expires_at < now()
         ORDER BY id
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [batchSize],
      );
      const ids = rows.map((r) => r.id);
      if (ids.length === 0) return 0;

      // Guarded: a booking confirmed at the same instant no longer matches status = 'PENDING'
      const { rows: changed } = await client.query<{ id: string }>(
        `UPDATE bookings SET status = 'EXPIRED', updated_at = now()
         WHERE id = ANY($1::uuid[]) AND status = 'PENDING'
         RETURNING id`,
        [ids],
      );
      // Locks seats in id order, then releases only seats still owned by these bookings.
      // A seat another hold already took over has a different booking_id and is untouched.
      await releaseHeldSeatsOfBookings(client, ids);
      afterCommit(client, () => {
        for (const { id } of changed) {
          logger?.info(
            { entity: 'booking', id, from: 'PENDING', to: 'EXPIRED' },
            'state transition',
          );
        }
      });
      return ids.length;
    });
    total += expired;
    if (expired < batchSize) return total;
  }
}
