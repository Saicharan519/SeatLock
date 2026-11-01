# SeatLock

A ticket-booking backend (BookMyShow-style) built around one guarantee:

> **For a given show and seat, at most one CONFIRMED booking exists at any time, regardless of concurrent requests, retries, crashes or late payments.**

PostgreSQL enforces it with row locks, guarded updates and constraints, not just application code. A partial unique index makes a double-sold seat impossible even if the code has a bug.

[![CI](https://github.com/Saicharan519/SeatLock/actions/workflows/ci.yml/badge.svg)](https://github.com/Saicharan519/SeatLock/actions/workflows/ci.yml)

> **Status:** work in progress, Phases 0–5 of 10 complete. See [docs/PROGRESS.md](docs/PROGRESS.md).

## What's proven so far

- **1,000 concurrent holds on 50 seats → exactly 50 succeed**, 950 get a clean `409 SEAT_UNAVAILABLE`, zero errors (T1)
- **200 random overlapping multi-seat holds → zero deadlocks**, by Postgres's own counter (T2)
- **The same request sent 20 times at once → one payment and one gateway call** (idempotency keys)
- **Payment-gateway timeouts never fail a booking**; signed webhooks decide, duplicates are no-ops
- **Late payments re-claim all seats or refund**, never partially confirm
- 69 integration tests against a real PostgreSQL, green in CI

Measured numbers and machine specs: [docs/results.md](docs/results.md).

## Architecture

```
Client ──REST──▶ API (Express, TS) ──SQL──▶ PostgreSQL (source of truth)
                   │      ▲                      ▲
                   │      │ signed webhook       │ FOR UPDATE SKIP LOCKED
                   ▼      │                      │
           Mock payment gateway          Worker (separate process)
                                           • expire abandoned holds
                                           • fail payments with no webhook
                                           • clean up idempotency keys
                                           • (Phase 6) deliver outbox events
```

- **Three processes, one repo:** `apps/api`, `apps/worker`, `apps/mock-gateway`; shared code in `packages/db` and `packages/shared`.
- **Raw parameterized SQL**, no ORM, so locks and atomic updates are explicit.
- **Redis** is used for rate limiting only (Phase 7).

## Stack

Node.js 24 · TypeScript · Express 5 · PostgreSQL 16 · Redis · Zod · pino · Jest + Supertest · GitHub Actions

## Running it locally

Requires Node.js 22+ and Docker.

```bash
npm ci
cp .env.example .env
docker compose up -d          # Postgres (host port 5433) and Redis
npm run migrate:up
npm run seed                  # admin@seatlock.local / admin12345 + a sample show
```

In three terminals:

```bash
npm run dev:api               # http://localhost:3000
npm run dev:gateway           # mock payment gateway on :4000
npm run dev:worker
```

Run the tests (uses a separate `seatlock_test` database):

```bash
npm test
```

## API overview

| Method | Path                                                   | Notes                                                             |
| ------ | ------------------------------------------------------ | ----------------------------------------------------------------- |
| POST   | `/api/auth/register`, `/api/auth/login`                | Returns a JWT                                                     |
| GET    | `/api/shows`, `/api/shows/:id`, `/api/shows/:id/seats` | Seat map treats expired holds as available                        |
| POST   | `/api/holds`                                           | Hold 1–6 seats for 5 minutes. Requires `Idempotency-Key`          |
| POST   | `/api/holds/:bookingId/release`                        | Give up a hold                                                    |
| POST   | `/api/bookings/:id/pay`                                | `202`; the gateway's webhook confirms. Requires `Idempotency-Key` |
| GET    | `/api/bookings/me`, `/api/bookings/:id`                | History and detail                                                |
| POST   | `/api/bookings/:id/cancel`                             | Whole-booking cancellation with refund                            |
| POST   | `/api/webhooks/payment`                                | HMAC-signed gateway callbacks                                     |
| POST   | `/api/admin/shows`                                     | Admin only; creates a show and its 50 seats                       |
| GET    | `/api/health`                                          | Database reachability                                             |

Errors share one shape: `{ "error": { "code", "message", "requestId" } }`.

## Documentation

| Doc                                    | What's in it                                                                |
| -------------------------------------- | --------------------------------------------------------------------------- |
| [prd.md](prd.md)                       | Product requirements, concurrency rules, state machines                     |
| [docs/PROGRESS.md](docs/PROGRESS.md)   | Phase status, acceptance-test checklist                                     |
| [docs/decisions.md](docs/decisions.md) | Every design decision and trade-off, plus known limitations                 |
| [docs/results.md](docs/results.md)     | Measured results and environment                                            |
| [docs/phases/](docs/phases/)           | A detailed write-up of each phase: what was built, why, and what went wrong |
