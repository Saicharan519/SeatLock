import { loadEnv, baseEnvSchema } from '@seatlock/shared';
import { createPool } from './pool';

/**
 * Development helper: prints what the database knows about the most recent booking,
 * so you can watch a booking move through its states while you click through the UI.
 *
 *   npm run db:peek
 */
const env = loadEnv(baseEnvSchema);

async function main() {
  const pool = createPool({ connectionString: env.DATABASE_URL, max: 1, acquireTimeoutMs: 5000 });
  try {
    const seatSummary = await pool.query<{ status: string; count: string }>(
      `SELECT s.status, count(*) FROM seats s
       JOIN shows sh ON sh.id = s.show_id
       WHERE sh.starts_at > now()
       GROUP BY s.status ORDER BY s.status`,
    );
    console.log('\nSeats in upcoming shows:');
    console.table(seatSummary.rows);

    const booking = await pool.query(
      `SELECT b.id, u.email, b.status, b.total_amount AS paise,
              b.expires_at, (b.expires_at > now()) AS hold_still_live, b.created_at
       FROM bookings b JOIN users u ON u.id = b.user_id
       ORDER BY b.created_at DESC LIMIT 1`,
    );
    if (booking.rowCount === 0) {
      console.log('No bookings yet. Hold some seats in the UI, then run this again.');
      return;
    }
    const b = booking.rows[0];
    console.log('\nLatest booking (a hold is a PENDING booking):');
    console.table([b]);

    const seats = await pool.query(
      `SELECT s.seat_label, s.status AS seat_status, (s.booking_id = $1) AS owned_by_this_booking,
              bi.price AS price_paise, bi.is_confirmed
       FROM booking_items bi JOIN seats s ON s.id = bi.seat_id
       WHERE bi.booking_id = $1 ORDER BY s.id`,
      [b.id],
    );
    console.log('Its seats:');
    console.table(seats.rows);

    const payment = await pool.query(
      `SELECT id, status, amount AS paise, provider_reference, refund_reference, created_at
       FROM payments WHERE booking_id = $1`,
      [b.id],
    );
    console.log('Its payment:');
    if (payment.rowCount === 0) console.log('  none yet (you have not clicked Pay)');
    else console.table(payment.rows);

    const webhooks = await pool.query(
      `SELECT provider_event_id, event_type, received_at FROM webhook_events
       WHERE payload->'data'->>'paymentId' = $1 ORDER BY received_at`,
      [payment.rows[0]?.id ?? null],
    );
    console.log('Webhooks received from the gateway for that payment:');
    if (webhooks.rowCount === 0) console.log('  none');
    else console.table(webhooks.rows);

    const outbox = await pool.query(
      `SELECT o.id, o.event_type, o.status, o.retry_count, o.published_at,
              (n.id IS NOT NULL) AS notification_written
       FROM outbox_events o LEFT JOIN notifications n ON n.event_id = o.id
       WHERE o.aggregate_id IN ($1, $2)
       ORDER BY o.id`,
      [b.id, payment.rows[0]?.id ?? b.id],
    );
    console.log('Outbox events for this booking (delivered by the worker):');
    if (outbox.rowCount === 0) console.log('  none');
    else console.table(outbox.rows);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('peek failed:', err);
  process.exit(1);
});
