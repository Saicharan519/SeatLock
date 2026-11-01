import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Pool } from 'pg';
import request from 'supertest';
import { signWebhook, SIGNATURE_HEADER, type GatewayEvent } from '@seatlock/shared';
import { createShow, createUser } from './factories';

/**
 * Holds seats and starts a payment through the API (whose gateway accepts silently),
 * leaving booking PENDING and payment INITIATED. Tests then play the gateway by hand.
 * Price is 20000 per seat.
 */
export async function pendingPayment(
  pool: Pool,
  app: Express,
  seats: string[] = ['A1', 'A2'],
  showId?: string,
) {
  const show = showId ?? (await createShow(pool, { pricePerSeat: 20000 }));
  const user = await createUser(pool);
  const hold = await request(app)
    .post('/api/holds')
    .set('Authorization', `Bearer ${user.token}`)
    .set('Idempotency-Key', randomUUID())
    .send({ showId: show, seats });
  if (hold.status !== 201) throw new Error(`hold failed: ${JSON.stringify(hold.body)}`);
  const pay = await request(app)
    .post(`/api/bookings/${hold.body.bookingId}/pay`)
    .set('Authorization', `Bearer ${user.token}`)
    .set('Idempotency-Key', randomUUID())
    .send();
  return {
    user,
    showId: show,
    bookingId: hold.body.bookingId as string,
    paymentId: pay.body.paymentId as string,
    amount: hold.body.totalAmount as number,
  };
}

/**
 * A gateway event with a fresh id. Amount defaults to two seats at 20000.
 * The charge id is unique per payment, like a real gateway's: payments.provider_reference
 * is UNIQUE, so one charge can never be attached to two payments.
 */
export function gatewayEvent(
  type: GatewayEvent['type'],
  paymentId: string,
  extra: Partial<GatewayEvent['data']> = {},
): GatewayEvent {
  return {
    id: `evt_${randomUUID()}`,
    type,
    data: { paymentId, chargeId: `ch_${paymentId}`, amount: 40000, ...extra },
    createdAt: new Date().toISOString(),
  };
}

/** Signs and POSTs an event. Options let tests forge bad signatures and timestamps. */
export function deliverEvent(
  app: Express,
  e: GatewayEvent,
  opts: { timestamp?: number; signWith?: string; body?: string } = {},
) {
  const body = opts.body ?? JSON.stringify(e);
  return request(app)
    .post('/api/webhooks/payment')
    .set('content-type', 'application/json')
    .set(
      SIGNATURE_HEADER,
      signWebhook(opts.signWith ?? process.env.WEBHOOK_SECRET!, JSON.stringify(e), opts.timestamp),
    )
    .send(body);
}
