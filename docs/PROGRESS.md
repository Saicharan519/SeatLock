# SeatLock progress

Last updated: 2026-11-01, after Phase 8.

## Phases

| Phase                         | Status      | Commit                   | CI                                                                                                                         | Tests after | Write-up                                      |
| ----------------------------- | ----------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------- | --------------------------------------------- |
| 0 Setup                       | Done        | `431a4e6`                | n/a (no remote yet)                                                                                                        |             | [phase-0-2](phases/phase-0-2-foundation.md)   |
| 1 Foundation                  | Done        | `431a4e6`                | n/a                                                                                                                        | 8           | [phase-0-2](phases/phase-0-2-foundation.md)   |
| 2 Auth, shows, seat map, seed | Done        | `431a4e6`                | n/a                                                                                                                        | 20          | [phase-0-2](phases/phase-0-2-foundation.md)   |
| 3 Holds and expiry            | Done        | `b47e714`                | [passed](https://github.com/Saicharan519/SeatLock/actions/runs/41315572400) (first CI run; covers Phases 0–3)              | 36          | [phase-3](phases/phase-3-holds-and-expiry.md) |
| 4 Payments and webhooks       | Done        | `d9a6a35`                | [passed](https://github.com/Saicharan519/SeatLock/actions/runs/41316616029)                                                | 54          | [phase-4](phases/phase-4-payments.md)         |
| 5 Failure and edge paths      | Done        | `afa4a23`                | [passed](https://github.com/Saicharan519/SeatLock/actions/runs/41318197495)                                                | 69          | [phase-5](phases/phase-5-failure-paths.md)    |
| 6 Outbox and consumers        | Done        | `b343ed3`, fix `959b59f` | [passed](https://github.com/Saicharan519/SeatLock/actions/runs/41327978843) (52 s; the first run took 640 s, see write-up) | 82          | [phase-6](phases/phase-6-outbox.md)           |
| 7 Hardening and observability | Done        | `0115410`                | [passed](https://github.com/Saicharan519/SeatLock/actions/runs/41332550345) (1 min 46 s, now with a Redis service)         | 101         | [phase-7](phases/phase-7-hardening.md)        |
| 8 Performance proof (k6)      | Done        | `5f2a26b`                | [passed](https://github.com/Saicharan519/SeatLock/actions/runs/41335794582) (1 min 4 s)                                    | 103         | [phase-8](phases/phase-8-performance.md)      |
| 9 Frontend                    | **Next**    |                          |                                                                                                                            |             |                                               |
| 10 Polish and delivery        | Not started |                          |                                                                                                                            |             |                                               |

**All P0 functional requirements are now implemented** (PRD milestone "P0 complete").

## PRD acceptance tests (T1–T19)

| Test | What it proves                                                                                     | Status                                                                                                     | Where                                                                                                          |
| ---- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| T1   | 1,000 users race for 50 seats: exactly 50 win, 950 `SEAT_UNAVAILABLE`, zero 503s                   | Pass (since Phase 8, same-seat requests genuinely contend)                                                 | [concurrency.test.ts](../tests/integration/concurrency.test.ts)                                                |
| T2   | 200 random overlapping multi-seat holds: no partial or shared seats, zero deadlocks                | Pass                                                                                                       | [concurrency.test.ts](../tests/integration/concurrency.test.ts)                                                |
| T3   | Same idempotency key ×20 concurrently: one booking (hold) and one payment + one gateway call (pay) | Pass                                                                                                       | [holds.test.ts](../tests/integration/holds.test.ts), [payments.test.ts](../tests/integration/payments.test.ts) |
| T4   | Same key, different body → 422                                                                     | Pass                                                                                                       | [holds.test.ts](../tests/integration/holds.test.ts)                                                            |
| T5   | Hold expires after TTL, worker frees seats, others can hold                                        | Pass                                                                                                       | [expiry.test.ts](../tests/integration/expiry.test.ts)                                                          |
| T6   | Duplicate success webhook → one transition, one outbox event                                       | Pass                                                                                                       | [webhooks.test.ts](../tests/integration/webhooks.test.ts)                                                      |
| T7   | Failure webhook and gateway 4xx rejection → booking FAILED, seats freed                            | Pass                                                                                                       | [payments.test.ts](../tests/integration/payments.test.ts)                                                      |
| T8   | Late success, seats free → CONFIRMED                                                               | Pass                                                                                                       | [latePayment.test.ts](../tests/integration/latePayment.test.ts)                                                |
| T9   | Late success, a seat taken → REFUND_REQUIRED, nothing else changes                                 | Pass                                                                                                       | [latePayment.test.ts](../tests/integration/latePayment.test.ts)                                                |
| T10  | Bad signature or stale timestamp → 401, no state change                                            | Pass                                                                                                       | [webhooks.test.ts](../tests/integration/webhooks.test.ts)                                                      |
| T11  | Worker killed mid-handler: lease expires, event re-claimed, one notification                       | Pass (real `SIGKILL` of a separate worker process)                                                         | [outbox.test.ts](../tests/integration/outbox.test.ts)                                                          |
| T12  | Two worker instances: no event processed twice, no seat released twice                             | Pass (outbox: 60 events, two workers; seats: 150 holds, two workers)                                       | [outbox.test.ts](../tests/integration/outbox.test.ts), [expiry.test.ts](../tests/integration/expiry.test.ts)   |
| T13  | Redis stopped → API keeps working, limiter fails open                                              | Pass (unreachable, dropping mid-run, and frozen Redis; also verified by stopping the real Redis container) | [rateLimit.test.ts](../tests/integration/rateLimit.test.ts)                                                    |
| T14  | Webhook confirm races worker expiry: one consistent outcome                                        | Pass                                                                                                       | [latePayment.test.ts](../tests/integration/latePayment.test.ts)                                                |
| T15  | Database rejects two confirmed items for one seat                                                  | Pass                                                                                                       | [schema.test.ts](../tests/integration/schema.test.ts)                                                          |
| T16  | Cancel twice → seats released once, one refund event                                               | Pass                                                                                                       | [cancellation.test.ts](../tests/integration/cancellation.test.ts)                                              |
| T17  | Payment swept to FAILED, then success webhook → REFUND_REQUIRED                                    | Pass                                                                                                       | [sweeps.test.ts](../tests/integration/sweeps.test.ts)                                                          |
| T18  | Gateway timeout: state unchanged, then webhook confirms                                            | Pass                                                                                                       | [payments.test.ts](../tests/integration/payments.test.ts)                                                      |
| T19  | Stale-hold takeover before the sweep; sweep leaves the new owner alone                             | Pass                                                                                                       | [expiry.test.ts](../tests/integration/expiry.test.ts)                                                          |

**All 19 pass.**

## Core scenarios (S1–S10)

| Scenario              | Status                                                                 |
| --------------------- | ---------------------------------------------------------------------- |
| S1 Normal booking     | Pass (end to end with the real mock gateway)                           |
| S2 Race               | Pass (T1)                                                              |
| S3 Abandoned checkout | Pass (T5, plus the seat-map read-time check)                           |
| S4 Double-click Pay   | Pass (T3)                                                              |
| S5 Crash after commit | Pass (outbox delivers after restart; T11 kills a real worker)          |
| S6 Late payment       | Pass (T8, T9; refund delivered end to end)                             |
| S7 Payment fails      | Pass (T7)                                                              |
| S8 Duplicate webhook  | Pass (end to end)                                                      |
| S9 Cancellation       | Pass (cancel → gateway refund → refund webhook → REFUNDED, end to end) |
| S10 Gateway timeout   | Pass (T18)                                                             |

**All 10 scenarios pass.**

## Test inventory (103 tests, 18 files)

| File                  | Tests | Covers                                                                                    |
| --------------------- | ----- | ----------------------------------------------------------------------------------------- |
| schema.test.ts        | 6     | DB constraints, T15                                                                       |
| health.test.ts        | 4     | Health check (ok / degraded / disabled), error shape                                      |
| auth.test.ts          | 5     | Register, login, JWT, timing-safe login                                                   |
| shows.test.ts         | 7     | Shows, seat map read-time check, admin create                                             |
| holds.test.ts         | 11    | Holds, validation, idempotency (T3, T4), release                                          |
| concurrency.test.ts   | 2     | T1, T2                                                                                    |
| expiry.test.ts        | 3     | T5, T19, two concurrent workers                                                           |
| payments.test.ts      | 8     | End to end: S1, S8, T3 (pay), T7, T18                                                     |
| webhooks.test.ts      | 10    | T6, T10, decision table                                                                   |
| latePayment.test.ts   | 8     | T8, T9, T14                                                                               |
| cancellation.test.ts  | 4     | S9 (cancel), T16                                                                          |
| sweeps.test.ts        | 3     | T17, payment sweep, key cleanup                                                           |
| outbox.test.ts        | 10    | S5, T11, T12, retries, backoff, timeouts, fencing, poison events                          |
| refunds.test.ts       | 3     | S9 end to end, late-payment refund, refund idempotency                                    |
| rateLimit.test.ts     | 8     | FR-18 limits, atomic counting, T13 (three Redis failure shapes)                           |
| admin.test.ts         | 5     | FR-19 outbox inspection and retry                                                         |
| transitionLog.test.ts | 4     | Transition logging after commit only, afterCommit semantics                               |
| naiveRace.test.ts     | 2     | Naive read-then-write oversells; database blocks double confirmation; SeatLock exactly 50 |

## Performance (Phase 8)

| Measure                      | Result                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| G7 p95 seat map < 300 ms     | **Met**: 46–62 ms (50 VUs, 60 s, 1,046–1,263 req/s)                                |
| G7 p95 hold < 500 ms         | **Met**: 117–164 ms                                                                |
| Spike: 1,000 users, 50 seats | Always 50 × 201 / 950 × 409, 0 failures, 0 deadlocks; drains in 2.8–4.1 s          |
| Naive vs SeatLock            | Naive tells 524–785 customers they hold one of 50 seats; SeatLock tells exactly 50 |

Details: [results.md](results.md).

## Remaining work

- **Phase 9:** React UI (max 3 days).
- **Phase 10:** full README, diagrams, Docker Compose for all services, demo recording.
