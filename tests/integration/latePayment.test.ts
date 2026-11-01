import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Pool } from 'pg';
import { releaseHeldSeatsOfBookings } from '@seatlock/db';
import { expireHolds } from '../../apps/worker/src/jobs/expireHolds';
import { createTestApp, waitFor } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createShow, createUser } from '../helpers/factories';
import { deliverEvent, gatewayEvent, pendingPayment } from '../helpers/webhooks';

/** S6: the payment arrives after the hold expired (PRD 9.3 late path). */
describe('late payments (FR-12)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    pool = createTestPool(10);
    app = createTestApp(pool, { HOLD_TTL_SECONDS: 300 });
  });
  afterAll(() => pool.end());
  beforeEach(() => resetDatabase(pool));

  const succeed = (paymentId: string) =>
    deliverEvent(app, gatewayEvent('payment.succeeded', paymentId));
  const expireNow = (bookingId: string) =>
    pool.query(`UPDATE bookings SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      bookingId,
    ]);
  const holdAs = (token: string, showId: string, seats: string[]) =>
    request(app)
      .post('/api/holds')
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ showId, seats });

  /** Everything about one booking and its seats, for consistency checks. */
  async function snapshot(bookingId: string, showId: string) {
    const { rows } = await pool.query(
      `SELECT b.status AS booking, p.status AS payment,
              (SELECT count(*)::int FROM booking_items WHERE booking_id = b.id AND is_confirmed) AS confirmed_items,
              (SELECT count(*)::int FROM booking_items i JOIN seats s ON s.id = i.seat_id
                 WHERE s.show_id = $2 AND i.is_confirmed) AS all_confirmed_items,
              (SELECT json_object_agg(seat_label, json_build_object(
                        'status', status,
                        -- IS NOT DISTINCT FROM: plain = gives NULL, not false, for a NULL booking_id
                        'mine', booking_id IS NOT DISTINCT FROM b.id))
                 FROM seats WHERE show_id = $2 AND seat_label IN ('A1', 'A2')) AS seats,
              (SELECT json_agg(event_type ORDER BY id) FROM outbox_events) AS events
       FROM bookings b JOIN payments p ON p.booking_id = b.id WHERE b.id = $1`,
      [bookingId, showId],
    );
    return rows[0];
  }

  test('T8: late success, seats still free after the worker expired the hold: confirmed', async () => {
    const { showId, bookingId, paymentId } = await pendingPayment(pool, app);
    await expireNow(bookingId);
    expect(await expireHolds(pool)).toBe(1);
    expect((await snapshot(bookingId, showId)).booking).toBe('EXPIRED');

    const res = await succeed(paymentId);
    expect(res.body.result).toBe('confirmed_late');
    expect(await snapshot(bookingId, showId)).toEqual({
      booking: 'CONFIRMED',
      payment: 'SUCCESS',
      confirmed_items: 2,
      all_confirmed_items: 2,
      seats: { A1: { status: 'BOOKED', mine: true }, A2: { status: 'BOOKED', mine: true } },
      events: ['BookingConfirmed'],
    });
  });

  test('T8 variant: late success before the worker ran (booking still PENDING): confirmed', async () => {
    const { showId, bookingId, paymentId } = await pendingPayment(pool, app);
    await expireNow(bookingId);

    expect((await succeed(paymentId)).body.result).toBe('confirmed_late');
    expect(await snapshot(bookingId, showId)).toMatchObject({
      booking: 'CONFIRMED',
      seats: { A1: { status: 'BOOKED', mine: true }, A2: { status: 'BOOKED', mine: true } },
    });
    // The worker now has nothing to do
    expect(await expireHolds(pool)).toBe(0);
  });

  test('T9: late success, one seat taken by another user: refund, nothing else changes', async () => {
    const { showId, bookingId, paymentId } = await pendingPayment(pool, app);
    await expireNow(bookingId);
    await expireHolds(pool);
    const priya = await createUser(pool);
    expect((await holdAs(priya.token, showId, ['A2'])).status).toBe(201);
    const before = await snapshot(bookingId, showId);

    expect((await succeed(paymentId)).body.result).toBe('refund_required');
    const after = await snapshot(bookingId, showId);
    expect(after).toEqual({
      ...before,
      payment: 'REFUND_REQUIRED',
      events: ['RefundRequired'],
    });
    // Spelled out: no seat changed, no confirmed flag anywhere, no partial confirm
    expect(after.booking).toBe('EXPIRED');
    expect(after.seats).toEqual({
      A1: { status: 'AVAILABLE', mine: false },
      A2: { status: 'HELD', mine: false },
    });
    expect(after.all_confirmed_items).toBe(0);
  });

  test('T9 variant: the booking still PENDING when a seat is gone: it expires and frees what it held', async () => {
    const { showId, bookingId, paymentId } = await pendingPayment(pool, app);
    await expireNow(bookingId);
    // Priya takes over A2 from the stale hold before the worker runs
    const priya = await createUser(pool);
    expect((await holdAs(priya.token, showId, ['A2'])).status).toBe(201);

    expect((await succeed(paymentId)).body.result).toBe('refund_required');
    expect(await snapshot(bookingId, showId)).toMatchObject({
      booking: 'EXPIRED',
      payment: 'REFUND_REQUIRED',
      all_confirmed_items: 0,
      // A1 was still ours and is released; A2 stays Priya's
      seats: { A1: { status: 'AVAILABLE', mine: false }, A2: { status: 'HELD', mine: false } },
    });
  });

  test("a seat under someone else's EXPIRED hold is re-claimable", async () => {
    const { showId, bookingId, paymentId } = await pendingPayment(pool, app);
    await expireNow(bookingId);
    await expireHolds(pool);
    // Priya holds A2, then her hold also expires (not yet swept)
    const priya = await createUser(pool);
    const hers = (await holdAs(priya.token, showId, ['A2'])).body.bookingId;
    await expireNow(hers);

    expect((await succeed(paymentId)).body.result).toBe('confirmed_late');
    expect((await snapshot(bookingId, showId)).seats).toEqual({
      A1: { status: 'BOOKED', mine: true },
      A2: { status: 'BOOKED', mine: true },
    });
    // When the worker sweeps Priya's hold, it must not touch the seat we now own
    expect(await expireHolds(pool)).toBe(1);
    expect((await snapshot(bookingId, showId)).seats.A2).toEqual({ status: 'BOOKED', mine: true });
  });

  describe('T14: webhook confirmation races worker expiry', () => {
    /** Waits until some backend is blocked on a lock: proof the interleaving happened. */
    const waitForLockWaiter = () =>
      waitFor(async () => {
        const { rows } = await pool.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        return rows[0].n > 0;
      });

    test('worker locks the booking first: the webhook waits, then takes the late path', async () => {
      const { showId, bookingId, paymentId } = await pendingPayment(pool, app);
      await expireNow(bookingId);

      // Play the worker by hand so it can be paused mid-transaction
      const worker = await pool.connect();
      try {
        await worker.query('BEGIN');
        await worker.query(`SELECT id FROM bookings WHERE id = $1 FOR UPDATE`, [bookingId]);

        const webhook = succeed(paymentId).then((r) => r); // starts the request
        await waitForLockWaiter(); // the webhook is now blocked on the booking row

        await worker.query(
          `UPDATE bookings SET status = 'EXPIRED' WHERE id = $1 AND status = 'PENDING'`,
          [bookingId],
        );
        await releaseHeldSeatsOfBookings(worker, [bookingId]);
        await worker.query('COMMIT');

        expect((await webhook).body.result).toBe('confirmed_late');
      } finally {
        worker.release();
      }
      expect(await snapshot(bookingId, showId)).toMatchObject({
        booking: 'CONFIRMED',
        payment: 'SUCCESS',
        confirmed_items: 2,
        seats: { A1: { status: 'BOOKED', mine: true }, A2: { status: 'BOOKED', mine: true } },
      });
    });

    test('webhook locks the booking first: the worker skips it, then the webhook confirms', async () => {
      const { showId, bookingId, paymentId } = await pendingPayment(pool, app);
      await expireNow(bookingId);

      // Hold a seat lock so the webhook stalls after locking the booking and payment
      const blocker = await pool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          `SELECT id FROM seats WHERE show_id = $1 AND seat_label = 'A1' FOR UPDATE`,
          [showId],
        );

        const webhook = succeed(paymentId).then((r) => r);
        await waitForLockWaiter();

        // SKIP LOCKED: the worker doesn't wait for the webhook and doesn't touch the booking
        expect(await expireHolds(pool)).toBe(0);

        await blocker.query('ROLLBACK');
        expect((await webhook).body.result).toBe('confirmed_late');
      } finally {
        blocker.release();
      }
      expect(await expireHolds(pool)).toBe(0);
      expect(await snapshot(bookingId, showId)).toMatchObject({
        booking: 'CONFIRMED',
        seats: { A1: { status: 'BOOKED', mine: true }, A2: { status: 'BOOKED', mine: true } },
      });
    });

    test('webhook, worker and a competing hold all at once, 20 times: always one consistent outcome', async () => {
      const outcomes = { confirmed: 0, refunded: 0 };
      for (let i = 0; i < 20; i++) {
        const showId = await createShow(pool, { pricePerSeat: 20000 });
        const { bookingId, paymentId } = await pendingPayment(pool, app, ['A1', 'A2'], showId);
        await expireNow(bookingId);
        const rival = await createUser(pool);
        const jitter = () => new Promise((r) => setTimeout(r, Math.random() * 15));

        const [webhook, , rivalHold] = await Promise.all([
          jitter().then(() => succeed(paymentId)),
          jitter().then(() => expireHolds(pool)),
          jitter().then(() => holdAs(rival.token, showId, ['A2'])),
        ]);
        const s = await snapshot(bookingId, showId);

        if (s.booking === 'CONFIRMED') {
          // We won: every seat ours and BOOKED, paid, rival refused
          outcomes.confirmed += 1;
          expect(webhook.body.result).toBe('confirmed_late');
          expect(s).toMatchObject({ payment: 'SUCCESS', confirmed_items: 2 });
          expect(s.seats).toEqual({
            A1: { status: 'BOOKED', mine: true },
            A2: { status: 'BOOKED', mine: true },
          });
          expect(rivalHold.status).toBe(409);
        } else {
          // The rival won A2: we own nothing, nothing is confirmed, money goes back
          outcomes.refunded += 1;
          expect({ status: webhook.status, body: webhook.body }).toEqual({
            status: 200,
            body: { received: true, result: 'refund_required' },
          });
          expect(s).toMatchObject({
            booking: 'EXPIRED',
            payment: 'REFUND_REQUIRED',
            all_confirmed_items: 0,
          });
          expect(s.seats).toEqual({
            A1: { status: 'AVAILABLE', mine: false },
            A2: { status: 'HELD', mine: false },
          });
          expect(rivalHold.status).toBe(201);
        }
      }
      // Both outcomes are legitimate; this documents which ones happened
      expect(outcomes.confirmed + outcomes.refunded).toBe(20);
    }, 60_000);
  });
});
