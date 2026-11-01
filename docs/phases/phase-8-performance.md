# Phase 8: Performance proof

## What this phase is

Two kinds of proof. First, **load tests with k6**: how fast SeatLock is under a sudden spike and under sustained traffic, measured against the PRD's latency targets. Second, a **naive-vs-fixed demo**: the obvious "read, then write" hold raced against SeatLock's algorithm, to show concretely what goes wrong without the locking design.

## How the load tests run ([tests/k6](../../tests/k6))

`npm run loadtest:spike` / `npm run loadtest:steady` run [run.sh](../../tests/k6/run.sh), which:

1. **Resets a dedicated `seatlock_load` database** and creates two shows plus **1,000 users with pre-generated JWTs** ([setup.ts](../../tests/k6/setup.ts)), so login traffic doesn't pollute the measurement (PRD 13).
2. **Starts the API in a Linux container** with `NODE_ENV=production`, `LOG_LEVEL=warn`, `PG_POOL_MAX=20` and **rate limiting disabled** (otherwise the limiter would block the test, not the system).
3. **Runs k6 in another container** on the same Docker network. So k6 → API → Postgres never crosses the Windows network stack, which avoids the ~200-connection accept-queue limit found in Phase 3.
4. **Checks the database afterwards**: held seats, no seat in two live bookings, HELD seats equal live booking items, Postgres's deadlock counter.

## Results

Machine: i5-12450H laptop (8 cores / 12 threads), Docker Desktop VM with 12 CPUs and 7.6 GB, Postgres 16 with default settings. Full numbers in [results.md](../results.md).

### Scenario A: 1,000 users, 50 seats, all at once (reported, not asserted)

Every seat is wanted by 20 users who fire together. Three runs:

|                                        | Run 1                | Run 2                | Run 3                |
| -------------------------------------- | -------------------- | -------------------- | -------------------- |
| Correct outcome (50 × 201, 950 × 409)  | ✅                   | ✅                   | ✅                   |
| Other responses / failed requests      | 0 / 0                | 0 / 0                | 0 / 0                |
| Time to drain all 1,000                | 4.06 s               | 3.35 s               | 2.84 s               |
| Throughput                             | 246 req/s            | 299 req/s            | 352 req/s            |
| Latency p50 / p95 / p99                | 2.11 / 3.01 / 3.09 s | 1.58 / 2.34 / 2.46 s | 1.40 / 2.08 / 2.17 s |
| Deadlocks / seats in two live bookings | 0 / 0                | 0 / 0                | 0 / 0                |

**Reading the latency:** 1,000 requests arrive in the same instant, and the system drains them at about 250–350 per second. So most of a request's time is spent waiting in line: for a database connection, and for the row lock on its seat, which 20 users share. A spike's latency is a queue, not slowness per request.

**Where the limit is:** the API container ran at **~112–125% CPU** during the spike, meaning one Node.js thread at 100% plus helper threads. Raising the pool from 20 to 50 connections gave only **~1.16× the throughput** (279 → 324 req/s) for 2.5× the connections. So the ceiling is **one Node process's CPU**, not the database. The way past it is more API instances behind a load balancer. Correctness wouldn't change, because it lives in Postgres.

### Scenario B: 50 users, steady, 60 seconds (G7 targets)

Each iteration reads the seat map; one in five also holds a random free seat and immediately releases it. No think time between requests. Two runs:

|                                  | Run 1                 | Run 2                 | PRD target          |
| -------------------------------- | --------------------- | --------------------- | ------------------- |
| Requests (rate)                  | 62,796 (1,046 req/s)  | 75,828 (1,263 req/s)  |                     |
| **Seat map** p50 / **p95** / p99 | 32 / **62** / 94 ms   | 26 / **46** / 66 ms   | **p95 < 300 ms ✅** |
| **Hold** p50 / **p95** / p99     | 77 / **164** / 233 ms | 70 / **117** / 158 ms | **p95 < 500 ms ✅** |
| Release p50 / p95                | (not reported)        | 57 / 98 ms            |                     |
| Holds won / lost a race (409)    | 7,278 / 2,114         | 8,547 / 2,643         |                     |
| Failed requests / deadlocks      | 0 % / 0               | 0 % / 0               |                     |

Both G7 targets are met with plenty of room (p95 at 15–21% of the seat-map budget and 23–33% of the hold budget). The 2,000+ lost races are correct behaviour: a seat shown as free was grabbed by someone else between the read and the hold.

## The naive-vs-fixed demo ([demo/race](../../demo/race))

[naiveHold.ts](../../demo/race/naiveHold.ts) is the implementation most people write first, deliberately kept broken:

```
SELECT status FROM seats WHERE ...      -- "is it free?"   (no lock)
... some work ...                        -- the race window
UPDATE seats SET status = 'HELD' ...     -- no re-check, last writer wins
```

`npm run demo:race` runs T1's race (1,000 users, 50 seats) three ways. Three runs:

| Implementation                              | Customers told "you hold the seat" | Seats actually held | Customers misled |
| ------------------------------------------- | ---------------------------------- | ------------------- | ---------------- |
| Naive, 20 ms of work between read and write | 660 / 764 / 785                    | 50                  | 610 / 714 / 735  |
| Naive, no delay                             | 546 / 524 / 531                    | 50                  | 496 / 474 / 481  |
| **SeatLock**                                | **50 / 50 / 50**                   | 50                  | **0**            |

"Misled" means holding a seat that now belongs to someone else, because the second `UPDATE` silently overwrote the first. In the naive flow, all of them would go on to pay.

Then the demo runs a naive **confirm** step for every "winner". The database's `one_confirmed_per_seat` index lets exactly 50 through and **rejects every one of the 474–735 double confirmations**. So even with broken application code, Postgres refused to sell a seat twice: this is the "the database is the last line of defence" design from Phase 1, shown working.

A Jest test ([naiveRace.test.ts](../../tests/integration/naiveRace.test.ts)) keeps this permanent: the naive version must oversell, the index must block every double confirmation, and SeatLock must produce exactly 50 with nobody misled.

## What happened during this phase

1. **The naive version refused to oversell, which exposed a weak spot in T1.** The first demo run showed the naive code holding exactly 50 seats. The cause: T1 assigns user _i_ to seat _i_ mod 50 and fires requests in order _i_, and the pool runs 20 at a time in arrival order. Users who share a seat were always 50 places apart, so **two requests for the same seat never actually overlapped**. T1 had been passing honestly, but it wasn't exercising the same-seat race it claims to prove. The fix keeps the PRD's assignment but fires same-seat requests together (`contendedOrder`: all of A1's 20 users, then A2's...). With that, the naive code oversells massively, and T1, the k6 spike and SeatLock still produce exactly 50. Lesson: a test that passes is only evidence if you can show it would fail against a broken implementation, and the naive demo is exactly that check.
2. **"950 failed requests" was a reporting mistake.** k6 counts every 4xx as a failure by default, so the 950 correct `409 SEAT_UNAVAILABLE` answers were counted as failures. The scripts now declare 201 and 409 as expected, so "failed" means real failures (it's 0).
3. **Finding the bottleneck instead of guessing.** A pool-size experiment (20 vs 50) plus CPU sampling of the containers showed the spike is bound by one Node process's CPU, not the database.
4. **A flaky test that was the verification setup's fault.** The Linux check started failing occasionally with `connect ETIMEDOUT 192.168.65.254:5433`: the container reaching Postgres through `host.docker.internal`, Docker Desktop's forwarding back to a port published on Windows, which drops connections under bursts. Moving the test container onto the compose network (straight to `postgres:5432`) made the flaky file pass 5/5 and the whole suite 103/103.
5. **New major versions again:** k6 2.3 was checked with a smoke run before trusting its numbers.

## Tests added (2, total now 103)

- **naiveRace.test.ts:** the naive hold oversells, the database blocks every double confirmation, SeatLock gives exactly 50.
- **T1 strengthened:** same-seat requests now genuinely contend (passes 3/3 locally and on Linux).

## Key takeaways

- Under a spike, latency is mostly queueing; report drain time and throughput, not just percentiles.
- Measure to find the bottleneck: CPU sampling plus a pool-size experiment showed a single Node process, not Postgres, was the limit.
- Steady-state latency met the targets with large headroom: p95 seat map 46–62 ms (target 300), p95 hold 117–164 ms (target 500).
- A correctness test is only convincing if it fails against a broken implementation; the naive demo is that check, and it found a gap in T1.
- The database constraint stopped every double confirmation even when the application code was wrong.
- Benchmark inside one network (containers on the same Docker network) so the host's networking doesn't become the thing you measure.
