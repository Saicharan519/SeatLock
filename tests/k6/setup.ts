/**
 * Prepares the load-test database and the data k6 needs. Run before each k6 run:
 *
 *   LOAD_DATABASE_URL=postgres://seatlock:seatlock@localhost:5433/seatlock_load \
 *   JWT_SECRET=... npx tsx tests/k6/setup.ts
 *
 * - Empties every table in the LOAD database (never the dev or test database).
 * - Creates two shows of 50 seats: one for the spike, one for the steady run.
 * - Creates 1,000 users and pre-generates a JWT for each (PRD 13: no login traffic in the
 *   measurement), written to tests/k6/data/fixture.json (git-ignored).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createPool, createStandardShow, withTransaction } from '@seatlock/db';
import { signToken } from '../../apps/api/src/utils/jwt';

const USERS = 1000;
const url = process.env.LOAD_DATABASE_URL;
const secret = process.env.JWT_SECRET;
if (!url || !/seatlock_load/.test(url)) {
  console.error('LOAD_DATABASE_URL must point at the seatlock_load database');
  process.exit(1);
}
if (!secret) {
  console.error('JWT_SECRET is required (the same one the API under test uses)');
  process.exit(1);
}

async function main() {
  const pool = createPool({ connectionString: url!, max: 2, acquireTimeoutMs: 10_000 });
  try {
    await pool.query(
      `TRUNCATE notifications, outbox_events, webhook_events, idempotency_keys, payments,
                booking_items, seats, show_prices, bookings, shows, screens, theatres, movies,
                users RESTART IDENTITY CASCADE`,
    );
    const createShow = (title: string) =>
      withTransaction(pool, (client) => createStandardShow(client, { title, price: 25000 }));
    const spikeShowId = await createShow('Spike (scenario A)');
    const steadyShowId = await createShow('Steady (scenario B)');

    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO users (name, email, password_hash)
       SELECT 'Load ' || g, 'load' || g || '@load.test', 'not-a-real-hash'
       FROM generate_series(1, $1) g ORDER BY g RETURNING id`,
      [USERS],
    );
    const tokens = rows.map(({ id }) => signToken({ id, role: 'USER' }, secret!));

    const dir = path.join(__dirname, 'data');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'fixture.json'),
      JSON.stringify({ spikeShowId, steadyShowId, tokens }),
    );
    console.log(`fixture ready: 2 shows, ${tokens.length} users with tokens`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
