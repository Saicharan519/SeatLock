# Phase 7: Hardening and observability

## What this phase is

The core booking logic was complete after Phase 6. This phase makes it safe and operable: **rate limiting** so one client can't hammer the API, a **health check** that reports Redis, **state-transition logs** so every booking and payment change can be traced, and **admin endpoints** to inspect and retry dead outbox events. The most important requirement: none of this may make the system _less_ reliable, so when Redis goes down, the API must keep working (T13).

## 1. Rate limiting ([rateLimit.ts](../../apps/api/src/middleware/rateLimit.ts))

| Endpoint                                  | Limit               | Keyed by   | Why                                                          |
| ----------------------------------------- | ------------------- | ---------- | ------------------------------------------------------------ |
| `POST /auth/register`, `POST /auth/login` | 10 / minute         | IP address | Slows password guessing and signup spam (no user exists yet) |
| `POST /holds`, `POST /bookings/:id/pay`   | 30 / minute, shared | User id    | Stops one account flooding the booking path                  |

Reads (shows, seat map) aren't limited. Responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers; a blocked request gets `429 RATE_LIMITED` with `Retry-After`.

**Algorithm: fixed window.** Each key (`rl:auth:<ip>`, `rl:booking:<userId>`) is a counter in Redis that expires 60 s after the first request. The increment and setting the expiry happen in **one Lua script**, which Redis runs atomically. Without that, two concurrent first requests could both increment before either sets the expiry, leaving a counter that never resets and blocks that client forever. A test fires 25 simultaneous requests at a limit of 10: exactly 10 get through.

_Trade-off:_ a fixed window allows up to 2× the limit across a window boundary (10 at 0:59, 10 more at 1:00). A sliding window fixes that with more Redis work. For abuse protection, fixed is enough.

**Per-IP behind a proxy:** with a load balancer in front, every request appears to come from the balancer's IP. `TRUST_PROXY=true` makes Express read the real client from `X-Forwarded-For`. It's off by default, because trusting that header without a proxy lets clients fake their IP.

**`RATE_LIMIT_ENABLED=false`** turns it off for the Phase 8 load tests, and the API logs a warning at startup when it's off.

## 2. Failing open when Redis is down (T13)

Postgres is the source of truth; Redis only _protects_ it. So if Redis is unavailable, requests are **allowed** (fail open) and a warning is logged, at most every 10 seconds. Failing closed would turn a Redis outage into a full outage.

The subtle part is that **most Redis clients don't fail fast by default.** While disconnected, they _queue_ commands and wait for the connection to come back, so every request would hang instead of failing open. The client ([redis.ts](../../packages/shared/src/redis.ts)) is configured against that:

| Setting                     | Effect                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `enableOfflineQueue: false` | While disconnected, commands are rejected immediately instead of queued                 |
| `maxRetriesPerRequest: 0`   | A command isn't retried across reconnects                                               |
| `commandTimeout: 250 ms`    | A Redis that's connected but stuck can't stall a request for long                       |
| `retryStrategy`             | Keeps reconnecting in the background (backoff up to 2 s), so limiting resumes by itself |

T13 covers three different failure shapes:

1. **Unreachable from the start:** register, login, hold and pay all succeed, unlimited, without hanging.
2. **Drops out mid-run:** limiting works, Redis disconnects, requests keep succeeding, Redis returns and limiting resumes.
3. **Connected but frozen:** `CLIENT PAUSE` makes Redis stop answering any command (like a stalled server). The 250 ms timeout lets the request through.

And with real processes, the **Redis container was actually stopped** while the API ran: logins kept working (no 429, no hang), health reported `degraded`, and after restarting Redis the API reconnected within about 3 s and the 11th login was blocked again.

## 3. Health check

`GET /api/health` → `{ status, db, redis }`:

- Database down → **503** `down`: nothing can be served.
- Redis down → **200** `degraded`: everything works, only rate limiting is off.
- No Redis configured → `redis: "disabled"`.

The distinction matters to a load balancer: a 503 takes the instance out of rotation, which would be wrong for a Redis outage the API is designed to survive.

## 4. State-transition logging, after commit only

Every booking and payment status change is logged as `{ entity, id, from, to }`. It hooks into the two guarded-transition functions, so every path is covered in one place.

The subtle part: **a transition must be logged only if its transaction commits.** Example: Priya has a stale hold and tries to hold a seat that's taken. The hold transaction marks her stale booking EXPIRED, then fails with `SEAT_UNAVAILABLE` and **rolls back**. The EXPIRED change never happened, so logging it would put a lie in the logs. The same applies to deadlock retries, where the first attempt's work is discarded.

So the transaction helper gained an **`afterCommit` hook** ([transaction.ts](../../packages/db/src/transaction.ts)): code inside a transaction registers callbacks, which run only after `COMMIT` succeeds and are discarded on rollback or retry. A test proves all three cases (commit → runs once; rollback → never; deadlock then success → only the successful attempt's callback). The worker logs its bulk transitions (holds expired, payments swept) the same way.

## 5. Admin outbox endpoints

- **`GET /api/admin/outbox-events?status=FAILED&limit=50`** (PRD FR-19): lists events, newest first, with type, payload, attempt count and last error. Admin only.
- **`POST /api/admin/outbox-events/:id/retry`** (beyond the PRD): sends a FAILED event back to PENDING with a fresh attempt budget, due immediately. `last_error` is kept as history. Only FAILED events qualify (others → 409). Without this, recovering a dead refund after fixing its cause would need hand-written SQL.

## What happened during this phase

1. **A new major version of the Redis library.** ioredis 6.0 had just been released, newer than what I knew well, so the option names were checked in its installed type definitions before relying on them.
2. **"Jest did not exit" again, three causes in a row.**
   - An uncleared "not ready" timer in the Redis test helper (the same mistake as Phase 6).
   - Waiting for an `end` event that ioredis never emits for a client that never connected. That made the test hook time out at 30 s.
   - A remaining ~2.3 s linger, isolated with small probe scripts: ioredis keeps the process alive for about 2.3 s after **any** refused connection, regardless of `connectTimeout`, reconnection settings or commands. The same on Windows and Linux.

   It's harmless for the API (requests fail fast, which T13 checks), so the health test now uses a stub for "Redis down", and the real unreachable client stays mid-file in T13. Lesson: measure and isolate (probe scripts, timing each file) instead of guessing at library internals.

3. **A file lock from OneDrive** interrupted a scripted multi-file edit. Done by hand instead.
4. **Linux verification before pushing:** the full suite (101 tests) passed in a Linux container with Redis, with a clean exit.

## Tests added (19, total now 101)

| Test        | Proves                                                                                                                                              |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **T13**     | Redis unreachable, dropping out mid-run, and frozen (`CLIENT PAUSE`): the API keeps working without hanging; limiting resumes when Redis returns    |
| Rate limits | 10/min per IP on auth, 30/min per user on holds + pay, per-IP separation behind a proxy, exact counting under 25 concurrent requests, disabled flag |
| Health      | ok / degraded (200) / disabled                                                                                                                      |
| Admin       | List with filter and validation, admin-only, retry then delivery, retry refusals                                                                    |
| Logging     | Both transitions logged on confirm; a rolled-back transition never logged; worker expiry logged; `afterCommit` semantics including deadlock retries |

## Key takeaways

- Protective infrastructure must fail open, or it becomes a new single point of failure.
- Client libraries often queue commands while disconnected; disabling the offline queue and adding a command timeout is what makes fail-open real.
- Atomic increment-plus-expiry (a Lua script) prevents counters that never reset.
- A health check should separate "can't serve" (503) from "degraded but serving" (200).
- Logs must describe committed state: side effects of a transaction belong after its commit.
- Operational endpoints (inspect and retry dead letters) turn manual SQL into a safe, guarded action.
