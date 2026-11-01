import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Pool } from 'pg';
import { createTestApp } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createUser } from '../helpers/factories';
import { deliverEvent, gatewayEvent, pendingPayment } from '../helpers/webhooks';

/** S9 / PRD 9.6: whole-booking cancellation of a confirmed booking before the show. */
describe('POST /api/bookings/:id/cancel (FR-17)', () => {
  let pool: Pool;
  let app: ReturnType<typeof createTestApp>;

  beforeAll(() => {
    pool = createTestPool(10);
    app = createTestApp(pool, { HOLD_TTL_SECONDS: 300 });
  });
  afterAll(() => pool.end());
  beforeEach(() => resetDatabase(pool));

  async function confirmedBooking() {
    const p = await pendingPayment(pool, app);
    const res = await deliverEvent(app, gatewayEvent('payment.succeeded', p.paymentId));
    expect(res.body.result).toBe('confirmed');
    return p;
  }
  const cancel = (token: string, bookingId: string) =>
    request(app)
      .post(`/api/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send();

  async function state(bookingId: string, showId: string) {
    const { rows } = await pool.query(
      `SELECT b.status AS booking, p.status AS payment,
              (SELECT json_agg(s.status ORDER BY s.id) FROM seats s
                 WHERE s.show_id = $2 AND s.seat_label IN ('A1', 'A2')) AS seats,
              (SELECT count(*)::int FROM booking_items WHERE booking_id = b.id AND is_confirmed) AS confirmed_items,
              (SELECT json_agg(event_type ORDER BY id) FROM outbox_events) AS events
       FROM bookings b JOIN payments p ON p.booking_id = b.id WHERE b.id = $1`,
      [bookingId, showId],
    );
    return rows[0];
  }

  test('cancels: seats freed, confirmed flag cleared, refund owed and queued', async () => {
    const { user, showId, bookingId, paymentId } = await confirmedBooking();

    const res = await cancel(user.token, bookingId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bookingId, status: 'CANCELLED', refund: { paymentId } });
    expect(await state(bookingId, showId)).toEqual({
      booking: 'CANCELLED',
      payment: 'REFUND_REQUIRED',
      seats: ['AVAILABLE', 'AVAILABLE'],
      confirmed_items: 0,
      events: ['BookingConfirmed', 'RefundRequired'],
    });
  });

  test('T16: cancelling twice (concurrently, then again) releases seats once and queues one refund', async () => {
    const { user, showId, bookingId } = await confirmedBooking();

    const responses = await Promise.all([
      cancel(user.token, bookingId),
      cancel(user.token, bookingId),
    ]);
    const again = await cancel(user.token, bookingId);
    for (const r of [...responses, again]) {
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('CANCELLED');
    }
    expect(await state(bookingId, showId)).toMatchObject({
      booking: 'CANCELLED',
      seats: ['AVAILABLE', 'AVAILABLE'],
      events: ['BookingConfirmed', 'RefundRequired'],
    });
  });

  test('the freed seats can be booked and confirmed by someone else', async () => {
    const { user, showId, bookingId } = await confirmedBooking();
    await cancel(user.token, bookingId);

    // The old booking_items rows remain, unconfirmed, so one_confirmed_per_seat allows this
    const next = await pendingPayment(pool, app, ['A1', 'A2'], showId);
    const res = await deliverEvent(app, gatewayEvent('payment.succeeded', next.paymentId));
    expect(res.body.result).toBe('confirmed');
  });

  test('only CONFIRMED bookings, only the owner, only before the show starts', async () => {
    // PENDING
    const pending = await pendingPayment(pool, app);
    const notConfirmed = await cancel(pending.user.token, pending.bookingId);
    expect(notConfirmed.status).toBe(409);
    expect(notConfirmed.body.error.code).toBe('INVALID_STATE');

    // Someone else's
    const { user, showId, bookingId } = await confirmedBooking();
    const stranger = await createUser(pool);
    expect((await cancel(stranger.token, bookingId)).status).toBe(404);
    expect((await cancel(stranger.token, randomUUID())).status).toBe(404);

    // Show already started
    await pool.query(`UPDATE shows SET starts_at = now() - interval '1 minute' WHERE id = $1`, [
      showId,
    ]);
    const started = await cancel(user.token, bookingId);
    expect(started.status).toBe(409);
    expect(started.body.error.code).toBe('INVALID_STATE');
    expect((await state(bookingId, showId)).booking).toBe('CONFIRMED');
  });
});
