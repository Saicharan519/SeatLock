import type { Pool } from 'pg';
import { insertSeatsForShow, withTransaction } from '@seatlock/db';
import { signToken } from '../../apps/api/src/utils/jwt';

let counter = 0;

/** Inserts a user directly (no bcrypt cost) and returns a valid JWT for them. */
export async function createUser(pool: Pool, role: 'USER' | 'ADMIN' = 'USER') {
  counter += 1;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, 'not-a-real-hash', $3) RETURNING id`,
    [`User ${counter}`, `user${counter}-${Date.now()}@test.local`, role],
  );
  const id = rows[0]!.id;
  return { id, token: signToken({ id, role }, process.env.JWT_SECRET!) };
}

/** Inserts a show and its 50 seats. Defaults to one day in the future. */
export async function createShow(
  pool: Pool,
  opts: { startsAt?: Date; pricePerSeat?: number; title?: string } = {},
) {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO shows (title, venue, starts_at, price_per_seat) VALUES ($1, 'Test Hall', $2, $3) RETURNING id`,
      [
        opts.title ?? 'Test Show',
        opts.startsAt ?? new Date(Date.now() + 86_400_000),
        opts.pricePerSeat ?? 20000,
      ],
    );
    const showId = rows[0]!.id;
    await insertSeatsForShow(client, showId);
    return showId;
  });
}

/**
 * Puts seats on hold for a user directly in the database, bypassing the hold API.
 * expiresInSeconds may be negative to simulate a stale hold the worker hasn't swept.
 */
export async function holdSeatsDirectly(
  pool: Pool,
  {
    userId,
    showId,
    labels,
    expiresInSeconds,
  }: {
    userId: string;
    showId: string;
    labels: string[];
    expiresInSeconds: number;
  },
) {
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO bookings (user_id, show_id, status, expires_at)
       VALUES ($1, $2, 'PENDING', now() + make_interval(secs => $3)) RETURNING id`,
      [userId, showId, expiresInSeconds],
    );
    const bookingId = rows[0]!.id;
    await client.query(
      `UPDATE seats SET status = 'HELD', booking_id = $1 WHERE show_id = $2 AND seat_label = ANY($3)`,
      [bookingId, showId, labels],
    );
    return bookingId;
  });
}
