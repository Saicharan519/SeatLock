import type { Pool } from 'pg';
import { cleanupIdempotencyKeys } from '../../apps/worker/src/jobs/cleanupIdempotencyKeys';
import { expireHolds } from '../../apps/worker/src/jobs/expireHolds';
import { sweepStuckPayments } from '../../apps/worker/src/jobs/sweepStuckPayments';
import { createTestApp } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { deliverEvent, gatewayEvent, pendingPayment } from '../helpers/webhooks';

const FIFTEEN_MINUTES = 900;

describe('worker sweeps (PRD 9.4)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    pool = createTestPool(10);
    app = createTestApp(pool, { HOLD_TTL_SECONDS: 300 });
  });
  afterAll(() => pool.end());
  beforeEach(() => resetDatabase(pool));

  const paymentStatus = async (id: string) =>
    (await pool.query(`SELECT status FROM payments WHERE id = $1`, [id])).rows[0].status;
  const startedMinutesAgo = (paymentId: string, minutes: number) =>
    pool.query(`UPDATE payments SET created_at = now() - make_interval(mins => $2) WHERE id = $1`, [
      paymentId,
      minutes,
    ]);

  test('only payments INITIATED for over 15 minutes are failed', async () => {
    const stuck = await pendingPayment(pool, app);
    const recent = await pendingPayment(pool, app, ['B1']);
    const paid = await pendingPayment(pool, app, ['C1']);
    await deliverEvent(app, gatewayEvent('payment.succeeded', paid.paymentId, { amount: 20000 }));
    await startedMinutesAgo(stuck.paymentId, 16);
    await startedMinutesAgo(recent.paymentId, 14);
    await startedMinutesAgo(paid.paymentId, 60);

    expect(await sweepStuckPayments(pool, FIFTEEN_MINUTES)).toBe(1);
    expect(await paymentStatus(stuck.paymentId)).toBe('FAILED');
    expect(await paymentStatus(recent.paymentId)).toBe('INITIATED');
    expect(await paymentStatus(paid.paymentId)).toBe('SUCCESS');
    expect(await sweepStuckPayments(pool, FIFTEEN_MINUTES)).toBe(0);
  });

  test('T17: a swept payment that later succeeds is refunded, and the booking is left alone', async () => {
    // Ambiguous gateway outcome, no webhook: the hold expires, then the sweep fails the payment
    const { showId, bookingId, paymentId } = await pendingPayment(pool, app);
    await pool.query(
      `UPDATE bookings SET expires_at = now() - interval '10 minutes' WHERE id = $1`,
      [bookingId],
    );
    await expireHolds(pool);
    await startedMinutesAgo(paymentId, 16);
    await sweepStuckPayments(pool, FIFTEEN_MINUTES);
    expect(await paymentStatus(paymentId)).toBe('FAILED');

    // ...and then the success webhook finally arrives. The customer WAS charged.
    const res = await deliverEvent(app, gatewayEvent('payment.succeeded', paymentId));
    expect(res.body.result).toBe('refund_required');

    const { rows } = await pool.query(
      `SELECT b.status AS booking, p.status AS payment,
              (SELECT json_agg(status ORDER BY id) FROM seats WHERE show_id = $2 AND seat_label IN ('A1','A2')) AS seats,
              (SELECT json_agg(event_type) FROM outbox_events) AS events
       FROM bookings b JOIN payments p ON p.booking_id = b.id WHERE b.id = $1`,
      [bookingId, showId],
    );
    // No re-claim for a FAILED payment: booking and seats exactly as the expiry left them
    expect(rows[0]).toEqual({
      booking: 'EXPIRED',
      payment: 'REFUND_REQUIRED',
      seats: ['AVAILABLE', 'AVAILABLE'],
      events: ['RefundRequired'],
    });
  });

  test('expired idempotency keys are deleted, live ones kept', async () => {
    await pendingPayment(pool, app); // creates two keys (hold and pay)
    await pool.query(
      `UPDATE idempotency_keys SET expires_at = now() - interval '1 second'
       WHERE id = (SELECT min(id) FROM idempotency_keys)`,
    );
    expect(await cleanupIdempotencyKeys(pool)).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM idempotency_keys`)).rows[0].n).toBe(1);
  });
});
