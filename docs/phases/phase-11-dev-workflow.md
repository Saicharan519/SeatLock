# Phase 11: Development workflow and understanding

## What this phase is

The first phase of SeatLock v2 ([prd-v2.md](../prd-v2.md)). Before changing the data model or the UI, three things had to be true:

1. **Running it for development is simple**: one command for the apps, with live reload.
2. **Everything that is claimed has been run**: the test suite, the Docker stack and a real booking, executed in this phase rather than taken from earlier records.
3. **One booking can be followed end to end**: every component it touches, observed in the logs and the database.

No backend logic was changed.

## Two ways to run SeatLock

| Mode        | Commands                                            | Use it for                                                |
| ----------- | --------------------------------------------------- | --------------------------------------------------------- |
| Development | `npm run dev:db`, then `npm run dev`                | Changing code. Each program reloads when its files change |
| Full stack  | `docker compose up --build` → http://localhost:8080 | Running or showing it anywhere with only Docker installed |

`npm run dev:db` starts only Postgres and Redis in Docker. `npm run dev` then starts four programs in one terminal with [`concurrently`](https://www.npmjs.com/package/concurrently), each line prefixed with its name:

| Prefix      | Program           | Port | What it is                                                  |
| ----------- | ----------------- | ---- | ----------------------------------------------------------- |
| `[api]`     | Express API       | 3000 | Validates requests, runs each action as one transaction     |
| `[gateway]` | Mock gateway      | 4000 | Pretends to be a payment provider; calls back with webhooks |
| `[worker]`  | Background worker | none | Every 5 s: outbox delivery, hold expiry, sweeps             |
| `[web]`     | Vite (React UI)   | 5173 | The website; proxies `/api` to port 3000                    |

`-k` (kill others) means that if one program exits, the rest are stopped too, so a crash is never hidden behind three healthy programs.

The two modes share ports 4000, 5433 and 6379, so they shouldn't run at the same time. Switching from the full stack to development: `docker compose stop frontend api worker gateway` (the databases keep running and keep their data).

### `npm run db:peek`

A small read-only script ([packages/db/src/peek.ts](../../packages/db/src/peek.ts)) that prints what the database knows about the most recent booking: the booking row, its seats and price snapshots, its payment, the webhooks received for that payment, and the outbox events with whether a notification was written. It turns "the booking was confirmed" into rows you can see.

## Verification (all run in this phase)

| Check                                 | Result                                                                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Full test suite (`npm test`)          | **103 / 103 passed**, 18 files, 113 s, against the real Postgres and Redis containers                                                            |
| Typecheck                             | Clean                                                                                                                                            |
| Full Docker stack (`up --build`)      | Built and healthy. Scripted through nginx on :8080: register → hold A4 (201) → pay (202) → **CONFIRMED** within 3 s                              |
| `npm run dev`                         | API, gateway, worker and UI all started; health endpoint `{"status":"ok","db":"up","redis":"up"}`                                                |
| Environment variables                 | The local `.env` lacked 3 keys from `.env.example` (`RATE_LIMIT_*_PER_MINUTE`, `TRUST_PROXY`); all three have safe defaults in the config schema |
| Shutdown (Ctrl+C in the dev terminal) | All four programs exited; ports 3000, 4000 and 5173 free; no Node processes left                                                                 |
| Booking in the browser (dev mode)     | Hold → pay → confirmed → My bookings → cancel → refunded, traced below                                                                           |

## One booking, traced

A real booking made in the browser (seat C8, ₹250), with times from the program logs and rows from `db:peek`.

| Time         | From → to     | What happened                                                                                                                                                                                                      |
| ------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 17:02:18.459 | Browser → API | `POST /api/holds` with an `Idempotency-Key`. **201** in 81 ms: booking **PENDING**, `expires_at` +5 min, C8 **HELD**                                                                                               |
| 17:02:21.4   | Browser → API | `POST /bookings/:id/pay`. One transaction: payment **INITIATED**, stored response, commit                                                                                                                          |
| 17:02:21.608 | API → gateway | After the commit, the charge request. Gateway: `charge accepted`                                                                                                                                                   |
| 17:02:21.632 | API → browser | **202 Accepted**: payment started, outcome unknown. The page starts polling                                                                                                                                        |
| 17:02:21.840 | Gateway → API | Signed webhook (`X-SeatLock-Signature: t=…,v1=…`). Verified, deduplicated, then one transaction: booking **CONFIRMED**, payment **SUCCESS**, seat **BOOKED**, `is_confirmed = true`, outbox row `BookingConfirmed` |
| 17:02:22.839 | Worker        | Claimed the outbox event, wrote the notification, marked it **PUBLISHED**                                                                                                                                          |
| 17:02:23.2   | Browser → API | Polling sees CONFIRMED; the confirmation screen appears                                                                                                                                                            |

Hold to confirmation: 3.4 s, of which about 3 s was the user deciding to click Pay.

What the trace shows:

- **The browser never decides the outcome.** It receives 202 ("started"). The booking is confirmed only by the gateway's signed, server-to-server webhook, so closing the browser after paying can't lose the booking.
- **The gateway is called after the payment row is committed** (rule R7). No transaction is open while waiting on an external service, and a record of the attempt exists before the external call.
- **The notification isn't sent by the webhook handler.** The handler writes an outbox row in the same transaction as the confirmation; the worker delivers it about a second later. A crash between the two can't lose it.

### The cancellation, traced

| Time (UTC)   | What happened                                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~11:35:58    | Cancel. One transaction: booking **CANCELLED**, C8 **AVAILABLE**, `is_confirmed = false`, payment **REFUND_REQUIRED**, outbox row `RefundRequired` |
| 11:35:58.930 | Worker claimed `RefundRequired` and asked the gateway for a refund (first attempt, no retries)                                                     |
| 11:35:59.033 | Gateway's signed `refund.succeeded` webhook; payment **REFUNDED**, refund reference stored                                                         |

- Setting `is_confirmed` back to false is what lets the seat be sold again: the partial unique index `one_confirmed_per_seat` allows at most one `true` row per seat.
- The refund is a slow, fallible external call, so it runs in the worker with retries and backoff, not inside the cancel request.
- `RefundRequired` writes no notification row; only `BookingConfirmed` does. That is by design in [consumers/index.ts](../../apps/worker/src/consumers/index.ts).

## PRD v2 refinements made in this phase

After an external review of the v2 plan, [prd-v2.md](../prd-v2.md) now also states:

- **Prices are snapshots**: `booking_items.price` is copied at hold time; later price changes never alter a booking.
- **Two Razorpay signatures with different jobs**: the checkout signature (from the browser) is a fast hint for the UI; the webhook signature (server to server) is the authority.
- **Razorpay webhooks need a public URL**, so a first deployment (Phase 13.5) comes before the Razorpay phase.
- **Correctness and performance are separate claims**: tests prove no oversell and no deadlock; k6 numbers describe one laptop.
- **Testing and acceptance**: Playwright for a few browser flows, and a fresh-install demo with no manual database edits as an acceptance criterion.
- **Tests may be edited when the model changes, never deleted to pass.**

## What happened during this phase

1. **The sample show expires on 8 November 2026.** The seed creates its one show at "now + 7 days", once. After that date the home page shows nothing. Phase 12 replaces it with showtimes that roll forward from the day the seed runs.
2. **Development logs are hard to read.** Each request logs every header, so the important lines (`state transition`, `webhook handled`, `outbox event published`) are buried among polling requests. Cosmetic; to be made compact in a later phase.
3. **"Terminate batch job (Y/N)?" on Ctrl+C.** On Windows, `npm` runs through a `.cmd` wrapper, and `cmd.exe` asks this question for each program when it receives Ctrl+C. The programs exit regardless; answering is unnecessary. If the prompt has already returned to PowerShell, typing `y` produces a harmless "not recognized" error.
4. **A file write failed under OneDrive.** Rewriting `package.json` from a Node one-liner failed with `UNKNOWN: unknown error, open` while OneDrive held the file; the same edit through a normal editor write succeeded. The same folder corrupted a Docker build context in Phase 10. Keeping the repository outside OneDrive would avoid both.

## Key takeaways

- Two workflows for two jobs: `npm run dev` for changing code, `docker compose up --build` for running anywhere. Neither replaces the other.
- Claims were re-run, not copied: 103/103 tests, the Docker stack and a browser booking were all executed in this phase.
- A booking is decided by the server: the hold is one transaction, the payment is recorded before the gateway is called, and only a verified webhook confirms it.
- Side effects that can fail (notifications, refunds) are written as outbox rows in the same transaction as the state change and delivered by the worker.
- Watching the database during a real booking (`npm run db:peek`) makes each state transition concrete.
