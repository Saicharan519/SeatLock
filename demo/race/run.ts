/**
 * The double-booking bug, and SeatLock's fix, side by side:  npm run demo:race
 *
 * Runs T1's race (1,000 users, 50 seats, user i wants seat i mod 50) three ways against the
 * seatlock_load database (override with RACE_DATABASE_URL), and prints what each customer
 * was told versus what the database actually holds.
 */
import { createPool } from '@seatlock/db';
import { loadApiConfig } from '../../apps/api/src/config/env';
import { raceFixed, raceNaive, type RaceResult } from './race';

const USERS = 1000;
const url =
  process.env.RACE_DATABASE_URL ?? 'postgres://seatlock:seatlock@localhost:5433/seatlock_load';

function row(name: string, r: RaceResult) {
  const confirm = r.confirm
    ? `${r.confirm.confirmed} confirmed, ${r.confirm.rejectedByDatabase} blocked by the database`
    : 'n/a (only winners can pay)';
  return `| ${name.padEnd(36)} | ${String(r.toldTheyHoldASeat).padStart(6)} | ${String(r.seatsActuallyHeld).padStart(6)} | ${String(r.misled).padStart(6)} | ${confirm}`;
}

async function main() {
  const config = { ...loadApiConfig(), HOLD_TTL_SECONDS: 300 };
  const pool = createPool({ connectionString: url, max: 20, acquireTimeoutMs: 60_000 });
  try {
    console.log(`\n${USERS} concurrent holds on 50 seats (pool of 20 connections)\n`);
    console.log(`| ${'implementation'.padEnd(36)} |   told |   held | misled | naive confirm step`);
    console.log(`|${'-'.repeat(38)}|--------|--------|--------|-------------------`);
    console.log(row('naive read-then-write, 20 ms work', await raceNaive(pool, USERS, 20)));
    console.log(row('naive read-then-write, no delay', await raceNaive(pool, USERS, 0)));
    console.log(row('SeatLock (locks + conditional claim)', await raceFixed(pool, USERS, config)));
    console.log(
      '\ntold   = customers told "you hold the seat"\nheld   = seats actually held afterwards\nmisled = customers holding a seat that belongs to someone else\n',
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
