import type { PoolClient } from 'pg';

export const SEAT_ROWS = ['A', 'B', 'C', 'D', 'E'] as const;
export const SEATS_PER_ROW = 10;

/** A1..A10, B1..B10, ... E10. Order matters: seat ids ascend in this order. */
export function seatLabels(): string[] {
  return SEAT_ROWS.flatMap((row) =>
    Array.from({ length: SEATS_PER_ROW }, (_, i) => `${row}${i + 1}`),
  );
}

/**
 * Generates a show's 50 seats. Must run in the same transaction that creates the show,
 * so a show never exists without its seats.
 */
export async function insertSeatsForShow(client: PoolClient, showId: string): Promise<number> {
  const result = await client.query(
    `INSERT INTO seats (show_id, seat_label)
     SELECT $1, label FROM unnest($2::text[]) WITH ORDINALITY AS t(label, ord)
     ORDER BY ord`,
    [showId, seatLabels()],
  );
  return result.rowCount ?? 0;
}
