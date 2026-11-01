# Results log

Measured numbers only. Every figure says where and when it was measured. Per the PRD (G7), report what was actually measured, with machine specs, and never round up.

## Environment

|            |                                                                                   |
| ---------- | --------------------------------------------------------------------------------- |
| Machine    | Lenovo laptop, Intel Core i5-12450H (8 cores / 12 threads), 15.7 GB RAM           |
| OS         | Windows 11 Home Single Language (10.0.26200)                                      |
| Docker     | Docker Desktop 29.8.2; VM limited to 12 CPUs, 7.6 GB RAM                          |
| PostgreSQL | 16.14 (Alpine image), defaults: `max_connections = 100`, `shared_buffers = 128MB` |
| Node.js    | 24.20.0                                                                           |
| API pool   | `PG_POOL_MAX = 20`, acquire timeout 30 s (tests: 60 s)                            |
| Timeouts   | `statement_timeout = 5s`, `lock_timeout = 3s`                                     |

## Test suite

Measured 2026-11-01 after Phase 7, on the machine above.

| Measure                | Result                                                                                                                                                                                                                                        |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests                  | **101 passed / 101** (17 files)                                                                                                                                                                                                               |
| Full suite wall time   | 68 s on Windows; 109 s in a Linux container (incl. Jest startup). After Phase 6: 70–71 s with 82 tests                                                                                                                                        |
| Consecutive green runs | Phase 7 files: 2 of 2 each, plus full suite on Windows and Linux                                                                                                                                                                              |
| GitHub Actions (Linux) | Green on every push: Phase 3 run 80 s, Phase 4 run 56 s, Phase 5 run 56 s, Phase 6 first run 640 s (an orphaned test process, fixed), after the fix 52 s, Phase 7 106 s with the added Redis service and 19 more tests (job time incl. setup) |

### Key tests

| Test                                                                   | Duration                                                                  | Result                                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **T1**: 1,000 concurrent holds on 50 seats                             | 7.5 s (includes creating 1,000 users and the show)                        | Exactly 50 × `201`, 950 × `409 SEAT_UNAVAILABLE`, **0 × 503**, 50 distinct seats HELD                |
| **T2**: 200 random overlapping 1–4-seat holds                          | 3.1 s                                                                     | No partial holds, no shared seats, HELD count = live items, **0 deadlocks** (Postgres's own counter) |
| **T3**: same key ×20 concurrently                                      | 0.5 s (hold), 0.5 s (pay)                                                 | 1 booking / 1 payment / **1 gateway call**, 19 replays                                               |
| **T14**: 20 randomized three-way races (webhook + worker + rival hold) | 3.1 s                                                                     | 20 / 20 consistent. Outcome mix over three runs: 2/18, 1/19, 2/18 (we won / rival won)               |
| **T18**: gateway timeout, then webhook                                 | 1.9 s (500 ms client timeout + 1.5 s delayed webhook)                     | 202 with nothing changed, then CONFIRMED                                                             |
| T5 / T19: expiry with the 5 s test TTL                                 | 6.0 s / 5.8 s                                                             | Pass (real waiting, no clock tricks)                                                                 |
| Two workers over 150 stale holds                                       | 0.7 s                                                                     | Each booking expired exactly once                                                                    |
| **T11**: worker process killed with `SIGKILL` mid-handler              | 3.1 s (includes starting the child process and waiting out its 2 s lease) | Event re-claimed (`retry_count = 1`), PUBLISHED, **exactly 1 notification**                          |
| **T12** (outbox): two workers over 60 events, batches of 7             | 0.3 s                                                                     | All 60 handled **exactly once**, both workers took part                                              |
| Outbox backoff, base 10 s                                              | 0.2 s                                                                     | Successive delays measured at **10 s, 20 s, 40 s**                                                   |
| **S9** end to end: cancel → gateway refund → webhook                   | 0.7 s                                                                     | Payment REFUNDED; the gateway received 1 refund call                                                 |
| Refund consumer run twice                                              | 0.9 s                                                                     | **2 refund calls, 1 refund**, 1 `refund.succeeded` webhook                                           |
| Rate limit: 25 concurrent logins, limit 10                             | 0.4 s                                                                     | **Exactly 10 allowed, 15 × 429** (atomic Lua increment + expiry)                                     |
| **T13**: Redis unreachable, full register → login → hold → pay         | 0.3 s                                                                     | All succeed, no rate-limit headers, under the 3 s bound                                              |
| **T13**: Redis frozen with `CLIENT PAUSE`                              | 1.0 s (test incl. setup)                                                  | Login allowed through by the 250 ms command timeout, under the 1.5 s bound                           |

**These are correctness tests, not benchmarks.** T1's 7.5 s includes test setup and the test client's own overhead (supertest, a 200-socket pool on Windows). Latency and throughput will be measured with k6 in Phase 8.

## Observations worth knowing

- **On this machine the T1 burst takes longer than the 5 s test TTL.** With the test TTL, late requests found early holds expired and correctly took them over: 100 "winners" for 50 seats, but never two _live_ holds on one seat. T1 now runs with the production TTL. ([Phase 3 write-up](phases/phase-3-holds-and-expiry.md))
- **Desktop Windows caps the TCP accept queue at about 200**, so 1,000 simultaneous connects get `ECONNREFUSED` regardless of the backlog Node requests. Linux CI doesn't have this limit.
- **Zero deadlocks** in T2 according to `pg_stat_database.deadlocks`, which supports rule R2 (lock seats in ascending id order).

## Linux verification

2026-11-01, Phase 7. Full suite in a `node:24-alpine` container with Postgres and Redis: **101 / 101 passed, Jest exited cleanly, 109 s**.

2026-11-01, Phase 6. Full suite run inside a `node:24-alpine` container (Linux, fresh `npm ci`) against the same Postgres: **82 / 82 passed, Jest exited cleanly, 85 s**. Done because Windows had hidden an orphaned-process bug in T11 that made the first Phase 6 CI run hang (see the [Phase 6 write-up](phases/phase-6-outbox.md)).

## Real-process smoke tests

**2026-11-01, Phase 4.** API and mock gateway started as separate processes (`tsx`), seeded database, driven with `curl`:
register → list shows → seat map → hold A1 (₹250.00) → pay (`202 INITIATED`) → gateway webhook delivered on the first attempt → booking **CONFIRMED**, payment SUCCESS, within 1 second.

**2026-11-01, Phase 6.** API, mock gateway **and worker** (1 s tick) as three processes:
hold → pay → **CONFIRMED** (1.5 s later) → worker published `BookingConfirmed` (1 notification) → cancel → worker published `RefundRequired` → gateway refund webhook → payment **REFUNDED** (within 3 s of the cancel).

**2026-11-01, Phase 7 (T13 with a real outage).** API running, real Redis container:

- Redis up: 11 bad logins → 10 × `401`, then `429`. Health `ok`.
- `docker compose stop redis`: 5 more logins → all `401` (allowed, wrong password), no `429`, no hang (231 ms average per request incl. bcrypt and curl). Health `degraded`, HTTP 200. Logs: "redis unavailable", "rate limiter failing open".
- `docker compose start redis`: the API logged "redis connected" about 3 s later on its own; 11 bad logins → 10 × `401`, then `429` again. Health `ok`.

## Load tests (k6)

Not run yet. Phase 8 will record here:

- **Scenario A:** 1,000-user spike on 50 seats: throughput, p50/p95/p99, error breakdown.
- **Scenario B:** 50 VUs steady for 60 s mixing seat-map reads and holds, against the targets p95 seat map < 300 ms and p95 hold < 500 ms (G7).
- Rate limiter disabled for these runs (and stated), `PG_POOL_MAX`, Postgres settings, machine specs as above.
