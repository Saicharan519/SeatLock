# SeatLock — Product Requirements Document

**Version:** 1.2 · **Status:** Ready for implementation · **Timeline:** 6 weeks as a target, not a deadline (P0 targeted by end of week 4; tests are never cut)
**Stack:** Node.js 24 LTS · TypeScript · Express · PostgreSQL 16 · Redis · React (minimal)

---

## 1. Overview

SeatLock is a ticket-booking backend (BookMyShow-style) built around one guarantee:

> **For a given show and seat, at most one CONFIRMED booking exists at any time, regardless of concurrent requests, retries, crashes, or late payments.**

The guarantee is enforced by PostgreSQL (transactions, row locks, constraints), not by the frontend or by application-level checks alone.

**Problem scenario.** A show has 50 seats. At 6 PM, 1,000 users try to book. Naive implementations double-sell seats (read-then-write races), double-charge on retries, leave abandoned holds stuck forever, or lose confirmation events when the server crashes between commit and publish.

**What this project demonstrates:** concurrency control, transaction design, idempotent APIs, background processing, transactional outbox, failure recovery, and proof via automated concurrency tests and load tests.

The UI is deliberately minimal. Backend engineering is the deliverable.

---

## 2. Goals and success metrics

| # | Goal | Metric | Target |
|---|---|---|---|
| G1 | No double-booking | Seats with >1 CONFIRMED booking after any test | 0 |
| G2 | Concurrency correctness | 1,000 concurrent single-seat hold requests on 50 seats | exactly 50 succeed, 950 get `SEAT_UNAVAILABLE` |
| G3 | No partial multi-seat holds | Bookings holding fewer seats than requested | 0 |
| G4 | Idempotent payments | Duplicate payments/bookings from repeated same-key requests | 0 |
| G5 | No lost events | Committed outbox events never published (after worker restart) | 0 |
| G6 | Expiry recovery | Expired holds released within `TTL + 2 × worker interval` | 100% in deterministic tests |
| G7 | Latency (local Docker, 50 VUs steady, 60 s) | p95 seat map / p95 hold | < 300 ms / < 500 ms |
| G8 | Reproducibility | `docker compose up` brings up the whole system | works from clean clone |

G7 numbers are targets. Report only what k6 actually measures, with machine specs.

---

## 3. Non-goals

Deliberate exclusions. They are boundaries, not a backlog.

- No real payment gateway or real money. The gateway is a mock.
- No microservices, no Kafka or other message broker. Outbox consumers run inside the worker process.
- No admin UI. Shows are seeded by script, plus one admin-only create endpoint.
- No payment retry on the same booking. A failed payment fails the booking; the user starts over.
- No partial cancellation (cancel one seat out of a booking).
- No payment reconciliation by polling the gateway. A lost webhook is out of scope.
- No real email/SMS, no mobile apps, no autoscaling or multi-region deployment.
- No seat-tier pricing, coupons, search/filtering, or analytics.

---

## 4. Users

- **Customer:** registers, browses shows, holds seats, pays, views and cancels bookings.
- **Admin:** one seeded user (`role = ADMIN`). Can create shows and view failed outbox events through the API.

---

## 5. Core scenarios

Each scenario is also an automated test (see section 13).

| ID | Scenario | Expected behavior |
|---|---|---|
| S1 | **Normal booking.** Rahul holds A1, A2, pays, webhook succeeds. | Hold → `PENDING` booking, seats `HELD`. Pay → `202`. Webhook → booking `CONFIRMED`, seats `BOOKED`, `BookingConfirmed` outbox event written in the same transaction. |
| S2 | **Race.** Rahul and Priya hold A1 simultaneously. | Exactly one succeeds. The other gets `409 SEAT_UNAVAILABLE`. |
| S3 | **Abandoned checkout.** Priya holds and closes the tab. | After expiry, the worker marks the booking `EXPIRED` and releases seats. Until then, the seat map already shows them `AVAILABLE` (read-time check). |
| S4 | **Double-click Pay.** Same `Idempotency-Key` sent twice, including concurrently. | One payment row, one gateway call. Second request returns the stored response. |
| S5 | **Crash after commit.** API/worker dies after booking commit, before the event is handled. | Outbox row stays `PENDING`. Worker restarts and processes it. Consumer is idempotent, so a duplicate delivery is harmless. |
| S6 | **Late payment.** Hold expires at 6:05, success webhook arrives at 6:07. | Try to re-claim all seats atomically. All free → booking `EXPIRED → CONFIRMED`. Any taken → payment `REFUND_REQUIRED`, booking stays `EXPIRED`. Never steals seats, never partially confirms. |
| S7 | **Payment fails.** Gateway reports failure. | Payment `FAILED`, booking `FAILED`, seats released immediately. |
| S8 | **Duplicate webhook.** Gateway delivers the same event twice. | Second delivery is a no-op, returns `200`. |
| S9 | **Cancellation.** Customer cancels a confirmed booking before the show starts. | Booking `CANCELLED`, seats `AVAILABLE`, payment `REFUND_REQUIRED`, then `REFUNDED` after the mock gateway confirms. |
| S10 | **Gateway timeout.** The `/pay` call to the gateway times out. | Payment stays `INITIATED`, booking stays `PENDING`. The webhook decides. If none arrives, the sweep marks the payment `FAILED`, and a later success is refunded. |

---

## 6. Architecture

```
React (Vite) ──REST──▶ API (Express, TS)  ──SQL──▶ PostgreSQL (source of truth)
                          │   ▲                         ▲
              rate limit  │   │ webhook (HMAC)          │ poll / claim (SKIP LOCKED)
                          ▼   │                         │
                        Redis │              Worker (separate Node process)
                              │                • expire holds
                     Mock Payment Gateway      • process outbox (consumers)
                     (separate Express app)    • sweep stuck payments, old keys
```

- **Modular monolith.** One repo, three entry points: `api`, `worker`, `mock-gateway`. Layers: routes → controllers → services → repositories → PostgreSQL. No business logic in routes or controllers.
- **PostgreSQL is the only source of truth.** Redis is used for rate limiting only. If Redis is down, the API still works and the rate limiter fails open (logged).
- **Worker** is safe to run more than once (all claims use `FOR UPDATE SKIP LOCKED` or guarded updates).
- **Mock gateway** exposes `POST /charges`, `POST /refunds`, and a test-only control endpoint `POST /__control` (modes: success, fail, delayed, timeout, duplicate-webhook, late-webhook). It calls back `POST /api/webhooks/payment` with an HMAC signature.

### Technology choices

| Layer | Choice | Reason |
|---|---|---|
| Language/runtime | TypeScript, Node.js 24 LTS (Node 20 reached end-of-life in April 2026) | Types catch money/state bugs |
| API | Express | Familiar; effort goes to the hard parts |
| DB access | `pg` + raw parameterized SQL, `node-pg-migrate` | Locks and atomic updates must be explicit and explainable (no ORM) |
| Cache/limits | Redis via `ioredis` | Rate limiting only. Add seat-map caching only if k6 shows a read bottleneck, with before/after numbers |
| Auth | JWT (1 h expiry), bcrypt | Standard |
| Validation | Zod | Reject bad input at the edge |
| Logging | pino, request ID per request | Structured logs |
| Tests | Jest + Supertest (real PostgreSQL), k6 | Correctness in Jest, latency in k6 |
| Infra | Docker Compose (api, worker, gateway, postgres, redis) | One-command setup |
| Frontend | React + Vite + Tailwind | Capped at 3 days of effort |

---

## 7. Data model

Money is stored as **integer paise**. All timestamps are `timestamptz`. IDs: UUID for users, shows, bookings, payments; `BIGSERIAL` for seats and outbox.

| Table | Columns |
|---|---|
| `users` | id, name, email (unique), password_hash, role (`USER`/`ADMIN`), created_at |
| `shows` | id, title, description, venue, starts_at, price_per_seat (paise, > 0), created_at |
| `bookings` | id, user_id, show_id, status, total_amount, **expires_at**, created_at, updated_at |
| `seats` | id, show_id, seat_label, status (`AVAILABLE`/`HELD`/`BOOKED`), booking_id (nullable), created_at, updated_at |
| `booking_items` | id, booking_id, seat_id, price, **is_confirmed** (default false) |
| `payments` | id, booking_id (unique), amount, status, provider_reference (unique, nullable), refund_reference, created_at, updated_at |
| `idempotency_keys` | id, user_id, key, endpoint, request_hash, response_status, response_body (jsonb), created_at, expires_at (24 h). **`UNIQUE (user_id, key)`**: concurrent same-key requests serialize on it. Reusing a key on another endpoint changes the request hash, so it returns `422` |
| `webhook_events` | provider_event_id (PK), event_type, payload, received_at |
| `outbox_events` | id, aggregate_type, aggregate_id, event_type, payload (jsonb), status (`PENDING`/`PROCESSING`/`PUBLISHED`/`FAILED`), retry_count, next_attempt_at, locked_until, last_error, created_at, published_at |
| `notifications` | id, event_id (**unique**), user_id, type, payload, created_at |

**Design decisions**

- `holdId` in the API **is** the `bookingId`. A hold is a `PENDING` booking. There is no separate holds table.
- **Single expiry authority: `bookings.expires_at`.** Seats carry no `held_until` and no `held_by`. A `HELD` seat is "really held" only if its booking is `PENDING` and `expires_at > now()`.
- A show has exactly 50 seats (rows A–E × 10), generated in the same transaction that creates the show. There is no `total_seats` column.
- Refund lifecycle lives **only on `payments`**. Bookings never have a refund state.

**Database-level safety nets** (the database must refuse corruption even if application code has a bug):

```sql
-- Seat ownership is consistent with status
ALTER TABLE seats ADD CONSTRAINT seat_status_owner
  CHECK ((status = 'AVAILABLE') = (booking_id IS NULL));
ALTER TABLE seats ADD CONSTRAINT seats_show_label UNIQUE (show_id, seat_label);

-- A seat can be in at most one CONFIRMED booking
CREATE UNIQUE INDEX one_confirmed_per_seat
  ON booking_items (seat_id) WHERE is_confirmed;

-- One active hold per user per show (anti-hoarding)
CREATE UNIQUE INDEX one_pending_per_user_show
  ON bookings (user_id, show_id) WHERE status = 'PENDING';

-- Worker / outbox scans
CREATE INDEX bookings_pending_expiry ON bookings (expires_at) WHERE status = 'PENDING';
CREATE INDEX outbox_due ON outbox_events (next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX outbox_leases ON outbox_events (locked_until) WHERE status = 'PROCESSING';

ALTER TABLE booking_items ADD CONSTRAINT items_unique UNIQUE (booking_id, seat_id);
```

`is_confirmed` is set to `true` in the confirm transaction and `false` in the cancel transaction. It exists so the database can enforce the core invariant directly.

---

## 8. State machines

**Seat**

```
AVAILABLE ──hold──▶ HELD ──confirm──▶ BOOKED ──cancel──▶ AVAILABLE
    ▲                 │
    └─release/expire/fail
HELD (stale, booking expired) ──new hold takes over──▶ HELD (new booking)
AVAILABLE or stale-HELD ──late-payment re-claim──▶ BOOKED
```

**Booking**

```
PENDING ──payment success (in time)──▶ CONFIRMED ──cancel──▶ CANCELLED
PENDING ──payment failed / gateway error──▶ FAILED
PENDING ──expiry (worker or user's own stale hold)──▶ EXPIRED
PENDING ──user releases hold──▶ CANCELLED
EXPIRED ──late payment, all seats re-claimed──▶ CONFIRMED
```

**Payment**

```
INITIATED ──success──▶ SUCCESS ──cancel booking──▶ REFUND_REQUIRED ──refund webhook──▶ REFUNDED
INITIATED ──failure / stuck sweep──▶ FAILED ──late success webhook──▶ REFUND_REQUIRED
INITIATED ──success but seats unrecoverable──▶ REFUND_REQUIRED
```

Every transition is a **guarded update**: `UPDATE ... SET status = new WHERE id = $1 AND status = expected`, and the affected-row count is checked. An unexpected count means a lost race or invalid transition, handled explicitly.

---

## 9. Concurrency and consistency rules

These are mandatory. Each one must be demonstrable in a test.

| Rule | Statement |
|---|---|
| R1 | Isolation level is `READ COMMITTED` (Postgres default). Correctness comes from row locks and guarded updates, not from raising the isolation level. |
| R2 | Any statement touching multiple seat rows first locks them in **ascending `id` order** (`SELECT ... ORDER BY id FOR UPDATE`). This prevents deadlocks between overlapping multi-seat holds. A path that also releases seats (for example the caller's own stale hold in 9.1) builds **one combined lock set** (requested seats plus seats to release), locks it in `id` order, and only then releases and claims. Never lock in two separate passes. |
| R3 | Global lock order across tables: **booking → payment → seats**. Every code path follows it. |
| R4 | Deadlock (`40P01`) and serialization (`40001`) errors are retried up to 3 times with jitter. After that: `503 RETRY_LATER`. |
| R5 | All time comparisons use the database clock (`now()`), never the application clock. |
| R6 | `statement_timeout = 5 s`, `lock_timeout = 3 s`. Pool size is configurable (default API 20, worker 5). Requests never hang indefinitely. The pool acquire timeout must be generous enough that T1 (1,000 concurrent requests queueing for connections) produces **zero 503s and zero pool errors**; only `201` and `SEAT_UNAVAILABLE` are acceptable outcomes. Seat locks are plain blocking `FOR UPDATE`, not `NOWAIT`/`SKIP LOCKED`: with `NOWAIT`, a multi-seat loser could be told "unavailable" about a seat whose holder later rolled back. |
| R7 | No external HTTP calls inside a DB transaction, no exceptions. Outbox consumers use a lease (9.5): claim and commit, call out, record the result in a second transaction. |
| R8 | A multi-seat operation is all-or-nothing: if the affected-row count differs from the requested seat count, the transaction rolls back. |

### 9.1 Hold algorithm (`POST /api/holds`)

Single transaction:

1. Insert the idempotency key (`ON CONFLICT DO NOTHING`). On conflict, load the stored row: same hash and completed → replay the stored response; different hash → `422`.
2. Validate: show exists and `starts_at > now()`, 1–6 unique seat labels that exist for the show.
3. Find the caller's own `PENDING` booking for this show, if any. If it is live (`expires_at >= now()`) → `409 ACTIVE_HOLD_EXISTS` (also enforced by `one_pending_per_user_show`). If it is stale, read its seat ids (unlocked read) so they can join the lock set in step 5.
4. Insert the `PENDING` booking with `expires_at = now() + HOLD_TTL` (default 300 s, configurable so tests can use 5 s). If a stale booking exists, it is marked `EXPIRED` first (guarded `WHERE status = 'PENDING'`) so the unique index admits the new one.
5. Build **one lock set**: requested seats plus the stale booking's seats, and lock it in `id` order (R2). After locking, **re-verify** the stale booking (it may have been expired by the worker or confirmed by a webhook since the unlocked read); if it is no longer a stale `PENDING`/`EXPIRED` booking, handle that outcome (confirmed → `409 ACTIVE_HOLD_EXISTS`). Then release the stale booking's seats (guarded by `booking_id`).
6. Conditionally claim them:

```sql
UPDATE seats s
SET status = 'HELD', booking_id = $newBookingId, updated_at = now()
WHERE s.id = ANY($lockedSeatIds)
  AND ( s.status = 'AVAILABLE'
        OR ( s.status = 'HELD'
             AND EXISTS (SELECT 1 FROM bookings b
                         WHERE b.id = s.booking_id AND b.expires_at < now()) ) );
```

7. If `rowCount != requested seats` → rollback, `409 SEAT_UNAVAILABLE` (R8).
8. Insert `booking_items` with the booking-time price, set `total_amount`, store the idempotency response, commit.

A new hold may take over a seat whose previous hold is stale but not yet swept. The old booking stays `PENDING` until the worker marks it `EXPIRED`; the worker's release is guarded by `booking_id = old id`, so it never touches the taken-over seat.

### 9.2 Payment initiation (`POST /api/bookings/:id/pay`)

1. Transaction: store idempotency key, verify booking is the caller's, `PENDING`, and `expires_at > now()`, insert payment `INITIATED`, store `202` response, commit.
2. After commit, call the gateway `POST /charges` (idempotent by payment id) with a callback URL.
3. Interpret the gateway outcome:
   - **Definite rejection** (gateway returns a 4xx): guarded transitions payment `INITIATED → FAILED` and booking `PENDING → FAILED` (seats released), stored response updated to `502 PAYMENT_GATEWAY_ERROR`.
   - **Ambiguous outcome** (timeout, connection error, 5xx): the gateway may have accepted the charge. Change **no** state. The payment stays `INITIATED`, the booking stays `PENDING`, and the stored `202` response stands. The webhook decides the outcome. Retrying the call is safe because the gateway dedupes by payment id.
   - If no webhook ever arrives, the stuck-payment sweep (9.4) marks the payment `FAILED`. A success webhook arriving after that is refunded, never ignored (9.3).

### 9.3 Webhook handling (`POST /api/webhooks/payment`)

1. Verify HMAC-SHA256 over the **raw body** with the shared secret (constant-time compare) and reject timestamps older than 5 minutes → `401 INVALID_SIGNATURE`.
2. Transaction: insert into `webhook_events` (`ON CONFLICT DO NOTHING`). If it already existed → return `200` (duplicate).
3. Lock booking, then payment (R3). Then:

| Event | Payment state | Booking state | Action |
|---|---|---|---|
| success | `SUCCESS`, `REFUND_REQUIRED` or `REFUNDED` | any | no-op (duplicate) |
| success | `FAILED` (e.g. swept after an ambiguous gateway outcome) | any | payment `REFUND_REQUIRED`, outbox `RefundRequired`. Booking unchanged, no re-claim. The customer was charged, so this must never be ignored |
| success | `INITIATED` | `PENDING`, `expires_at > now()` | seats `HELD → BOOKED` (row count must equal item count, else fall through to late path), items `is_confirmed = true`, booking `CONFIRMED`, payment `SUCCESS`, outbox `BookingConfirmed` |
| success | `INITIATED` | `EXPIRED`, or `PENDING` past expiry | **Late path:** lock seats (id order), try to claim all as `BOOKED` where `AVAILABLE` or stale-`HELD`. **Lock, verify, then update (no savepoints):** with the seats locked, check that every seat is claimable; only then run the `UPDATE`. The locks guarantee nothing changes in between, so it is all-or-nothing by construction. The in-time confirm path works the same way. All claimable → claim all, booking `CONFIRMED`, payment `SUCCESS`, outbox `BookingConfirmed`. Any not claimable → no seat is touched, payment `REFUND_REQUIRED`, booking `EXPIRED` (seats it still holds are released, guarded by `booking_id`), outbox `RefundRequired` |
| success | `INITIATED` | `FAILED` / `CANCELLED` | payment `REFUND_REQUIRED`, outbox `RefundRequired` (no re-claim) |
| failure | `INITIATED` | `PENDING` | payment `FAILED`, booking `FAILED`, seats released (guarded by `booking_id`) |
| failure | `INITIATED` | other | payment `FAILED` only |
| refund succeeded | `REFUND_REQUIRED` | any | payment `REFUNDED` |

### 9.4 Expiry worker

Every `WORKER_INTERVAL` (default 5 s):

```sql
-- claim a batch (multiple workers safe)
SELECT id FROM bookings
WHERE status = 'PENDING' AND expires_at < now()
ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED;
```

Then in the same transaction: set those bookings `EXPIRED`, lock their `HELD` seats in id order, release them with `WHERE booking_id = ANY($ids) AND status = 'HELD'`. The guard means seats already confirmed or taken over are untouched. A booking confirmed at the same instant fails the `status = 'PENDING'` guard and is skipped.

Also: mark payments stuck in `INITIATED` for 15 minutes as `FAILED` (this covers ambiguous gateway outcomes where no webhook arrived), and delete expired idempotency keys. The sweep is safe because a success webhook that arrives later for a `FAILED` payment becomes `REFUND_REQUIRED` (9.3), never a no-op.

### 9.5 Transactional outbox

- Business change and its `outbox_events` row are written in **one transaction**.
- **Claim (transaction 1):** select due rows, either `status = 'PENDING' AND next_attempt_at <= now()` or `status = 'PROCESSING' AND locked_until < now()` (an expired lease left by a crashed worker), with `FOR UPDATE SKIP LOCKED`. Set `status = 'PROCESSING'`, `locked_until = now() + OUTBOX_LEASE_SECONDS` (default 60), commit.
- **Run the consumer outside any transaction**, with a 10 s handler timeout. External calls use an idempotency key (the payment id for refunds).
- **Record the result (transaction 2):** guarded update `WHERE id = $1 AND status = 'PROCESSING'` to `PUBLISHED`.
- On failure: guarded update back to `PENDING` with `retry_count + 1`, `next_attempt_at` with exponential backoff, and `last_error` recorded. After 8 attempts → `FAILED` (inspectable via the admin endpoint).
- A worker that crashes mid-handler never records a result. Its lease expires and another worker re-claims the event, so a handler can run twice. That is why every consumer must be idempotent.
- Delivery is **at-least-once**. Exactly-once is never claimed.
- Consumers:
  - `BookingConfirmed` → insert into `notifications` with `UNIQUE(event_id)`. A duplicate delivery hits the constraint and is ignored.
  - `RefundRequired` → call gateway `POST /refunds` (idempotent by payment id). The gateway confirms by webhook, which moves the payment to `REFUNDED`.

### 9.6 Cancellation (`POST /api/bookings/:id/cancel`)

Transaction (booking → payment → seats): booking must be `CONFIRMED` and `show.starts_at > now()`. Set booking `CANCELLED`, release seats, items `is_confirmed = false`, payment `SUCCESS → REFUND_REQUIRED`, outbox `RefundRequired`. Repeating the call on an already-cancelled booking returns the current state (guarded, naturally idempotent).

### 9.7 Idempotency semantics

- `Idempotency-Key` is **required** on `POST /holds` and `POST /bookings/:id/pay`. Missing → `400 IDEMPOTENCY_KEY_REQUIRED`.
- `request_hash` = SHA-256 of method, path, and canonical body.
- Same key + same hash + completed → stored response replayed. Same key + different hash → `422 IDEMPOTENCY_KEY_REUSED`.
- Concurrent same-key requests serialize on the unique index. The second waits for the first to commit or roll back, then replays or executes.
- Only successful results are stored for holds. A failed hold left no side effects, so re-executing on retry is safe.

---

## 10. API

All routes are under `/api`. Errors share one shape: `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`.

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/register` | — | rate limited |
| POST | `/auth/login` | — | rate limited |
| GET | `/auth/me` | user | |
| GET | `/shows` | — | list upcoming shows |
| GET | `/shows/:id` | — | |
| GET | `/shows/:id/seats` | — | status per label; stale holds shown `AVAILABLE` |
| POST | `/admin/shows` | admin | creates show and its 50 seats |
| GET | `/admin/outbox-events?status=FAILED` | admin | inspect dead events |
| POST | `/holds` | user | body `{ showId, seats: ["A1","A2"] }`, requires Idempotency-Key. `201 { bookingId, status: "PENDING", seats, totalAmount, expiresAt }` |
| POST | `/holds/:bookingId/release` | user | only if `PENDING` and no `INITIATED` payment; booking → `CANCELLED` |
| POST | `/bookings/:id/pay` | user | requires Idempotency-Key. `202 { paymentId, status: "INITIATED" }` |
| GET | `/bookings/me` | user | |
| GET | `/bookings/:id` | user | owner only |
| POST | `/bookings/:id/cancel` | user | see 9.6 |
| POST | `/webhooks/payment` | HMAC | see 9.3 |
| GET | `/health` | — | DB and Redis reachability |

Seat-map read rule: a seat is shown `HELD` only if `status = 'HELD'` and its booking is `PENDING` with `expires_at > now()`; otherwise shown `AVAILABLE` even if the worker has not yet swept it.

### Error codes

| HTTP | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad body, more than 6 seats, duplicate labels |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | Header missing |
| 401 | `UNAUTHENTICATED` | Missing/invalid JWT |
| 401 | `INVALID_SIGNATURE` | Webhook signature or timestamp invalid |
| 403 | `FORBIDDEN` | Role or ownership violation |
| 404 | `NOT_FOUND` | Unknown show/booking, or not owner's booking |
| 409 | `SEAT_UNAVAILABLE` | Any requested seat not claimable |
| 409 | `ACTIVE_HOLD_EXISTS` | User already has a live hold for this show |
| 409 | `BOOKING_NOT_PAYABLE` | Booking not `PENDING`, or expired |
| 409 | `PAYMENT_IN_PROGRESS` | Release attempted with an `INITIATED` payment |
| 409 | `INVALID_STATE` | Illegal transition (e.g. cancel a non-confirmed booking, show already started) |
| 422 | `IDEMPOTENCY_KEY_REUSED` | Same key, different request |
| 429 | `RATE_LIMITED` | Limit exceeded |
| 502 | `PAYMENT_GATEWAY_ERROR` | Gateway definitively rejected the charge (4xx). Timeouts and 5xx do not return this; they keep the stored `202` |
| 503 | `RETRY_LATER` | Deadlock/lock-timeout retries exhausted |

---

## 11. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-01 | Register and log in; passwords hashed with bcrypt; JWT-protected routes | P0 |
| FR-02 | Role check: admin-only routes reject non-admins with `403` | P0 |
| FR-03 | List shows, view a show, view its seat map | P0 |
| FR-04 | Hold 1–6 seats atomically; all-or-nothing | P0 |
| FR-05 | Concurrent holds on the same seat: exactly one succeeds, others get `409` | P0 |
| FR-06 | One live hold per user per show, enforced by a database index | P0 |
| FR-07 | Hold expires after `HOLD_TTL`; worker releases seats; seat map never shows expired holds as held | P0 |
| FR-08 | Pay returns `202`; webhook finalizes payment and booking | P0 |
| FR-09 | Idempotency-Key on hold and pay per section 9.7 | P0 |
| FR-10 | Webhook signature verified; duplicate webhooks are no-ops | P0 |
| FR-11 | A definite payment failure (gateway rejection or failure webhook) fails the booking and releases seats. An ambiguous gateway outcome changes no state | P0 |
| FR-12 | Late payment handled per 9.3: re-claim all or refund, never partial | P0 |
| FR-13 | Outbox written in the same transaction as the state change; worker processes it with leases, retries and backoff (9.5) | P0 |
| FR-14 | Outbox consumers are idempotent (unique `event_id` on notifications) | P0 |
| FR-15 | Mock gateway supports success, failure, delay, timeout (accepts the charge, drops the response), duplicate and late webhooks, refunds | P0 |
| FR-16 | Booking history and booking detail | P1 |
| FR-17 | Whole-booking cancellation with refund flow | P1 |
| FR-18 | Redis rate limiting: auth 10 req/min per IP; holds and pay 30 req/min per user; configurable and disableable for load tests | P1 |
| FR-19 | `GET /admin/outbox-events` for failed events | P1 |
| FR-20 | Minimal React UI: shows, seat grid with countdown, checkout, my bookings | P1 |
| FR-21 | Checkout screen states: amount summary with a **Pay Now** button; a **Processing** state that polls `GET /bookings/:id` every 1–2 s until a terminal status (after 60 s it shows "still processing, check My Bookings"); separate success, payment-failed and hold-expired screens; countdown driven by the server's `expiresAt` | P1 |

---

## 12. Non-functional requirements

**Reliability.** No duplicate confirmed bookings. No partial multi-seat holds. No duplicate payment on same-key retry. Outbox events survive crashes. Worker resumes after restart with no manual intervention.

**Security.** Parameterized SQL only. Zod validation on every body. Secrets from environment variables, never logged. Passwords, tokens, and webhook secrets never appear in logs. JWT secret and webhook secret required at startup or the process exits.

**Observability.** pino JSON logs with request ID. Log booking and payment state transitions (id, from, to). Log worker runs (batch size, duration). `/health` endpoint.

**Maintainability.** Migrations for every schema change. A consistent error class mapped to the table in section 10. No abstraction layers beyond those in section 6.

**Configuration (env).** `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `WEBHOOK_SECRET`, `HOLD_TTL_SECONDS` (300), `MAX_SEATS_PER_HOLD` (6), `WORKER_INTERVAL_MS` (5000), `OUTBOX_LEASE_SECONDS` (60), `PG_POOL_MAX`, `RATE_LIMIT_ENABLED`, `GATEWAY_URL`.

---

## 13. Testing and acceptance

Integration tests run against a **real PostgreSQL**, never mocks.

### Jest (correctness, runs in CI)

| ID | Test | Assertion |
|---|---|---|
| T1 | 1,000 distinct users each hold one seat, request *i* targets seat *i mod 50*, all fired with `Promise.all` | exactly 50 `201`, 950 `SEAT_UNAVAILABLE`, 50 distinct seats `HELD` |
| T2 | 200 users request random overlapping sets of 1–4 seats concurrently | no seat linked to two live bookings; every successful booking holds exactly its requested seats; count of `HELD` seats equals sum of live booking items; no deadlock errors surface |
| T3 | Same `Idempotency-Key` sent 20 times concurrently (hold, then pay) | one booking / one payment |
| T4 | Same key, different body | `422` |
| T5 | Hold, wait past TTL (5 s in tests), run worker | seats `AVAILABLE`, booking `EXPIRED`; another user can hold |
| T6 | Payment success webhook delivered twice | one transition, one outbox event |
| T7 | Payment failure webhook, and separately a definite gateway rejection (4xx) on `/pay` | booking `FAILED`, seats released |
| T8 | Late success, seats still free | booking `CONFIRMED` |
| T9 | Late success, one seat taken by another user | payment `REFUND_REQUIRED`, no seat changed, no `booking_items.is_confirmed` flag changed, no partial confirm |
| T10 | Webhook with bad signature or stale timestamp | `401`, no state change |
| T11 | Kill worker mid-handler while it holds a lease, restart | after the lease expires the event is re-claimed and processed; exactly one notification row |
| T12 | Two worker instances run concurrently | no event processed twice, no seat released twice |
| T13 | Redis stopped | API keeps working; limiter fails open |
| T14 | Webhook confirm races worker expiry on the same booking (forced interleaving) | exactly one outcome; seats consistent with booking status |
| T15 | Attempt to insert two `is_confirmed` items for one seat directly via SQL | database rejects it |
| T16 | Cancel confirmed booking twice | seats released once, one refund event |
| T17 | Payment swept to `FAILED` by the worker, then a success webhook arrives | payment `REFUND_REQUIRED`, one `RefundRequired` event, booking unchanged |
| T18 | Gateway times out on `/pay` (ambiguous outcome), then a success webhook arrives | after the timeout the payment is still `INITIATED` and the booking `PENDING`; the webhook then confirms the booking |
| T19 | Hold seats with a 5 s TTL, wait past expiry but do **not** run the worker; another user holds the same seats | takeover succeeds; old booking still `PENDING` until the worker runs, then `EXPIRED`; the worker's release does not touch the taken-over seats |

### k6 (latency, reported not asserted for G2)

- Pre-generate 1,000 JWTs in a setup script. Disable the rate limiter for this run and say so in the README.
- Scenario A: 1,000-user spike on 50 seats. Report throughput, p50/p95/p99, error breakdown.
- Scenario B: 50 VUs steady for 60 s mixing seat-map reads and holds. Compare to G7 targets.
- Record machine specs, `PG_POOL_MAX`, and Postgres settings next to the numbers.

### MVP acceptance criteria

1. T1–T19 pass, and GitHub Actions CI runs Jest against a PostgreSQL service container.
2. G1–G6 met; G7 measured and reported honestly.
3. `docker compose up` runs the full system from a clean clone, with a seed script creating an admin and a sample show.
4. README contains: architecture diagram, state machines, schema, the concurrency rules (section 9), test and k6 results, and a "decisions and trade-offs" section.
5. A short demo recording of the race scenario and the late-payment scenario.

Deployment is a bonus. Many free tiers do not run background workers, so verify before committing to a host.

---

## 14. Milestones

| Week | Deliverable |
|---|---|
| 1 | Repo, TypeScript, Docker Compose (Postgres, Redis), CI, migrations for all tables and constraints, auth, shows, seat map, seed script |
| 2 | Hold algorithm (9.1), release, deadlock handling, **expiry worker (9.4, expiry only)**; **T1, T2, T5, T19 passing**. Demoable: hold, race, expiry |
| 3 | Mock gateway, pay flow, happy-path webhook (9.3), then idempotency (9.7); **T3, T4, T6, T10** |
| 4 | Failure and edge paths: payment failure, ambiguous timeout, late payment, cancellation; **T7, T8, T9, T14, T16, T17, T18** |
| 5 | Outbox, leases, consumers, refunds; **T11, T12**. **P0 complete.** Then rate limiting, logging, `/health`, admin outbox endpoint, T13 |
| 6 | k6 runs and performance fixes, naive-vs-fixed demo (a deliberately broken `SELECT`-then-`UPDATE` hold that T1 shows overselling), React UI (max 3 days; cut it before cutting tests), README, diagrams, demo recording, optional deploy |

If anything slips, cut in this order: deployment → UI polish → admin outbox endpoint → outbox leases (fall back to the simple claim for the notification consumer, which also means dropping or rewriting T11 and the R7 lease story). Keep T17 and T18: they guard money correctness. Never cut the remaining tests among T1–T19. Six weeks is a target, not a deadline: if the schedule and the tests conflict, the schedule moves.

---

## 15. Decisions log and known limitations

| Decision | Chosen | Rejected | Reason |
|---|---|---|---|
| Payment failure | Fail booking, release seats | Keep hold for retry | One payment per booking keeps the model small; costs ~2–3 days otherwise |
| Late payment | Re-claim all or refund | Always refund | Reuses the atomic claim code; stronger design story |
| Cancellation | Whole booking only | Partial | Partial needs item splitting and partial refunds |
| Hold model | Hold = `PENDING` booking | Separate holds table | One expiry authority, no drift |
| Expiry authority | `bookings.expires_at` | `seats.held_until` | Single source; old booking stays findable by the worker after a takeover |
| DB access | Raw SQL | ORM | Locks and atomic updates must be visible |
| Events | Postgres outbox + in-worker consumers | Kafka | Same reliability lesson, far less operational weight |
| Outbox processing | Lease: claim, call out, record result | Row lock held across the handler | No HTTP calls inside transactions; crashed workers recovered by lease expiry |
| Gateway timeout | Leave state unchanged, let the webhook decide | Treat as failure | A timeout does not prove the charge failed; failing the booking risks charging the customer with no booking |
| Redis | Rate limiting only | Seat-map cache by default | 50 seats do not need a cache; add only with k6 evidence |

**Known limitations (documented, not bugs)**

- If the API crashes after the `/pay` commit but before the gateway call, the payment stays `INITIATED` and the gateway never sees a charge. A same-key retry replays the stored `202` without calling the gateway. The hold expires within `HOLD_TTL` and the user re-holds; the sweep fails the orphaned payment. No re-drive job is built.
- A lost webhook leaves a payment `INITIATED` until the stuck-payment sweep, and the checkout UI may show "Processing" until then. There is no gateway polling (non-goal).
- `now()` inside a transaction is the transaction start time. Confirmations can land slightly after the nominal expiry by the length of a lock wait. This is safe because seat ownership is still verified by guarded updates.
- A slow consumer whose lease expires can overlap with a second worker running the same event. Consumers are idempotent, so this is safe. Keep the lease (60 s) well above the handler timeout (10 s).
- Delivery is at-least-once. Consumers must tolerate duplicates.

---

## 16. Repository structure

```
seatlock/
├── apps/
│   ├── api/src/          config, routes, controllers, services, repositories, middleware, validators, utils, server.ts
│   ├── worker/src/       jobs (expireHolds, processOutbox, sweepPayments, cleanupKeys), consumers, index.ts
│   └── mock-gateway/src/ routes (charges, refunds, __control), webhookSender, index.ts
├── packages/db/          migrations/, pool.ts, seed.ts
├── frontend/src/         components, pages, hooks, services
├── tests/                integration/, k6/
├── docs/                 architecture.md, decisions/
├── docker-compose.yml
├── .env.example
└── README.md
```
