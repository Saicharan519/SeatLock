import type { Pool } from 'pg';
import { loadApiConfig } from '../../apps/api/src/config/env';
import { raceFixed, raceNaive } from '../../demo/race/race';
import { createTestPool, resetDatabase } from '../helpers/db';

/**
 * The bug this project exists to prevent, demonstrated: T1's race against a deliberately
 * naive read-then-write hold, versus SeatLock's real hold algorithm.
 */
describe('naive vs fixed hold under T1 race', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createTestPool(20);
  });
  afterAll(() => pool.end());
  beforeEach(() => resetDatabase(pool));

  test('the naive version oversells; the database still refuses double confirmation', async () => {
    const r = await raceNaive(pool, 1000, 20);

    // Far more customers were told "you hold the seat" than there are seats
    expect(r.seatsActuallyHeld).toBe(50);
    expect(r.toldTheyHoldASeat).toBeGreaterThan(50);
    expect(r.misled).toBe(r.toldTheyHoldASeat - 50);

    // Confirming them all: one_confirmed_per_seat lets exactly one per seat through
    expect(r.confirm).toEqual({ confirmed: 50, rejectedByDatabase: r.toldTheyHoldASeat - 50 });
  }, 120_000);

  test('SeatLock tells exactly 50 customers they hold a seat, and nobody is misled', async () => {
    const r = await raceFixed(pool, 1000, { ...loadApiConfig(), HOLD_TTL_SECONDS: 300 });
    expect(r).toEqual({ toldTheyHoldASeat: 50, seatsActuallyHeld: 50, misled: 0 });
  }, 120_000);
});
