# Phase 10: Polish and delivery

## What this phase is

Making the project usable by someone who has never seen it. Three deliverables from the PRD's acceptance criteria:

1. **`docker compose up` runs the whole system from a clean clone** (criterion 3).
2. **A README that explains the design**: architecture, state machines, schema, concurrency rules, results, trade-offs (criterion 4).
3. **A demo recording** of the race and the late payment (criterion 5). This phase delivers a rehearsed script; the recording itself is made from it.

## One command: how the Docker stack works

```
docker compose up --build
  postgres, redis          (health-checked)
  migrate                  one-shot: migrations, then seed; must exit 0
  api, worker              start only after migrate succeeds (api also waits for redis)
  gateway                  mock payment gateway
  frontend                 nginx: the built UI + /api proxy; starts once the api is healthy
→ http://localhost:8080
```

### One backend image, compiled with esbuild

The API, worker, gateway and migrate job all run from **one image** (`seatlock-app`); compose picks the program with `command`. The Dockerfile has two stages:

- **Build:** `npm ci`, then `npm run build`, which runs **esbuild** on the four entry points (`api`, `worker`, `gateway`, `seed`). esbuild resolves the `@seatlock/db` and `@seatlock/shared` path aliases from `tsconfig.json` and inlines that code. npm packages stay external (`--packages=external`).
- **Runtime:** `node:24-alpine`, `npm ci --omit=dev`, the bundles and the SQL migrations. It runs as the unprivileged `node` user with `NODE_ENV=production`. The result is plain Node running JavaScript: no TypeScript, no `tsx`, no dev dependencies. Image size: 288 MB.

Why esbuild rather than `tsc`: `tsc` emits files but leaves `@seatlock/db` imports as they are, and Node can't resolve those aliases at runtime. That would need a path-rewriting step or real workspace packages. esbuild handles aliases natively, and it was already installed as a dependency of `tsx`; it's now declared explicitly.

### Migrations and seed as a one-shot job

`migrate` runs `node-pg-migrate up` and then the seed, and exits. The API and worker use `depends_on: condition: service_completed_successfully`, so they never start against a missing schema. Both steps are idempotent (migrations are tracked, the seed upserts), so the job is safe on every `up`.

### The frontend behind nginx

The React app is built in a Node stage and served by `nginx:1.29-alpine` (93 MB image). nginx also proxies `/api/` to `api:3000`, so the browser talks to one origin. That's the same arrangement as the Vite dev proxy, with no CORS configuration. Client-side routes like `/checkout/:id` fall back to `index.html`, so reloading a deep link works.

The API is **not published** on a host port; everything goes through nginx on 8080. Because requests now arrive via a proxy, the API runs with `TRUST_PROXY=true`, and nginx **overwrites** `X-Forwarded-For` with the real client address rather than appending to it. Otherwise a client could send its own `X-Forwarded-For` header and pick the IP the auth rate limiter sees.

### Webhooks inside the compose network

The gateway calls back to `API_PUBLIC_URL=http://api:3000`, and the API calls `GATEWAY_URL=http://gateway:4000`, both resolved by compose's internal DNS. The gateway is published on port 4000 only so the demo can switch its failure modes.

### Configuration

There's no `.env` in a fresh clone, so `docker-compose.yml` supplies **local-demo defaults** for the secrets (`${JWT_SECRET:-…}`), overridable from the shell or a `.env` file. The file says plainly that they're for local use only. `HOLD_TTL_SECONDS` and `WORKER_INTERVAL_MS` can be overridden the same way, which is how the late-payment demo uses a 30-second hold.

The mock gateway's `POST /__control` was previously tied to `NODE_ENV !== 'production'`. The stack runs everything in production mode, so a new `GATEWAY_CONTROL_ENABLED` variable switches it on explicitly. The default is unchanged.

### The development workflow is unchanged

`docker compose up -d postgres redis` still starts only the databases on the same ports, for running the apps on the host with live reload. `init.sql` now also creates `seatlock_load`, so the race demo and load tests work on a fresh volume.

## The README

Rewritten as the project's front page:

- **Try it in one command** comes first.
- **Six Mermaid diagrams**: architecture, a booking sequence end to end, the three state machines (seat, booking, payment) and an ER diagram of the schema. Each was checked by parsing and rendering it with Mermaid 11 before committing.
- **The constraints that carry the guarantees**: a table mapping each database constraint to what it guarantees.
- **The concurrency rules R1–R8** and the supporting patterns (idempotency keys, lock-verify-update, stale-hold takeover, outbox).
- **Decisions and trade-offs** and **Results** summaries, linking to the full documents.

## The demo script

[docs/demo-script.md](../demo-script.md) covers two recordings, about 4 minutes in total:

1. **The race:** `npm run demo:race`, reading the told / held / misled table.
2. **The late payment:** a 30-second hold and a gateway that confirms 50 seconds after Pay. **Case A**: nobody touched the seats, so the late payment re-claims them and the booking is confirmed. **Case B**: a second user takes one seat after the expiry, so the late payment is refunded in full (Refund on its way → Refunded), and the other seat goes back on sale.

Every step was rehearsed against the Docker stack, and the script quotes the measured timings.

## How it was verified

| Check                                                      | Result                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `git clone` into an empty folder **outside OneDrive**      | No `.env`, no `node_modules`                                                                                  |
| `docker compose build --no-cache`                          | 85 s                                                                                                          |
| First `docker compose up` (empty database)                 | All services healthy in 20 s; both migrations applied from scratch; sample show and admin seeded              |
| Warm restart                                               | Healthy through nginx in 10.7 s                                                                               |
| **Book in the browser** at http://localhost:8080           | Sign up → pick A5, A6 → hold → pay → **Confirmed**; reloading the checkout URL works                          |
| API end to end through nginx                               | hold 201 → pay 202 → webhook → CONFIRMED in 250 ms; worker published `BookingConfirmed`, notification written |
| Late payment, seats free (API)                             | Expired at 31.9 s, re-claimed and CONFIRMED at 45.5 s                                                         |
| Late payment, one seat taken (API)                         | REFUND_REQUIRED at 45.5 s, REFUNDED at 47.1 s; the untaken seat stayed free                                   |
| Late payment, one seat taken (**UI**, exactly as scripted) | Processing past the expiry → "Refund on its way" → "Refunded" after reload; payment REFUNDED 52 s after Pay   |
| Race demo on the fresh stack                               | Naive told 723 and 532 customers they held a seat; SeatLock exactly 50 (32 s)                                 |
| Full test suite, typecheck, lint, format                   | 103 / 103, all clean                                                                                          |

## What happened during this phase

1. **A corrupted build cache.** The first build, run inside the OneDrive folder, failed with `short read: expected 20248489 bytes but got 1421602`: Docker was reading the build context while OneDrive was syncing. The next build then failed differently: `Unable to resolve @typescript/typescript-linux-x64`, although a plain `npm ci` in the same Alpine image installed that package fine. The cause was the broken first attempt: its `npm ci` layer had been cached, and later builds reused it. Rebuilding that stage with `--no-cache` fixed it, and the final verification used a clone outside OneDrive with `--no-cache` throughout. Lesson: when a build error contradicts a direct experiment, suspect the cache.
2. **Four copies of one image.** The first compose file built the backend image once per service, tagging it four times. Giving the services one shared `image:` name produces a single image.
3. **The race demo needed a database nothing created.** `seatlock_load` had been created by hand in Phase 8. On a fresh volume `init.sql` now creates it, and the demo script includes the one-time migrate command for an existing volume.
4. **A README claim with no record behind it.** Two of the summarised trade-offs (Postgres locks rather than Redis locks; pessimistic rather than optimistic locking) were true of the design but not written down anywhere. They were added to [decisions.md](../decisions.md) with their reasons rather than left as unsupported claims.

## Key takeaways

- A clean clone plus `docker compose up` is the honest test of "runs anywhere". It was run for real, outside the development folder, with no build cache.
- Ordering matters as much as packaging: a one-shot migrate job plus health-check conditions means no service starts against a missing schema or an unready dependency.
- Bundling with esbuild resolves the monorepo's path aliases at build time, so the runtime image is plain JavaScript with production dependencies only.
- A reverse proxy changes the threat model for anything keyed on client IP: trust the proxy, and make the proxy overwrite the forwarded header.
- Demo steps are rehearsed and timed like tests, so the recording shows what the system really does.
