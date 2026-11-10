import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { CASHFREE_API_VERSION } from '@seatlock/shared';

export const FAKE_CASHFREE_APP_ID = 'TEST_fake_app_id';
export const FAKE_CASHFREE_SECRET = 'cfsk_ma_test_fake_secret_for_tests';

interface Order {
  order_id: string;
  order_amount: number;
  customer_id: string;
  payment_session_id: string;
  order_status: string;
  payments: { cf_payment_id: string; payment_status: string; payment_amount: number }[];
  refunds: Map<string, { cf_refund_id: string; refund_status: string; refund_amount: number }>;
}

/**
 * A stand-in for Cashfree's sandbox API, so tests never touch the network: the same paths,
 * headers and response shapes SeatLock relies on (orders, payments, refunds), including the
 * 409 for a duplicate order id. Tests drive the "customer" side directly (payOrder) and can
 * make Cashfree reject or time out.
 */
export async function startFakeCashfree() {
  const orders = new Map<string, Order>();
  const state = { mode: 'ok' as 'ok' | 'reject' | 'down', calls: 0 };
  const app = express();
  app.use(express.json());

  app.use((req, res, next) => {
    state.calls += 1;
    if (
      req.get('x-client-id') !== FAKE_CASHFREE_APP_ID ||
      req.get('x-client-secret') !== FAKE_CASHFREE_SECRET ||
      req.get('x-api-version') !== CASHFREE_API_VERSION
    ) {
      return res.status(401).json({ code: 'authentication_failed' });
    }
    if (state.mode === 'down') return res.status(503).json({ code: 'unavailable' });
    next();
  });

  app.post('/pg/orders', (req, res) => {
    if (state.mode === 'reject') return res.status(400).json({ code: 'order_amount_invalid' });
    const { order_id, order_amount, customer_details } = req.body;
    if (orders.has(order_id)) {
      return res.status(409).json({ code: 'order_already_exists', type: 'invalid_request_error' });
    }
    if (!/^[A-Za-z0-9]{3,50}$/.test(customer_details?.customer_id ?? '')) {
      return res.status(400).json({ code: 'customer_id_invalid' });
    }
    const order: Order = {
      order_id,
      order_amount,
      customer_id: customer_details.customer_id,
      payment_session_id: `session_${randomUUID()}`,
      order_status: 'ACTIVE',
      payments: [],
      refunds: new Map(),
    };
    orders.set(order_id, order);
    res.json({
      order_id,
      order_status: 'ACTIVE',
      payment_session_id: order.payment_session_id,
      cf_order_id: `cf_${order_id}`,
    });
  });

  app.get('/pg/orders/:id', (req, res) => {
    const order = orders.get(req.params.id);
    if (!order) return res.status(404).json({ code: 'order_not_found' });
    res.json({ order_status: order.order_status, payment_session_id: order.payment_session_id });
  });

  app.get('/pg/orders/:id/payments', (req, res) => {
    res.json(orders.get(req.params.id)?.payments ?? []);
  });

  app.post('/pg/orders/:id/refunds', (req, res) => {
    const order = orders.get(req.params.id);
    if (!order) return res.status(404).json({ code: 'order_not_found' });
    const { refund_id, refund_amount } = req.body;
    if (order.refunds.has(refund_id))
      return res.status(409).json({ code: 'refund_already_exists' });
    order.refunds.set(refund_id, {
      cf_refund_id: `cfr_${randomUUID().slice(0, 8)}`,
      refund_status: 'PENDING',
      refund_amount,
    });
    res.json({ refund_id, refund_status: 'PENDING' });
  });

  app.get('/pg/orders/:id/refunds/:rid', (req, res) => {
    const refund = orders.get(req.params.id)?.refunds.get(req.params.rid);
    if (!refund) return res.status(404).json({ code: 'refund_not_found' });
    res.json(refund);
  });

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    orders,
    state,
    /** The customer completes a payment in Cashfree's checkout */
    payOrder(orderId: string, status = 'SUCCESS') {
      const order = orders.get(orderId)!;
      const cfPaymentId = String(Math.floor(Math.random() * 1e12));
      order.payments.push({
        cf_payment_id: cfPaymentId,
        payment_status: status,
        payment_amount: order.order_amount,
      });
      if (status === 'SUCCESS') order.order_status = 'PAID';
      return cfPaymentId;
    },
    /** Cashfree finishes processing a refund */
    completeRefunds(orderId: string) {
      for (const r of orders.get(orderId)!.refunds.values()) r.refund_status = 'SUCCESS';
    },
    reset() {
      orders.clear();
      state.mode = 'ok';
      state.calls = 0;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
