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

Measured 2026-11-01 after Phase 8, on the machine above.

| Measure                | Result                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests                  | **103 passed / 103** (18 files)                                                                                                                                                                                                                                                                                                                   |
| Full suite wall time   | 106 s on Windows (the naive race demo test adds ~25 s); 111 s in a Linux container on the compose network. After Phase 7: 68 s with 101 tests                                                                                                                                                                                                     |
| Consecutive green runs | Concurrency tests 3 of 3 with contended ordering; naive race test 5 of 5 on Linux; full suite on Windows and Linux                                                                                                                                                                                                                                |
| GitHub Actions (Linux) | Green on every push: Phase 3 run 80 s, Phase 4 run 56 s, Phase 5 run 56 s, Phase 6 first run 640 s (an orphaned test process, fixed), after the fix 52 s, Phase 7 106 s with the added Redis service and 19 more tests, Phase 8 64 s, Phase 9: two failed runs (the new frontend job, a hidden dependency), fixed run 76 s (job time incl. setup) |

### Key tests

| Test                                                                                                                 | Duration                                                                  | Result                                                                                               |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **T1**: 1,000 concurrent holds on 50 seats (since Phase 8: same-seat requests fired together, so they truly contend) | 7.5 s (includes creating 1,000 users and the show)                        | Exactly 50 × `201`, 950 × `409 SEAT_UNAVAILABLE`, **0 × 503**, 50 distinct seats HELD                |
| **T2**: 200 random overlapping 1–4-seat holds                                                                        | 3.1 s                                                                     | No partial holds, no shared seats, HELD count = live items, **0 deadlocks** (Postgres's own counter) |
| **T3**: same key ×20 concurrently                                                                                    | 0.5 s (hold), 0.5 s (pay)                                                 | 1 booking / 1 payment / **1 gateway call**, 19 replays                                               |
| **T14**: 20 randomized three-way races (webhook + worker + rival hold)                                               | 3.1 s                                                                     | 20 / 20 consistent. Outcome mix over three runs: 2/18, 1/19, 2/18 (we won / rival won)               |
| **T18**: gateway timeout, then webhook                                                                               | 1.9 s (500 ms client timeout + 1.5 s delayed webhook)                     | 202 with nothing changed, then CONFIRMED                                                             |
| T5 / T19: expiry with the 5 s test TTL                                                                               | 6.0 s / 5.8 s                                                             | Pass (real waiting, no clock tricks)                                                                 |
| Two workers over 150 stale holds                                                                                     | 0.7 s                                                                     | Each booking expired exactly once                                                                    |
| **T11**: worker process killed with `SIGKILL` mid-handler                                                            | 3.1 s (includes starting the child process and waiting out its 2 s lease) | Event re-claimed (`retry_count = 1`), PUBLISHED, **exactly 1 notification**                          |
| **T12** (outbox): two workers over 60 events, batches of 7                                                           | 0.3 s                                                                     | All 60 handled **exactly once**, both workers took part                                              |
| Outbox backoff, base 10 s                                                                                            | 0.2 s                                                                     | Successive delays measured at **10 s, 20 s, 40 s**                                                   |
| **S9** end to end: cancel → gateway refund → webhook                                                                 | 0.7 s                                                                     | Payment REFUNDED; the gateway received 1 refund call                                                 |
| Refund consumer run twice                                                                                            | 0.9 s                                                                     | **2 refund calls, 1 refund**, 1 `refund.succeeded` webhook                                           |
| Rate limit: 25 concurrent logins, limit 10                                                                           | 0.4 s                                                                     | **Exactly 10 allowed, 15 × 429** (atomic Lua increment + expiry)                                     |
| **T13**: Redis unreachable, full register → login → hold → pay                                                       | 0.3 s                                                                     | All succeed, no rate-limit headers, under the 3 s bound                                              |
| **T13**: Redis frozen with `CLIENT PAUSE`                                                                            | 1.0 s (test incl. setup)                                                  | Login allowed through by the 250 ms command timeout, under the 1.5 s bound                           |

**These are correctness tests, not benchmarks.** T1's 7.5 s includes test setup and the test client's own overhead (supertest, a 200-socket pool on Windows). Latency and throughput will be measured with k6 in Phase 8.

## Observations worth knowing

- **On this machine the T1 burst takes longer than the 5 s test TTL.** With the test TTL, late requests found early holds expired and correctly took them over: 100 "winners" for 50 seats, but never two _live_ holds on one seat. T1 now runs with the production TTL. ([Phase 3 write-up](phases/phase-3-holds-and-expiry.md))
- **Desktop Windows caps the TCP accept queue at about 200**, so 1,000 simultaneous connects get `ECONNREFUSED` regardless of the backlog Node requests. Linux CI doesn't have this limit.
- **Zero deadlocks** in T2 according to `pg_stat_database.deadlocks`, which supports rule R2 (lock seats in ascending id order).
- **Until Phase 8, T1 barely contended for the same seat**: requests fired in order _i_ put same-seat users 50 apart in a queue that runs 20 at a time. Found by the naive-vs-fixed demo, which failed to oversell under that ordering. T1 now fires same-seat requests together and still passes (3 of 3).

## Linux verification

2026-11-01, Phase 8. Full suite in a `node:24-alpine` container **on the compose network** (direct to `postgres:5432` and `redis:6379`): **103 / 103 passed, clean exit, 111 s**. Earlier runs reached the databases through `host.docker.internal`; that path occasionally dropped new connections (`connect ETIMEDOUT`) under the race demo's bursts, a flaw of the verification setup, not the app.

2026-11-01, Phase 7. Full suite in a `node:24-alpine` container with Postgres and Redis: **101 / 101 passed, Jest exited cleanly, 109 s**.

2026-11-01, Phase 6. Full suite run inside a `node:24-alpine` container (Linux, fresh `npm ci`) against the same Postgres: **82 / 82 passed, Jest exited cleanly, 85 s**. Done because Windows had hidden an orphaned-process bug in T11 that made the first Phase 6 CI run hang (see the [Phase 6 write-up](phases/phase-6-outbox.md)).

## Frontend verification

2026-11-02, Phase 9. Every flow driven in a real browser (1280×800, plus 375 px mobile) against the running API (45-second holds for testing), mock gateway and worker. Measured highlights:

| Check                              | Result                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Production bundle                  | 340.6 KB JS (106.7 KB gzipped), 21 KB CSS (4.9 KB gzipped)                                              |
| Another user takes a selected seat | Removed from the selection and announced within one 2 s refresh                                         |
| **Pay clicked twice**              | **1 payment, 1 idempotency key, 1 gateway charge** (database and gateway log)                           |
| Failure by webhook                 | Processing → "Payment failed" after ~1.6 s                                                              |
| Slow gateway (75 s)                | "Taking longer" message at 62 s (requirement: after 60 s); late webhook confirmed via the re-claim path |
| Cancel                             | "Refund on its way" at 0.5 s → "Refunded" at 3.0 s (worker tick 1 s)                                    |
| Seat map at 375 px                 | 328 px wide, 24 px seats, no sideways scrolling                                                         |
| Keyboard                           | Tab reaches seats with a visible focus outline; held and booked seats skipped                           |

Full list in the [Phase 9 write-up](phases/phase-9-frontend.md).

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

Measured 2026-11-01, Phase 8. Reproduce with `npm run loadtest:spike` and `npm run loadtest:steady` (see [tests/k6/run.sh](../tests/k6/run.sh)).

**Setup, stated as the PRD requires:**

- **Rate limiting DISABLED** for these runs (`RATE_LIMIT_ENABLED=false`); otherwise the limiter, not the system, would be measured.
- API: one Node.js 24 process in a `node:24-alpine` container, `NODE_ENV=production`, `LOG_LEVEL=warn`, run through `tsx` (no build step), **`PG_POOL_MAX=20`** unless stated.
- k6 2.3.0 (`grafana/k6` image) and the API on the **same Docker network** as Postgres, so no request crosses the Windows network stack.
- PostgreSQL 16.14 with **default settings** (`max_connections = 100`, `shared_buffers = 128MB`), dedicated `seatlock_load` database reset before each run.
- 1,000 users with JWTs pre-generated by [setup.ts](../tests/k6/setup.ts); no login traffic during measurement.
- Machine as in [Environment](#environment); all containers share the Docker Desktop VM (12 CPUs, 7.6 GB).

### Scenario A: 1,000-user spike on 50 seats (reported, not asserted)

1,000 virtual users, one hold each, all started at once; 20 users per seat, firing together.

| Run (`PG_POOL_MAX=20`) | Drain time | Throughput | p50      | p95      | p99      | max      | 201 | 409 | Other | Failed |
| ---------------------- | ---------- | ---------- | -------- | -------- | -------- | -------- | --- | --- | ----- | ------ |
| 1                      | 4.06 s     | 246 req/s  | 2,113 ms | 3,007 ms | 3,095 ms | 3,114 ms | 50  | 950 | 0     | 0      |
| 2                      | 3.35 s     | 299 req/s  | 1,579 ms | 2,341 ms | 2,456 ms | 2,487 ms | 50  | 950 | 0     | 0      |
| 3                      | 2.84 s     | 352 req/s  | 1,399 ms | 2,076 ms | 2,166 ms | 2,187 ms | 50  | 950 | 0     | 0      |

After every run: 50 seats HELD by 50 distinct bookings, **0 seats in two live bookings, 0 deadlocks**.

**Pool-size experiment** (earlier runs, before same-seat requests were grouped; same correctness):

| `PG_POOL_MAX` | Drain time | Throughput | p50      | p95      |
| ------------- | ---------- | ---------- | -------- | -------- |
| 20            | 3.59 s     | 279 req/s  | 2,042 ms | 2,809 ms |
| 50            | 3.09 s     | 324 req/s  | 1,385 ms | 2,231 ms |

2.5× the connections gave ~1.16× the throughput. **CPU sampling during a spike: API container peaked at 112–125%** (one Node.js thread saturated plus helper threads), so the spike is bound by a single Node process's CPU. Latency in a spike is mostly time spent queued for a connection and for the contended seat's row lock.

### Scenario B: 50 VUs steady for 60 s (G7 targets)

Each iteration: GET the seat map; 20% of iterations also hold a random AVAILABLE seat and release it if won. No think time.

| Run | Requests | Rate        | Seat map p50 / p95 / p99 | Hold p50 / p95 / p99  | Release p50 / p95 | Holds won / lost race | Failed |
| --- | -------- | ----------- | ------------------------ | --------------------- | ----------------- | --------------------- | ------ |
| 1   | 62,796   | 1,046 req/s | 32 / **62** / 94 ms      | 77 / **164** / 233 ms | n/a               | 7,278 / 2,114         | 0 %    |
| 2   | 75,828   | 1,263 req/s | 26 / **46** / 66 ms      | 70 / **117** / 158 ms | 57 / 98 ms        | 8,547 / 2,643         | 0 %    |

**G7: p95 seat map < 300 ms MET (46–62 ms); p95 hold < 500 ms MET (117–164 ms).** API CPU during run 1: median 104%, peak 130%. After each run: 0 seats in two live bookings, HELD seats = live items (0 after all releases), 0 deadlocks.

## Naive vs fixed (race demo)

`npm run demo:race`: T1's race (1,000 users, 50 seats, same-seat requests fired together, pool of 20) against a deliberately broken read-then-write hold and against SeatLock. Three runs, 2026-11-01:

| Implementation                           | Told "you hold the seat" | Seats held | Misled          | Naive confirm step                                                         |
| ---------------------------------------- | ------------------------ | ---------- | --------------- | -------------------------------------------------------------------------- |
| Naive, 20 ms work between read and write | 660 / 764 / 785          | 50         | 610 / 714 / 735 | 50 confirmed; every other attempt **rejected by `one_confirmed_per_seat`** |
| Naive, no delay                          | 546 / 524 / 531          | 50         | 496 / 474 / 481 | 50 confirmed; every other attempt rejected by the index                    |
| **SeatLock**                             | **50 / 50 / 50**         | 50         | **0**           | n/a                                                                        |
