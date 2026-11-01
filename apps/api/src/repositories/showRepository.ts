import type { PoolClient } from 'pg';
import type { Queryable } from '@seatlock/db';

export interface ShowRow {
  id: string;
  title: string;
  description: string;
  venue: string;
  starts_at: Date;
  price_per_seat: number;
  created_at: Date;
}

export type SeatDisplayStatus = 'AVAILABLE' | 'HELD' | 'BOOKED';

export async function insertShow(
  client: PoolClient,
  input: {
    title: string;
    description: string;
    venue: string;
    startsAt: Date;
    pricePerSeat: number;
  },
): Promise<ShowRow> {
  const { rows } = await client.query<ShowRow>(
    `INSERT INTO shows (title, description, venue, starts_at, price_per_seat)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.title, input.description, input.venue, input.startsAt, input.pricePerSeat],
  );
  return rows[0]!;
}

export async function listUpcomingShows(db: Queryable): Promise<ShowRow[]> {
  const { rows } = await db.query<ShowRow>(
    `SELECT * FROM shows WHERE starts_at > now() ORDER BY starts_at, id`,
  );
  return rows;
}

export async function findShowById(db: Queryable, id: string): Promise<ShowRow | undefined> {
  const { rows } = await db.query<ShowRow>(`SELECT * FROM shows WHERE id = $1`, [id]);
  return rows[0];
}

/**
 * Seat-map read rule (PRD section 10): a seat is shown HELD only if its booking is
 * PENDING and not yet expired. A stale hold the worker hasn't swept yet shows AVAILABLE.
 * Uses the database clock (R5).
 */
export async function getSeatMap(
  db: Queryable,
  showId: string,
): Promise<{ label: string; status: SeatDisplayStatus }[]> {
  const { rows } = await db.query<{ label: string; status: SeatDisplayStatus }>(
    `SELECT s.seat_label AS label,
            CASE
              WHEN s.status = 'BOOKED' THEN 'BOOKED'
              WHEN s.status = 'HELD' AND b.status = 'PENDING' AND b.expires_at > now() THEN 'HELD'
              ELSE 'AVAILABLE'
            END AS status
     FROM seats s
     LEFT JOIN bookings b ON b.id = s.booking_id
     WHERE s.show_id = $1
     ORDER BY s.id`,
    [showId],
  );
  return rows;
}
