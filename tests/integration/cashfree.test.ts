import request from 'supertest';
import type { Pool } from 'pg';
import { createCashfreeClient, signCashfreeWebhook, verifyCashfreeWebhook } from '@seatlock/shared';
import { createConsumers } from '../../apps/worker/src/consumers';
import { reconcileCashfree } from '../../apps/worker/src/jobs/reconcileCashfree';
import { processOutbox } from '../../apps/worker/src/outbox/processOutbox';
import { createWebhookService } from '../../apps/api/src/services/webhookService';
import { acceptingGateway, createTestApp } from '../helpers/app';
import { createTestPool, resetDatabase } from '../helpers/db';
import { createShow, createUser } from '../helpers/factories';
import {
  FAKE_CASHFREE_APP_ID,
  FAKE_CASHFREE_SECRET,
  startFakeCashfree,
} from '../helpers/fakeCashfree';
import { outboxOptions, silentLogger } from '../helpers/outbox';

/**
 * Phase 14: Cashfree (sandbox) as a second payment provider, against a fake Cashfree server.
 * The booking state machine is the same one the mock gateway feeds; these tests prove the
 * Cashfree path reaches it correctly and safely.
 */
describe('Cashfree payments', () => {
  let pool: Pool;
  let cf: Awaited<ReturnType<typeof startFakeCashfree>>;
  let app: ReturnType<typeof createTestApp>;

  beforeAll(async () => {
    pool = createTestPool(10);
    cf = await startFakeCashfree();
    app = createTestApp(pool, {
      HOLD_TTL_SECONDS: 300,
      CASHFREE_APP_ID: FAKE_CASHFREE_APP_ID,
      CASHFREE_SECRET_KEY: FAKE_CASHFREE_SECRET,
      CASHFREE_BASE_URL: cf.url,
      SITE_URL: 'https://seatlock.test',
    });
  });
  afterAll(async () => {
    await cf.stop();
    await pool.end();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    cf.reset();
  });

  const client = () =>
    createCashfreeClient({
      appId: FAKE_CASHFREE_APP_ID,
      secretKey: FAKE_CASHFREE_SECRET,
      baseUrl: cf.url,
    });

  /** A user with a live hold on A1 + A2 (2 x ₹250) */
  async function heldBooking() {
    const user = await createUser(pool);
    const showId = await createShow(pool, { pricePerSeat: 25000 });
    const hold = await request(app)
      .post('/api/holds')
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', `h-${Math.random()}`)
      .send({ showId, seats: ['A1', 'A2'] });
    expect(hold.status).toBe(201);
    return { user, bookingId: hold.body.bookingId as string };
  }

  const payWithCashfree = (token: string, bookingId: string, key = 'pay-cf-1') =>
    request(app)
      .post(`/api/bookings/${bookingId}/pay`)
      .set('Authorization', `Bearer ${token}`)
      .set('Idempotency-Key', key)
      .send({ provider: 'CASHFREE' });

  const bookingOf = async (token: string, bookingId: string) =>
    (await request(app).get(`/api/bookings/${bookingId}`).set('Authorization', `Bearer ${token}`))
      .body.booking;

  function webhook(body: object, opts: { timestamp?: string; secret?: string } = {}) {
    const raw = JSON.stringify(body);
    const timestamp = opts.timestamp ?? String(Date.now());
    return request(app)
      .post('/api/webhooks/cashfree')
      .set('content-type', 'application/json')
      .set('x-webhook-timestamp', timestamp)
      .set(
        'x-webhook-signature',
        signCashfreeWebhook(opts.secret ?? FAKE_CASHFREE_SECRET, raw, timestamp),
      )
      .send(raw);
  }

  const successWebhook = (orderId: string, cfPaymentId: string, rupees: number) => ({
    type: 'PAYMENT_SUCCESS_WEBHOOK',
    event_time: new Date().toISOString(),
    data: {
      order: { order_id: orderId, order_amount: rupees, order_currency: 'INR' },
      payment: {
        cf_payment_id: cfPaymentId,
        payment_status: 'SUCCESS',
        payment_amount: rupees,
        payment_currency: 'INR',
      },
    },
  });

  test('payment options include Cashfree only when it is configured', async () => {
    expect((await request(app).get('/api/payments/options')).body.providers).toEqual([
      'MOCK',
      'CASHFREE',
    ]);
    expect(
      (await request(createTestApp(pool)).get('/api/payments/options')).body.providers,
    ).toEqual(['MOCK']);
  });

  test('pay creates a Cashfree order for the database amount and returns its checkout session', async () => {
    const { user, bookingId } = await heldBooking();
    const res = await payWithCashfree(user.token, bookingId);
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'INITIATED', provider: 'CASHFREE' });
    expect(res.body.paymentSessionId).toMatch(/^session_/);

    const order = cf.orders.get(res.body.paymentId)!;
    expect(order.order_amount).toBe(500); // rupees, from the booking total of 50000 paise
    expect(order.customer_id).toMatch(/^[A-Za-z0-9]+$/); // Cashfree accepts alphanumerics only

    // A retry with the same key replays the same session without a second order
    const calls = cf.state.calls;
    const replay = await payWithCashfree(user.token, bookingId);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.paymentSessionId).toBe(res.body.paymentSessionId);
    expect(cf.state.calls).toBe(calls);

    const { rows } = await pool.query(`SELECT provider FROM payments WHERE id = $1`, [
      res.body.paymentId,
    ]);
    expect(rows[0].provider).toBe('CASHFREE');
  });

  test('a signed success webhook confirms the booking; a redelivery changes nothing', async () => {
    const { user, bookingId } = await heldBooking();
    const { paymentId } = (await payWithCashfree(user.token, bookingId)).body;
    const cfPaymentId = cf.payOrder(paymentId);

    const first = await webhook(successWebhook(paymentId, cfPaymentId, 500));
    expect(first.body.result).toBe('confirmed');
    const again = await webhook(successWebhook(paymentId, cfPaymentId, 500));
    expect(again.body.result).toBe('duplicate');

    const booking = await bookingOf(user.token, bookingId);
    expect(booking).toMatchObject({
      status: 'CONFIRMED',
      payment: { status: 'SUCCESS', provider: 'CASHFREE' },
    });
    const { rows } = await pool.query(`SELECT provider_reference FROM payments WHERE id = $1`, [
      paymentId,
    ]);
    expect(rows[0].provider_reference).toBe(cfPaymentId);
  });

  test('forged, stale and wrong-amount webhooks never confirm anything', async () => {
    const { user, bookingId } = await heldBooking();
    const { paymentId } = (await payWithCashfree(user.token, bookingId)).body;
    const body = successWebhook(paymentId, '111', 500);

    expect((await webhook(body, { secret: 'not-the-secret' })).status).toBe(401);
    const stale = String(Date.now() - 10 * 60_000);
    expect((await webhook(body, { timestamp: stale })).status).toBe(401);
    expect((await webhook(successWebhook(paymentId, '222', 1))).body.result).toBe('ignored');
    // A failed attempt doesn't end the payment: the customer can retry within the checkout
    const failed = {
      ...body,
      type: 'PAYMENT_FAILED_WEBHOOK',
      data: { ...body.data, payment: { ...body.data.payment, payment_status: 'FAILED' } },
    };
    expect((await webhook(failed)).body.result).toBe('ignored');

    expect((await bookingOf(user.token, bookingId)).status).toBe('PENDING');
  });

  test('a Cashfree event cannot settle a payment made through the simulated gateway', async () => {
    const { user, bookingId } = await heldBooking();
    const mockPay = await request(createTestApp(pool, {}, acceptingGateway))
      .post(`/api/bookings/${bookingId}/pay`)
      .set('Authorization', `Bearer ${user.token}`)
      .set('Idempotency-Key', 'pay-mock');
    expect(mockPay.status).toBe(202);
    const res = await webhook(successWebhook(mockPay.body.paymentId, '333', 500));
    expect(res.body.result).toBe('ignored');
    expect((await bookingOf(user.token, bookingId)).status).toBe('PENDING');
  });

  test('without any webhook, asking Cashfree (refresh) confirms; the late webhook is a duplicate', async () => {
    const { user, bookingId } = await heldBooking();
    const { paymentId } = (await payWithCashfree(user.token, bookingId)).body;

    const before = await request(app)
      .post(`/api/bookings/${bookingId}/payment/refresh`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(before.body.result).toBe('pending'); // not paid yet

    const cfPaymentId = cf.payOrder(paymentId);
    const after = await request(app)
      .post(`/api/bookings/${bookingId}/payment/refresh`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(after.body.result).toBe('confirmed');
    expect((await webhook(successWebhook(paymentId, cfPaymentId, 500))).body.result).toBe(
      'duplicate',
    );
  });

  test('Cashfree refusing the order fails the payment and frees the seats', async () => {
    const { user, bookingId } = await heldBooking();
    cf.state.mode = 'reject';
    const res = await payWithCashfree(user.token, bookingId);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYMENT_GATEWAY_ERROR');
    expect(await bookingOf(user.token, bookingId)).toMatchObject({
      status: 'FAILED',
      payment: { status: 'FAILED' },
    });
  });

  test('Cashfree unavailable: the payment stays open, and a session can be fetched later', async () => {
    const { user, bookingId } = await heldBooking();
    cf.state.mode = 'down';
    const res = await payWithCashfree(user.token, bookingId);
    expect(res.status).toBe(202);
    expect(res.body.paymentSessionId).toBeUndefined();
    expect((await bookingOf(user.token, bookingId)).status).toBe('PENDING');

    cf.state.mode = 'ok';
    const session = await request(app)
      .post(`/api/bookings/${bookingId}/payment/session`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(session.status).toBe(200);
    expect(session.body.paymentSessionId).toMatch(/^session_/);
    // Asking again returns the same order's session (409 from Cashfree, then fetched)
    const again = await request(app)
      .post(`/api/bookings/${bookingId}/payment/session`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(again.body.paymentSessionId).toBe(session.body.paymentSessionId);
  });

  test('another user cannot fetch a session or refresh someone else’s payment', async () => {
    const { user, bookingId } = await heldBooking();
    await payWithCashfree(user.token, bookingId);
    const stranger = await createUser(pool);
    for (const path of ['session', 'refresh']) {
      const res = await request(app)
        .post(`/api/bookings/${bookingId}/payment/${path}`)
        .set('Authorization', `Bearer ${stranger.token}`);
      expect(res.status).toBe(404);
    }
  });

  test('cancelling refunds through Cashfree once; reconciliation records it when Cashfree completes it', async () => {
    const { user, bookingId } = await heldBooking();
    const { paymentId } = (await payWithCashfree(user.token, bookingId)).body;
    await webhook(successWebhook(paymentId, cf.payOrder(paymentId), 500));
    const cancel = await request(app)
      .post(`/api/bookings/${bookingId}/cancel`)
      .set('Authorization', `Bearer ${user.token}`);
    expect(cancel.body.status).toBe('CANCELLED');

    // The worker delivers RefundRequired to Cashfree (twice: a redelivery must not refund twice)
    const consumers = createConsumers({
      pool,
      gateway: acceptingGateway,
      webhookUrl: 'http://127.0.0.1:9/unused',
      cashfree: client(),
    });
    await processOutbox(pool, outboxOptions(consumers));
    await consumers.RefundRequired!({
      id: '0',
      event_type: 'RefundRequired',
      payload: { paymentId, amount: 50000 },
    } as never);
    const refunds = [...cf.orders.get(paymentId)!.refunds.values()];
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.refund_amount).toBe(500);

    const { apply } = createWebhookService(pool, 'unused', silentLogger);
    // Cashfree hasn't finished it yet: nothing to record
    expect(await reconcileCashfree(pool, client(), apply, silentLogger)).toBe(0);
    cf.completeRefunds(paymentId);
    expect(await reconcileCashfree(pool, client(), apply, silentLogger)).toBe(1);
    expect((await bookingOf(user.token, bookingId)).payment.status).toBe('REFUNDED');
  });

  test('webhook signatures: valid passes; any change to body, timestamp or secret fails', () => {
    const body = Buffer.from('{"type":"PAYMENT_SUCCESS_WEBHOOK","amount":170.00}');
    const ts = String(Date.now());
    const sig = signCashfreeWebhook('secret', body, ts);
    expect(verifyCashfreeWebhook('secret', body, ts, sig)).toBe(true);
    // Re-serialised JSON ("170.00" -> 170) breaks it: the raw bytes are what's signed
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString())));
    expect(verifyCashfreeWebhook('secret', reserialised, ts, sig)).toBe(false);
    expect(verifyCashfreeWebhook('secret', body, String(Number(ts) + 1), sig)).toBe(false);
    expect(verifyCashfreeWebhook('other', body, ts, sig)).toBe(false);
    expect(verifyCashfreeWebhook('secret', body, undefined, sig)).toBe(false);
  });
});
