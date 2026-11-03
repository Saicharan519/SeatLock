import type { Pool } from 'pg';
import { withTransaction } from '@seatlock/db';
import { SEED_MOVIES, istDate, seedCatalog } from '../../packages/db/src/seedCatalog';
import { createTestPool, resetDatabase } from '../helpers/db';

/** The demo catalogue must stay bookable on any day the seed is run (fresh-install demo). */
describe('rolling demo seed', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createTestPool(2);
  });
  afterAll(() => pool.end());
  beforeEach(() => resetDatabase(pool));

  const count = async (sql: string) => (await pool.query(sql)).rows[0].n as number;

  test('creates the catalogue with showtimes only in the future, and is idempotent', async () => {
    const first = await withTransaction(pool, (c) => seedCatalog(c, { days: 2 }));
    expect(first.movies).toBe(SEED_MOVIES.length);
    expect(first.showsCreated).toBeGreaterThan(0);
    expect(await count(`SELECT count(*)::int AS n FROM shows WHERE starts_at <= now()`)).toBe(0);
    // Every seat of every show has a priced category
    expect(
      await count(
        `SELECT count(*)::int AS n FROM seats s
         LEFT JOIN show_prices p ON p.show_id = s.show_id AND p.category = s.category
         WHERE p.price IS NULL`,
      ),
    ).toBe(0);

    const again = await withTransaction(pool, (c) => seedCatalog(c, { days: 2 }));
    expect(again.showsCreated).toBe(0);
    expect(again.showsSkipped).toBe(first.showsCreated);
    expect(await count(`SELECT count(*)::int AS n FROM movies`)).toBe(SEED_MOVIES.length);
  });

  test('re-running on a later day tops up showtimes for the new days', async () => {
    const now = new Date();
    await withTransaction(pool, (c) => seedCatalog(c, { now, days: 1 }));
    const days = async () =>
      (
        await pool.query<{ d: string }>(
          `SELECT DISTINCT to_char((starts_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS d
           FROM shows ORDER BY d`,
        )
      ).rows.map((r) => r.d);
    const before = await days();

    const tomorrow = new Date(now.getTime() + 86_400_000);
    const later = await withTransaction(pool, (c) => seedCatalog(c, { now: tomorrow, days: 2 }));
    expect(later.showsCreated).toBeGreaterThan(0);
    const after = await days();
    expect(after).toContain(istDate(new Date(now.getTime() + 2 * 86_400_000)));
    expect(after.length).toBeGreaterThan(before.length);
  });
});
