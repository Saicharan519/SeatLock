import type { Pool } from 'pg';
import { contendedOrder, insertSeatsForShow, seatLabels, withTransaction } from '@seatlock/db';
import type { ApiConfig } from '../../apps/api/src/config/env';
import { createHoldService } from '../../apps/api/src/services/holdService';
import { naiveConfirmAll, naiveHold } from './naiveHold';

export interface RaceResult {
  /** Users told "you hold the seat" */
  toldTheyHoldASeat: number;
  /** Seats actually HELD afterwards */
  seatsActuallyHeld: number;
  /** Users told they hold a seat that belongs to someone else */
  misled: number;
  /** Naive only: how many of the "winners" could also be confirmed */
  confirm?: { confirmed: number; rejectedByDatabase: number };
}

async function freshShowAndUsers(pool: Pool, users: number) {
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const showId = await withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO shows (title, venue, starts_at, price_per_seat)
       VALUES ('Race demo', 'Demo Hall', now() + interval '1 day', 25000) RETURNING id`,
    );
    await insertSeatsForShow(client, rows[0]!.id);
    return rows[0]!.id;
  });
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash)
     SELECT 'Racer ' || g, 'racer' || g || '-' || $2 || '@demo.test', 'x'
     FROM generate_series(1, $1) g ORDER BY g RETURNING id`,
    [users, run],
  );
  return { showId, userIds: rows.map((r) => r.id) };
}

async function seatsHeld(pool: Pool, showId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM seats WHERE show_id = $1 AND status = 'HELD'`,
    [showId],
  );
  return rows[0]!.n;
}

/**
 * T1's shape: concurrent holds, user i wants seat i mod 50, fired grouped by seat so that
 * requests for the same seat genuinely overlap (see contendedOrder).
 */
export async function raceNaive(pool: Pool, users: number, workMs: number): Promise<RaceResult> {
  const { showId, userIds } = await freshShowAndUsers(pool, users);
  const labels = seatLabels();
  const results = await Promise.all(
    contendedOrder(users).map((i) =>
      naiveHold(pool, { userId: userIds[i]!, showId, label: labels[i % 50]!, workMs }),
    ),
  );
  const winners = results.flatMap((r) =>
    r.outcome === 'held' ? [{ bookingId: r.bookingId!, seatId: r.seatId! }] : [],
  );
  const held = await seatsHeld(pool, showId);
  return {
    toldTheyHoldASeat: winners.length,
    seatsActuallyHeld: held,
    misled: winners.length - held,
    confirm: await naiveConfirmAll(pool, winners),
  };
}

/** The same race through SeatLock's real hold algorithm (PRD 9.1). */
export async function raceFixed(pool: Pool, users: number, config: ApiConfig): Promise<RaceResult> {
  const { showId, userIds } = await freshShowAndUsers(pool, users);
  const labels = seatLabels();
  const holds = createHoldService(pool, config);
  const results = await Promise.all(
    contendedOrder(users).map((i) =>
      holds
        .hold(userIds[i]!, `race-${i}`, { showId, seats: [labels[i % 50]!] })
        .then(() => 'held' as const)
        .catch((err: { code?: string }) => {
          if (err.code === 'SEAT_UNAVAILABLE') return 'unavailable' as const;
          throw err;
        }),
    ),
  );
  const told = results.filter((r) => r === 'held').length;
  const held = await seatsHeld(pool, showId);
  return { toldTheyHoldASeat: told, seatsActuallyHeld: held, misled: told - held };
}
