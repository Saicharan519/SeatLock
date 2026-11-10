import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * A small client for the Cashfree Payment Gateway REST API (orders, payments, refunds),
 * and verification of its webhooks. SANDBOX ONLY: SeatLock never moves real money, so the
 * production host isn't even configurable.
 *
 * Money: SeatLock stores integer paise; Cashfree takes and returns rupees with up to two
 * decimals. Conversions happen only here.
 */
export const CASHFREE_SANDBOX_URL = 'https://sandbox.cashfree.com';
export const CASHFREE_API_VERSION = '2026-01-01';
/** Webhooks older (or further in the future) than this are rejected, which blocks replays */
export const CASHFREE_WEBHOOK_TOLERANCE_MS = 5 * 60_000;

export const toRupees = (paise: number) => Math.round(paise) / 100;
export const toPaise = (rupees: number) => Math.round(rupees * 100);

/** Cashfree customer ids are alphanumeric only: a UUID without its hyphens. */
export const cashfreeCustomerId = (userId: string) => userId.replace(/-/g, '');
/** Our refund id for a payment: one refund per payment, so retries can't refund twice. */
export const cashfreeRefundId = (paymentId: string) => `rf${paymentId.replace(/-/g, '')}`;

export type CreateOrderOutcome =
  | { kind: 'created'; paymentSessionId: string }
  /** An order with this id exists already (an earlier attempt got through) */
  | { kind: 'exists' }
  /** Cashfree refused (4xx): no order was created */
  | { kind: 'rejected'; status: number; reason: string }
  /** Timeout, network error or 5xx: the order may or may not exist */
  | { kind: 'ambiguous'; reason: string };

export interface CashfreeOrder {
  orderStatus: 'ACTIVE' | 'PAID' | 'EXPIRED' | 'TERMINATED' | 'TERMINATION_REQUESTED' | string;
  paymentSessionId: string | null;
}

export interface CashfreePayment {
  cfPaymentId: string;
  status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'USER_DROPPED' | 'NOT_ATTEMPTED' | string;
  amountPaise: number;
}

export interface CashfreeRefund {
  cfRefundId: string;
  status: 'SUCCESS' | 'PENDING' | 'CANCELLED' | 'ONHOLD' | string;
  amountPaise: number;
}

export interface CashfreeClient {
  createOrder(input: {
    orderId: string;
    amountPaise: number;
    customerId: string;
    customerEmail: string;
    customerPhone: string;
    returnUrl?: string;
    notifyUrl?: string;
  }): Promise<CreateOrderOutcome>;
  /** null if Cashfree has no such order */
  getOrder(orderId: string): Promise<CashfreeOrder | null>;
  getPayments(orderId: string): Promise<CashfreePayment[]>;
  /** Idempotent by refundId: asking again for the same refund is not an error */
  createRefund(input: { orderId: string; refundId: string; amountPaise: number }): Promise<void>;
  /** null if Cashfree has no such refund */
  getRefund(orderId: string, refundId: string): Promise<CashfreeRefund | null>;
}

export function createCashfreeClient(opts: {
  appId: string;
  secretKey: string;
  baseUrl?: string;
  timeoutMs?: number;
}): CashfreeClient {
  const baseUrl = opts.baseUrl ?? CASHFREE_SANDBOX_URL;
  const call = (method: 'GET' | 'POST', path: string, body?: object) =>
    fetch(new URL(path, baseUrl), {
      method,
      headers: {
        'content-type': 'application/json',
        'x-api-version': CASHFREE_API_VERSION,
        'x-client-id': opts.appId,
        'x-client-secret': opts.secretKey,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
  const json = async (res: Response) =>
    (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const fail = async (what: string, res: Response): Promise<never> => {
    const body = await json(res);
    throw new Error(
      `cashfree ${what} failed: ${res.status} ${String(body.code ?? body.message ?? '')}`,
    );
  };
  const oid = encodeURIComponent;

  return {
    async createOrder(input) {
      let res: Response;
      try {
        res = await call('POST', '/pg/orders', {
          order_id: input.orderId,
          order_amount: toRupees(input.amountPaise),
          order_currency: 'INR',
          customer_details: {
            customer_id: input.customerId,
            customer_email: input.customerEmail,
            customer_phone: input.customerPhone,
          },
          order_meta: {
            ...(input.returnUrl && { return_url: input.returnUrl }),
            ...(input.notifyUrl && { notify_url: input.notifyUrl }),
          },
        });
      } catch (err) {
        return { kind: 'ambiguous', reason: (err as Error).name || 'network error' };
      }
      const body = await json(res);
      if (res.ok && typeof body.payment_session_id === 'string') {
        return { kind: 'created', paymentSessionId: body.payment_session_id };
      }
      if (res.status === 409) return { kind: 'exists' };
      if (res.status >= 400 && res.status < 500) {
        return { kind: 'rejected', status: res.status, reason: String(body.code ?? 'rejected') };
      }
      return { kind: 'ambiguous', reason: `cashfree returned ${res.status}` };
    },

    async getOrder(orderId) {
      const res = await call('GET', `/pg/orders/${oid(orderId)}`);
      if (res.status === 404) return null;
      if (!res.ok) return fail('get order', res);
      const body = await json(res);
      return {
        orderStatus: String(body.order_status),
        paymentSessionId:
          typeof body.payment_session_id === 'string' ? body.payment_session_id : null,
      };
    },

    async getPayments(orderId) {
      const res = await call('GET', `/pg/orders/${oid(orderId)}/payments`);
      if (res.status === 404) return [];
      if (!res.ok) return fail('get payments', res);
      const body = (await res.json().catch(() => [])) as Record<string, unknown>[];
      return (Array.isArray(body) ? body : []).map((p) => ({
        cfPaymentId: String(p.cf_payment_id),
        status: String(p.payment_status),
        amountPaise: toPaise(Number(p.payment_amount)),
      }));
    },

    async createRefund(input) {
      const res = await call('POST', `/pg/orders/${oid(input.orderId)}/refunds`, {
        refund_id: input.refundId,
        refund_amount: toRupees(input.amountPaise),
        // In the sandbox the note chooses the simulated outcome (SUCCESS, FAILED, PENDING,
        // ACTIVE). Any other text leaves the refund ONHOLD ("insufficient refund balance"),
        // found in the first local test. SeatLock only ever talks to the sandbox.
        refund_note: 'SUCCESS',
      });
      if (res.ok || res.status === 409) return; // 409: this refund was already requested
      await fail('create refund', res);
    },

    async getRefund(orderId, refundId) {
      const res = await call('GET', `/pg/orders/${oid(orderId)}/refunds/${oid(refundId)}`);
      if (res.status === 404) return null;
      if (!res.ok) return fail('get refund', res);
      const body = await json(res);
      return {
        cfRefundId: String(body.cf_refund_id),
        status: String(body.refund_status),
        amountPaise: toPaise(Number(body.refund_amount)),
      };
    },
  };
}

/**
 * Cashfree signs webhooks as Base64(HMAC-SHA256(timestamp + rawBody, secretKey)), with the
 * timestamp (milliseconds) in x-webhook-timestamp. The raw bytes matter: re-serialised JSON
 * can change "170.00" to 170 and break the signature.
 */
export function signCashfreeWebhook(
  secretKey: string,
  rawBody: string | Buffer,
  timestamp: string,
) {
  return createHmac('sha256', secretKey).update(timestamp).update(rawBody).digest('base64');
}

export function verifyCashfreeWebhook(
  secretKey: string,
  rawBody: Buffer,
  timestamp: string | undefined,
  signature: string | undefined,
  now = Date.now(),
): boolean {
  if (!timestamp || !signature || !/^\d{10,16}$/.test(timestamp)) return false;
  if (Math.abs(now - Number(timestamp)) > CASHFREE_WEBHOOK_TOLERANCE_MS) return false;
  const expected = Buffer.from(signCashfreeWebhook(secretKey, rawBody, timestamp));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** The gateway-neutral events SeatLock's payment state machine understands. */
export interface PaymentEvent {
  /** Stable per event, used for deduplication (webhooks and reconciliation share ids) */
  id: string;
  type: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded';
  data: { paymentId: string; chargeId: string; amount: number; refundId?: string };
}

export const cashfreePaymentEventId = (cfPaymentId: string) => `cf_pay_${cfPaymentId}`;
export const cashfreeRefundEventId = (cfRefundId: string) => `cf_refund_${cfRefundId}`;

/**
 * Turns a Cashfree webhook body into a SeatLock event, or null for events SeatLock doesn't
 * act on. Deliberately NOT acted on: failed or abandoned attempts. In Cashfree's checkout a
 * customer can retry within the same order, so one failed attempt doesn't end the payment;
 * an order nobody completes is ended by SeatLock's hold expiry and stuck-payment sweep.
 */
export function parseCashfreeWebhook(rawBody: Buffer): PaymentEvent | null {
  let body: {
    type?: string;
    data?: {
      order?: { order_id?: string };
      payment?: {
        cf_payment_id?: string | number;
        payment_status?: string;
        payment_amount?: number;
      };
      refund?: {
        cf_refund_id?: string | number;
        refund_id?: string;
        order_id?: string;
        refund_status?: string;
        refund_amount?: number;
      };
    };
  };
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  const payment = body.data?.payment;
  const orderId = body.data?.order?.order_id;
  if (body.type === 'PAYMENT_SUCCESS_WEBHOOK' && payment?.payment_status === 'SUCCESS' && orderId) {
    const cfPaymentId = String(payment.cf_payment_id);
    return {
      id: cashfreePaymentEventId(cfPaymentId),
      type: 'payment.succeeded',
      data: {
        paymentId: orderId,
        chargeId: cfPaymentId,
        amount: toPaise(Number(payment.payment_amount)),
      },
    };
  }
  const refund = body.data?.refund;
  if (refund?.refund_status === 'SUCCESS' && refund.order_id && refund.cf_refund_id !== undefined) {
    const cfRefundId = String(refund.cf_refund_id);
    return {
      id: cashfreeRefundEventId(cfRefundId),
      type: 'refund.succeeded',
      data: {
        paymentId: refund.order_id,
        chargeId: cfRefundId,
        amount: toPaise(Number(refund.refund_amount)),
        refundId: cfRefundId,
      },
    };
  }
  return null;
}
