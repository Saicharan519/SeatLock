# Phase 14: Payments v2 (Cashfree sandbox + the simulated gateway)

## What this phase is

Until now every payment went through SeatLock's own simulated gateway. This phase adds a **real payment gateway, Cashfree, in its sandbox (test) mode**, next to the simulated one. Customers choose at checkout. No real money can move: SeatLock only accepts sandbox keys.

The point isn't the button. It's showing that the booking engine doesn't care which gateway is behind it: both feed the same state machine (confirm in time, re-claim seats on a late payment, refund otherwise), through the same idempotency and deduplication.

## Why Cashfree, not Razorpay

The plan said Razorpay. Its onboarding asked for a personal PAN before showing anything; test mode doesn't need one, but the dashboard pushed the form first, and entering a fake or someone else's PAN is not an option (it's false information to a regulated payment company, and it's checked against Central KYC anyway). Cashfree's documentation states that sandbox keys are available before any KYC, and its flow is the same shape as Razorpay's: create an order on the server, open a hosted checkout in the browser, confirm by signed webhook. Stripe (no UPI, invite-only in India) and PayPal (no UPI) were kept as fallbacks.

## How a Cashfree payment flows

```
Browser            SeatLock API                    Cashfree (sandbox)         Worker
  │ Pay (Cashfree)    │                                  │                       │
  │──────────────────▶│ payment INITIATED, commit        │                       │
  │                   │── create order (id = payment id, │                       │
  │                   │   amount from OUR database) ────▶│                       │
  │◀── 202 + session ─│◀──────── payment_session_id ─────│                       │
  │ opens Cashfree's checkout popup (test UPI / card)    │                       │
  │──────────────────────────── pays ───────────────────▶│                       │
  │                   │◀── signed webhook (PAYMENT_SUCCESS)                      │
  │                   │   verify, dedupe, confirm (same engine as the mock)      │
  │ popup closes → "refresh": API asks Cashfree directly │                       │
  │                   │                                  │◀── every 30 s: open   │
  │                   │                                  │    payments/refunds?  │
```

**Three ways the result can arrive, one place it's applied.** Cashfree's webhook, the "refresh" the page triggers when the popup closes, and the worker's reconciliation job all turn what Cashfree reports into the same event (`cf_pay_<cf_payment_id>`), handed to the same `apply()` function. That function deduplicates by event id inside the same transaction as its effects, so a payment reported by all three is applied exactly once.

Why reconciliation at all: webhooks can be lost or delayed; Cashfree's refund webhooks need to be configured in its dashboard; and Cashfree can't reach a laptop, so without it nothing would ever confirm in local development.

## Decisions inside the flow

| Decision                                                                               | Why                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cashfree's order id **is** SeatLock's payment id                                       | Creating the same order twice returns 409, so retries can never create two orders; a timed-out create is resolved by fetching the existing order                                              |
| The amount comes from SeatLock's database, converted from paise to rupees in one place | The browser never says how much to charge                                                                                                                                                     |
| A failed attempt (`PAYMENT_FAILED_WEBHOOK`) is **ignored**                             | Inside Cashfree's checkout the customer can retry within the same order. An order nobody completes is ended by SeatLock's hold expiry and the 15-minute stuck-payment sweep, as with the mock |
| Cashfree events can only settle `CASHFREE` payments                                    | A signed Cashfree event can't confirm a payment made through the simulated gateway (tested by disabling the check: the test fails)                                                            |
| Timeout creating the order → payment stays open                                        | The browser asks for a session again (`POST /bookings/:id/payment/session`); it's the same order, so the customer can't be charged twice                                                      |
| Refund id = `rf` + payment id; 409 treated as success                                  | One refund per payment, so a redelivered `RefundRequired` event can't refund twice                                                                                                            |
| Webhook signature: Base64(HMAC-SHA256(timestamp + raw body, secret)), ±5 minutes       | The raw bytes are what's signed (re-serialised JSON turns `170.00` into `170`); the timestamp window blocks replays. Constant-time comparison                                                 |
| Only `TEST…` App IDs accepted; otherwise Cashfree is switched off with an error log    | Real money is out of reach by construction, and a bad setting can't take the site down                                                                                                        |
| Customer phone is a fixed test number                                                  | Cashfree requires one; SeatLock doesn't collect phone numbers                                                                                                                                 |
| The checkout script loads from Cashfree's CDN, on demand                               | Cashfree requires it (PCI); SeatLock never sees card or UPI details                                                                                                                           |

## What changed

| Area            | Change                                                                                                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database        | `payments.provider` (`MOCK` or `CASHFREE`), and an index for the reconciliation scan                                                                                                                              |
| Shared          | `cashfree.ts`: orders, payments, refunds client; webhook signing and verification; Cashfree-to-SeatLock event translation                                                                                         |
| API             | Pay accepts `{ provider }`; `GET /api/payments/options`; `POST /api/bookings/:id/payment/session` and `/payment/refresh`; `POST /api/webhooks/cashfree` (raw body, exempt from the origin secret, signed instead) |
| Webhook service | Split into signature check + `apply(event)`, the single entry point for every gateway and for reconciliation                                                                                                      |
| Worker          | `RefundRequired` refunds through the payment's own provider; a `reconcileCashfree` job every 30 s                                                                                                                 |
| Frontend        | Payment method choice (Cashfree test mode or simulated), Cashfree popup, "Complete payment in Cashfree" to reopen it, Cashfree status checks while processing                                                     |

## Tests

| Test (cashfree.test.ts, 11)                                                                                        | Proves                                                  |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Options include Cashfree only when configured                                                                      | The simulated gateway works alone                       |
| Pay creates an order for the database amount; the same key replays the same session without calling Cashfree again | Idempotency covers the new provider                     |
| A signed success webhook confirms; a redelivery is a duplicate                                                     | Same engine, same dedupe                                |
| Forged, stale, wrong-amount and failed-attempt webhooks never confirm                                              | Signature, replay window, amount check, retry semantics |
| A Cashfree event can't settle a simulated payment                                                                  | Provider isolation                                      |
| With no webhook at all, refresh confirms; the late webhook is a duplicate                                          | Reconciliation and webhook share event ids              |
| Cashfree refusing the order fails the payment and frees the seats                                                  | Definite rejection                                      |
| Cashfree down: the payment stays open; a session can be fetched later (409 → existing order)                       | Ambiguous outcome handled like the mock's timeout       |
| Another user can't fetch a session or refresh someone else's payment                                               | Ownership (404)                                         |
| Cancelling refunds through Cashfree once (even redelivered); reconciliation records it when Cashfree completes it  | Provider-aware, idempotent refunds                      |
| Signature changes in body, timestamp or secret all fail                                                            | The verification itself                                 |

All against a fake Cashfree server with the real API's paths, headers and status codes; the suite never touches the network. One existing test changed: the pay response now also says `"provider": "MOCK"`.

Suite: **138 tests** (11 new since Phase 13.5, all above). Locally, one clock-sensitive test (`holds seats and returns the booking`, and on one run T5) failed intermittently: Docker Desktop's VM clock was measured 0.5–0.7 s behind Windows after a restart, and those tests compare the database clock with the test process's clock. The same test fails one run in three on the unchanged, committed code, so it is the environment, not this phase; CI on Linux has no such drift.

## Verification against the real Cashfree sandbox

The first live attempt on the hosted site found two problems, so everything below was then run **locally** against Cashfree's real sandbox (keys in the local `.env`) before pushing again.

| Check                                                               | Result                                                                                                                                                    |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pay with Cashfree → order created from SeatLock's server            | Redirected to `sandbox.cashfree.com` checkout for ₹210 (amount from the database)                                                                         |
| Leave without paying, come back                                     | **"Finish your payment"**: hold countdown, "Continue to Cashfree · ₹210" (same order, same session), "Release seats"                                      |
| Card 4706 1312 1121 2123 → bank OTP simulator (OTP 111000, SUCCESS) | OTP page opened in the same tab; returned to SeatLock with `?order_id=`; **"You're in"**, ticket shown                                                    |
| Database after payment                                              | Booking CONFIRMED, payment SUCCESS via CASHFREE, 21000 paise, Cashfree payment id stored; event source **reconciliation** (no webhook can reach a laptop) |
| Cancel → refund                                                     | Refund requested once, for the full amount; booking CANCELLED, seat freed; payment REFUND_REQUIRED, page "Refund on its way"                              |
| Refund outcome at Cashfree                                          | `ONHOLD`: "Refund on hold because of insufficient account balance" (see below)                                                                            |

### What the real sandbox found

1. **A card's OTP page was blocked.** In popup mode (`redirectTarget: "_modal"`) the bank's OTP page opens a new window from inside the popup, which browsers block ("popup blocker enabled... Open Payment Page"). Checkout now uses Cashfree's full hosted page (`_self`), which returns to SeatLock's checkout with `?order_id=`; SeatLock then asks Cashfree for the result at once.
2. **Closing Cashfree left the page on "Processing"** with Cashfree's raw "Payment has been aborted" message. A Cashfree payment that's still open while the hold is live now shows "Finish your payment" instead, and still polls, so a payment that did go through flips to the ticket by itself.
3. **Sandbox refunds stay ONHOLD without balance.** Cashfree's sandbox picks a refund's simulated outcome from `refund_note` (`SUCCESS`, `FAILED`, `PENDING`, `ACTIVE`); free text left the first refund ONHOLD. With `refund_note: "SUCCESS"` the note arrives, but the refund is still held: "insufficient account balance". Cashfree pays refunds from the merchant's balance, and this sandbox account has none. SeatLock's side is correct (requested once, honest status, flips to Refunded when Cashfree releases it); completing a sandbox refund needs balance on the Cashfree test account. The refund path is covered end to end by the tests against the fake Cashfree server.
4. **Tests inherited real keys from `.env`.** With Cashfree keys in the local `.env`, a test expecting "Cashfree not configured" saw Cashfree. The test setup now deletes gateway keys and proxy secrets, so tests only ever use the fake server's keys.
5. **The hosted Cashfree webhook** (as opposed to reconciliation) is verified on the live site after this push.

## Key takeaways

- A second gateway was added without touching the booking engine: everything goes through one `apply(event)`.
- Webhooks are the primary signal; reconciliation is the backstop; shared event ids make them safe together.
- Using the gateway's idempotency (order id = payment id, refund id per payment) turns retries into non-events.
- Not every gateway failure means the payment is over: semantics differ per provider, and the code says which ones it acts on.
- Real money is unreachable by construction (sandbox host, TEST keys only), not by convention.
