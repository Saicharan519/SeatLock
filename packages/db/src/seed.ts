import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { baseEnvSchema, loadEnv } from '@seatlock/shared';
import { createPool } from './pool';
import { insertSeatsForShow } from './seats';
import { withTransaction } from './transaction';

/**
 * Creates the admin user and a sample show with its 50 seats.
 * Safe to run repeatedly: the admin is upserted and the sample show is created once.
 */
const env = loadEnv(
  baseEnvSchema.extend({
    SEED_ADMIN_EMAIL: z.email().default('admin@seatlock.local'),
    SEED_ADMIN_PASSWORD: z.string().min(8).default('admin12345'),
  }),
);

const SAMPLE_SHOW_TITLE = 'Interstellar (Re-release)';

async function main() {
  const pool = createPool({ connectionString: env.DATABASE_URL, max: 2, acquireTimeoutMs: 10000 });
  try {
    await withTransaction(pool, async (client) => {
      const passwordHash = await bcrypt.hash(env.SEED_ADMIN_PASSWORD, 10);
      await client.query(
        `INSERT INTO users (name, email, password_hash, role) VALUES ('Admin', $1, $2, 'ADMIN')
         ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'ADMIN'`,
        [env.SEED_ADMIN_EMAIL.toLowerCase(), passwordHash],
      );

      const existing = await client.query(`SELECT id FROM shows WHERE title = $1`, [
        SAMPLE_SHOW_TITLE,
      ]);
      if (existing.rowCount === 0) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO shows (title, description, venue, starts_at, price_per_seat)
           VALUES ($1, 'IMAX re-release', 'PVR Forum, Hall 3', now() + interval '7 days', 25000)
           RETURNING id`,
          [SAMPLE_SHOW_TITLE],
        );
        await insertSeatsForShow(client, rows[0]!.id);
        console.log(`Created sample show ${rows[0]!.id} with 50 seats`);
      } else {
        console.log('Sample show already exists');
      }
    });
    console.log(`Admin user ready: ${env.SEED_ADMIN_EMAIL}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
