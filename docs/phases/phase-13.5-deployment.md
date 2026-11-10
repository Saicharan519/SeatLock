# Phase 13.5: First deployment

**Live:** https://seat-lock-ten.vercel.app (backend: https://seatlock-api-zw32.onrender.com, which only answers through the website).

## What this phase is

Putting SeatLock on a public URL, for free, without weakening what it guarantees. That turned out to be two problems: choosing where it can run at no cost, and changing the code so it stays correct and safe on free plans that put idle services to sleep.

## Choosing where to host

| Option                               | Outcome                                                                                                                                                                                                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Azure for Students                   | Rejected at sign-up: Microsoft doesn't recognise the college email domain, and India's school list was empty                                                                                                                                                                                   |
| Oracle Cloud Always Free             | Sign-up didn't work                                                                                                                                                                                                                                                                            |
| AWS                                  | The account's Free plan credits (about $149 until 2027-04-28) already pay for another project's server, about $85 to the end. A second server (+$15/month) or sharing that 1 GB server would risk running the credits out early, which suspends the whole account. AWS stays with that project |
| Hetzner and other VPS hosts          | Paid                                                                                                                                                                                                                                                                                           |
| **Vercel + Render + Neon + Upstash** | **Chosen.** Free, no card, and where SeatLock was going to move after April anyway, so it is deployed once                                                                                                                                                                                     |

```
Browser ──▶ Vercel  seat-lock-ten.vercel.app   (the React site)
               │  /api/* forwarded server-side, X-Origin-Secret added
               ▼
            Render  one free web service, Singapore: API + worker + mock gateway
               │                         │
               ▼                         ▼
            Neon (Postgres, Singapore)  Upstash (Redis, Singapore; rate limiting only)
```

## How Vercel reaches Render

The React code never calls Render. It calls `/api/...` on its own site, and `frontend/vercel.json` tells Vercel to forward those requests to Render server-side, adding a secret header on the way:

```json
{
  "src": "/api/(.*)",
  "dest": "https://seatlock-api-zw32.onrender.com/api/$1",
  "transforms": [
    {
      "type": "request.headers",
      "op": "set",
      "target": { "key": "x-origin-secret" },
      "args": "$ORIGIN_SECRET"
    }
  ]
}
```

This is a reverse proxy. Compared with putting the backend URL in a frontend environment variable and calling it from the browser:

- **One origin:** the browser only talks to the website, so there is no CORS configuration.
- **A locked backend:** Render rejects requests without the secret, so nobody can bypass the site (and its rate limits) by calling the API directly.
- **The real visitor IP:** Vercel sends it as `x-real-ip`; the backend trusts that header only because the secret proves the request came through Vercel.

## What the free plans required of the code

**One process.** Render's free plan has web services only, no background workers. A new entry point, `apps/all-in-one`, starts the API on Render's `PORT`, the mock gateway on `127.0.0.1` (unreachable from outside), and the worker loop, in one Node process. To make that possible the three programs were refactored into `startApi()`, `startWorker()` and `startGateway()` functions; run separately (`npm run dev`, Docker) nothing changed.

**Sleeping safely.** Render stops a free service after 15 minutes without visitors and starts it on the next request (about a minute). Correctness never depended on the worker being awake:

- pending side effects wait in the outbox table and are delivered after waking;
- an expired hold already counts as available on the seat map (read-time rule), before the worker marks it expired;
- a payment stuck without a webhook is swept when the worker runs again.

The UI shows "Waking up the server..." when a request is slow and retries reads (GET) during the cold start. Writes are never retried automatically: holds and payments have idempotency keys and are retried by the pages themselves.

**Not keeping it awake.** Neon's free plan gives 100 compute-hours a month (about 400 hours at the smallest size) and pauses after 5 idle minutes. A keep-alive pinger would keep the worker polling Neon around the clock and exhaust that in about two and a half weeks, so there is none.

**Remembering payments.** The mock gateway kept its charges in memory, so a sleeping (or restarted) gateway forgot them and later refunds failed with "unknown payment". It now keeps charges and refunds in its own table, `mock_gateway_charges`, when given a database. The API and worker still talk to it only over HTTP, as they would to a real provider.

**A catalogue that maintains itself.** The worker now tops up showtimes and deletes ended, never-booked shows every 6 hours (`CATALOG_MAINTENANCE_HOURS`), and the seed runs on every start. The live site never runs out of shows, and the database stays far below Neon's 1 GB (the seed adds about 40,000 seat rows a week).

## Hardening for a public site

| Risk                                                                                                                     | Fix                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| The default admin password `admin12345` is in the public repository                                                      | No default in production: the admin exists only if `SEED_ADMIN_PASSWORD` is set                                                     |
| Anyone could call the backend directly and set their own `X-Forwarded-For`, getting a fresh login rate limit per request | Origin secret checked on every request (constant-time comparison); webhooks (HMAC-signed) and the health check exempt               |
| Vercel's CDN caches responses to external rewrites when headers allow it                                                 | Every API response is `Cache-Control: no-store`; nobody's bookings can be cached at the edge                                        |
| `trust proxy = true` trusts any chain of forwarded addresses                                                             | One hop in Docker (nginx overwrites the header); on Vercel, `x-real-ip` only with the secret configured (startup refuses otherwise) |
| The mock gateway's failure-mode switch on a public URL                                                                   | Off, and the gateway listens on localhost only                                                                                      |
| Request logs printed every header (long lines, and a place for tokens to leak)                                           | One compact line per request (id, method, URL, status, time); healthy health checks not logged                                      |

## Verification

Locally, the built all-in-one bundle run the way Render runs it (`NODE_ENV=production`, origin secret on):

| Check                                     | Result                                                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Without the secret / health without it    | 403 / 200                                                                                      |
| Mock gateway from another address         | Unreachable                                                                                    |
| 11 failed logins from one IP / another IP | 429 / 401                                                                                      |
| Hold → pay → confirm → cancel             | Payment REFUNDED; the gateway stored the refund in the database                                |
| Database timeouts (rule R6)               | `statement_timeout 5s`, `lock_timeout 3s` confirmed at startup                                 |
| Test suite                                | **127 / 127** (9 new hosting tests); the gateway-restart test fails when the store is disabled |

On the live site (2026-11-10):

| Check                                                                 | Result                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `/api/health`                                                         | `{"status":"ok","db":"up","redis":"up"}`                            |
| Render `/api/movies` directly, and with a guessed secret              | 403, 403                                                            |
| Website, deep link `/movies/rrr`, 14 films through Vercel             | 200, 200, 14                                                        |
| API responses through Vercel                                          | `Cache-Control: no-store`                                           |
| "Continue with the demo account" → Interstellar, J14 Prime ₹280 → Pay | Confirmed, ticket shown                                             |
| Cancel in My bookings                                                 | "Refunded" within 10 seconds (worker and gateway running on Render) |

## What happened during this phase

1. **The API listened on the wrong port.** In all-in-one mode the defaults only filled in missing values, and the local `.env` file (loaded first) set `API_PORT=3000`, so the API ignored the platform's port. Found by running the built bundle with `PORT=3100`. The platform's `PORT` now always wins and the internal addresses are always derived from it: they describe the process, not configuration.
2. **Redis "down" after the first deploy.** The pasted `REDIS_URL` had lost its `rediss:` prefix and gained a trailing quote (`%22` in the log). The site kept working because the rate limiter fails open; with the URL corrected, Redis reported `up`.
3. **A credential in a screenshot.** That log line showed the Upstash password. It was reset straight away. Log lines are now shorter, but connection errors from client libraries can still include URLs, so screenshots of logs need a look before sharing.
4. **A Blueprint marked "Failed sync" while the service was live.** The first sync's "create service" step was marked failed even though the service deployed. A manual sync reported "Resources already up to date", so the configuration and the live service match; the failure is only history.
5. **The Render address got a suffix** (`seatlock-api-zw32`) because the name was taken; `vercel.json` was updated before Vercel was set up. DuckDNS couldn't be used at all: it only maps names to IP addresses, while Vercel needs a CNAME.
6. **A harmless warning.** The Postgres driver warns that `sslmode=require` is treated as `verify-full` (the strictest mode) and that this will change in its next major version. Setting `sslmode=verify-full` explicitly removes it.

## Key takeaways

- Hosting was chosen by constraints (no card, credits committed elsewhere, a planned later move), not by brand; deploying once beat deploying twice.
- The outbox and the read-time expiry rule, designed for crashes, are also what make free-tier sleep safe.
- A reverse proxy with a secret header gives one origin, no CORS, a backend that can't be bypassed, and a trustworthy client IP.
- "Fail open" for the rate limiter meant a misconfigured Redis degraded the site instead of breaking it.
- Running the production bundle locally with production-like settings found a bug that unit tests couldn't.
