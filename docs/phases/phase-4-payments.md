# Phase 4: Payments and webhooks

## What this phase is

Turning a hold into a real booking. The user pays, the payment gateway charges them, and the gateway later tells us, by **webhook**, whether the money went through. Only then is the booking CONFIRMED and the seats BOOKED.

## Why payments are asynchronous

Real gateways (Razorpay, Stripe) don't answer "paid!" synchronously. You ask them to charge, they reply "accepted", and the final result arrives later as an HTTP request _from them to you_: a webhook. So the flow is:

```
Client --POST /pay--> API --POST /charges--> Gateway
Client <--202--------- API                    |
                       API <--webhook (signed)-+   (moments later)
                       booking CONFIRMED, seats BOOKED
```

`202 Accepted` means "recorded, result pending". The checkout UI polls `GET /bookings/:id` until the status changes.

## The pieces

### 1. Mock gateway ([apps/mock-gateway](../../apps/mock-gateway/src/app.ts))

A separate Express program that behaves like a real gateway:

- `POST /charges`: idempotent by payment id. Charging the same payment twice returns the original charge and sends no second webhook.
- `POST /refunds`: idempotent, confirms with a `refund.succeeded` webhook.
- Webhooks are **signed** and **retried** with backoff if our API doesn't answer 2xx, just like real gateways.
- `POST /__control` (disabled in production) switches its behaviour for tests: `success`, `fail`, `reject`, `delayed`, `timeout`, `duplicate-webhook`, `late-webhook`.

### 2. Pay endpoint ([paymentService.ts](../../apps/api/src/services/paymentService.ts), PRD 9.2)

**Step 1, one transaction:** idempotency key → lock the booking (must be yours, PENDING, not expired) → no existing payment → insert payment `INITIATED` → store the `202` response → commit.

**Step 2, after commit:** call the gateway. This is rule **R7: never make an HTTP call inside a database transaction.** If we did, a slow gateway would hold row locks for seconds and block everyone else. And because a deadlock retry re-runs the transaction, the charge could be sent twice.

**Step 3, interpret the answer.** This is the subtle part:

| Gateway answer                    | Meaning                                       | What we do                                                                                       |
| --------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 2xx accepted                      | Charge started                                | Nothing; wait for the webhook                                                                    |
| **4xx** (e.g. 402 declined)       | **Definitely** failed, no money moved         | Payment FAILED, booking FAILED, seats freed, stored response becomes `502 PAYMENT_GATEWAY_ERROR` |
| **Timeout / network error / 5xx** | **Unknown**: the charge may have gone through | **Change nothing.** Payment stays INITIATED, booking PENDING. The webhook decides                |

Why not treat a timeout as failure? Because the gateway might have charged the card and only the _response_ got lost. If we failed the booking, the customer would be charged with no ticket. T18 tests exactly this: the gateway accepts the charge but never answers; we return 202 with nothing changed; the webhook arrives and confirms the booking.

### 3. Webhook handler ([webhookService.ts](../../apps/api/src/services/webhookService.ts), PRD 9.3)

**a) Verify the signature** ([webhookSignature.ts](../../packages/shared/src/webhookSignature.ts)). Anyone on the internet can POST to our webhook URL, so a forged "payment succeeded" would mean free tickets. The gateway signs each webhook:

```
X-SeatLock-Signature: t=<unix time>,v1=HMAC-SHA256(secret, "<t>.<raw body>")
```

We recompute the HMAC with our copy of the secret and compare:

- **Raw bytes:** the webhook route reads the body as a raw Buffer, _before_ the JSON parser. Re-serialising parsed JSON can change whitespace or key order and break the signature.
- **Constant-time compare** (`timingSafeEqual`): a normal `===` returns faster when the first bytes differ, which leaks information an attacker can measure.
- **Timestamp within 5 minutes:** stops an attacker who captured a real webhook from replaying it later. The timestamp is inside the signed data, so it can't be swapped.

**b) Dedupe.** Gateways deliver at-least-once, so the same event can arrive twice (retries, network glitches). We `INSERT INTO webhook_events (provider_event_id) ... ON CONFLICT DO NOTHING`. If the row already existed, it's a duplicate: return 200 and do nothing. This insert is in the **same transaction** as the effects, so if we crash halfway, both roll back and the gateway's retry is processed normally. Two concurrent deliveries of one event: the second blocks on the primary key until the first commits, then sees the conflict (T6).

**c) Lock booking, then payment** (R3 lock order), then decide:

| Event            | Payment                              | Booking            | Action                                                                                                                                   |
| ---------------- | ------------------------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| succeeded        | SUCCESS / REFUND_REQUIRED / REFUNDED | any                | Ignore (already handled)                                                                                                                 |
| succeeded        | FAILED                               | any                | **REFUND_REQUIRED.** We were charged after declaring failure; never ignore                                                               |
| succeeded        | INITIATED                            | PENDING, live      | **Confirm**: lock seats → verify all still ours → BOOKED, items confirmed, booking CONFIRMED, payment SUCCESS, outbox `BookingConfirmed` |
| succeeded        | INITIATED                            | expired / EXPIRED  | Late payment (see "Phase 4 vs Phase 5" below)                                                                                            |
| succeeded        | INITIATED                            | FAILED / CANCELLED | REFUND_REQUIRED                                                                                                                          |
| failed           | INITIATED                            | PENDING            | Payment FAILED, booking FAILED, seats freed                                                                                              |
| refund.succeeded | REFUND_REQUIRED                      | any                | REFUNDED                                                                                                                                 |

Every change is a **guarded update** (`WHERE status = 'INITIATED'`), so even if two code paths race, only one transition happens.

**Lock, verify, then update.** Confirming locks the booking's seats in id order, counts how many this booking still holds, and only if _all_ are held flips them to BOOKED. With the locks held nobody can change those rows in between, so it's all-or-nothing without savepoints.

### 4. Transactional outbox (started here)

When a booking is confirmed, we also write a `BookingConfirmed` row into `outbox_events` **in the same transaction**. Later (Phase 6) the worker reads these rows and sends notifications. Why not send the notification right there? If the server crashed after commit but before sending, the event would be lost forever. With the outbox, the event is committed atomically with the booking: both exist or neither does.

### 5. Booking history and detail

`GET /bookings/me` and `GET /bookings/:id` return the status, seats, show and payment status. Someone else's booking returns 404, the same as a missing one, so you can't probe for other people's booking ids.

## Phase 4 vs Phase 5: the late payment

A success webhook that arrives **after the hold expired** should, per the PRD, try to **re-claim** all the seats: confirm if every seat is still free, refund if any was taken. Phase 4 takes the simpler, always-safe route: **always refund** late payments. That never double-books and never loses money, but it refunds some customers who could have kept their seats. Phase 5 upgrades it to the re-claim logic, with tests T8, T9 and T14.

Phase 4 also already covers two items planned for Phase 5, because they're part of the pay flow itself: **T7** (payment failure, by webhook and by gateway rejection) and **T18** (gateway timeout).

## What happened during this phase

1. **The first CI run on GitHub passed:** all 36 Phase 0–3 tests, on Linux.
2. **A deadlock in the tests, not the app.** One test started a payment; the mock gateway's webhook arrived 50 ms later, right as the _next_ test was wiping the database with `TRUNCATE`. The webhook transaction and the TRUNCATE locked tables in different orders, and Postgres detected a deadlock. Fixes: cancel pending gateway webhooks between tests, and retry the reset if it collides with a straggler. Lesson: asynchronous callbacks outlive the test that triggered them.
3. **A real-process smoke test.** The API and gateway were started as separate programs (like production) and a seat was booked with `curl`: register → hold → pay → webhook → CONFIRMED.

## Tests added (18, total now 54)

| Test              | Proves                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1**            | Hold → pay → real webhook → CONFIRMED, seats BOOKED, items confirmed, outbox event, history                                                                             |
| **T3 (pay) / S4** | Same key ×20 concurrently → one payment, **one gateway call**, 19 replays                                                                                               |
| **T6**            | The same event twice (concurrent and sequential) → one transition, one outbox event                                                                                     |
| **S8**            | The gateway really sends the webhook twice → confirmed once                                                                                                             |
| **T7**            | Failure webhook → booking FAILED and seats freed; gateway 402 → `502`, booking FAILED, replay returns 502                                                               |
| **T10**           | Wrong secret, stale or future timestamp, tampered body, missing header → `401`, no state change, nothing recorded                                                       |
| **T18**           | Gateway timeout → 202 with nothing changed → webhook confirms                                                                                                           |
| +                 | Refunds for success-after-failure and after cancellation, refund webhook, unknown payment, amount mismatch, malformed payload, pay refusals, key reuse across endpoints |

## Key takeaways

- Payment is "202 + webhook" because real gateways confirm asynchronously.
- A gateway timeout must not fail the booking: the charge may have gone through. Only a 4xx is a definite failure (T18).
- No HTTP calls inside transactions (R7): they would hold row locks for the call's duration, and a retried transaction would repeat the call.
- Webhooks are verified with HMAC over the raw body, a constant-time compare, and a timestamp check against replays.
- At-least-once delivery is handled by deduplicating on the event id, in the same transaction as the effect.
- The transactional outbox closes the crash window that "send after commit" leaves open.
