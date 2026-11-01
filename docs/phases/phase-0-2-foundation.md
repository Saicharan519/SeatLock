# Phases 0–2: Foundation, auth, shows, seat map

## What these phases are

Plumbing. None of the interesting concurrency work happens here, but everything after depends on it: a database that refuses bad data, a consistent way to run transactions, a consistent error format, auth, and test infrastructure that talks to a real Postgres.

## Phase 0: Setup

- **Machine check:** Node 24, npm, Docker Desktop (running) and git were all present.
- **Node 24 instead of Node 20:** Node 20 reached end-of-life in April 2026. Shipping a new project on an EOL runtime is a red flag, so the PRD was updated to Node 24 LTS.
- **Port 5433:** something on this machine already listens on 5432 (a local Postgres install), so Docker's Postgres is exposed on 5433. Inside Docker it is still 5432.
- **One package, not npm workspaces:** the PRD wants three programs (api, worker, mock-gateway) in one repo. One `package.json` with three entry points is simpler than workspaces and keeps the PRD's folder layout. Shared code lives in `packages/db` and `packages/shared`, imported as `@seatlock/db` / `@seatlock/shared` through TypeScript path aliases.

## Phase 1: Foundation

### The schema ([migration](../../packages/db/migrations/1761955200000_initial-schema.sql))

Ten tables. The important part is the constraints. They are the "database refuses corruption even if the code has a bug" layer:

| Constraint                                                                                         | What it prevents                                                                          |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `one_confirmed_per_seat`: unique index on `booking_items(seat_id) WHERE is_confirmed`              | **The core guarantee.** Two confirmed bookings for one seat is impossible even with a bug |
| `seat_status_owner`: `CHECK ((status = 'AVAILABLE') = (booking_id IS NULL))`                       | A HELD seat with no owner, or an AVAILABLE seat with one                                  |
| `one_pending_per_user_show`: unique index on `bookings(user_id, show_id) WHERE status = 'PENDING'` | Seat hoarding: one live hold per user per show                                            |
| `idempotency_user_key`: `UNIQUE (user_id, key)`                                                    | Two requests with one key both executing                                                  |
| `seats_show_label`, `items_unique`, `payments_booking_unique`, ...                                 | Duplicates                                                                                |

Concepts to know:

- **Partial unique index** (`... WHERE is_confirmed`): uniqueness applies only to rows matching the condition. Many unconfirmed items for one seat are fine (old cancelled bookings); only one confirmed one is allowed.
- **Money as integer paise:** floats can't represent 0.1 exactly. ₹250.00 is stored as `25000`.
- **`timestamptz` everywhere:** stores an absolute instant, so time zones never cause bugs.
- **Status as `text` + `CHECK` instead of Postgres `ENUM`:** adding a state later is one line; changing an enum is awkward.

### Transactions ([transaction.ts](../../packages/db/src/transaction.ts))

`withTransaction(pool, fn)` runs `fn` between `BEGIN` and `COMMIT`. On error it rolls back. On **deadlock (40P01), serialization failure (40001) or lock timeout (55P03)** it retries up to 3 times with growing random delays ("jitter", so retries don't collide again). After 3 failures it throws `RetryExhaustedError`, which the API turns into `503 RETRY_LATER` (PRD R4).

Rule that matters later: `fn` can run more than once, so it must not do anything that can't be repeated, such as an HTTP call (R7).

### Pool ([pool.ts](../../packages/db/src/pool.ts))

Every connection has `statement_timeout = 5s` and `lock_timeout = 3s` (R6), so no request can hang forever. The pool size (20) caps how many transactions run at once; extra requests wait for a free connection, up to `PG_POOL_ACQUIRE_TIMEOUT_MS` (30 s).

### API skeleton

- **Startup validation** ([env.ts](../../packages/shared/src/env.ts)): environment variables are checked with Zod. A missing `JWT_SECRET` or `WEBHOOK_SECRET` exits the process immediately. Fail fast beats running half-configured.
- **Logging:** pino writes JSON logs. Each request gets an ID (returned as the `X-Request-Id` header and included in errors) so one request can be traced through the logs. Passwords, tokens and auth headers are redacted.
- **One error shape** ([errors.ts](../../apps/api/src/utils/errors.ts), [errorHandler.ts](../../apps/api/src/middleware/errorHandler.ts)): every error is `{ error: { code, message, requestId } }`. Code throws `new AppError('SEAT_UNAVAILABLE')` and the handler picks the HTTP status from the PRD table.
- **Express 5:** errors thrown in `async` handlers reach the error handler automatically (Express 4 needed a wrapper).

### Tests and CI

- Tests run against a **real Postgres** (database `seatlock_test`, created by [init.sql](../../packages/db/docker/init.sql)), never mocks. Mocks can't reproduce locks, constraints or races.
- Before the suite, migrations run against the test DB; each test file truncates the tables before each test.
- Tests run one file at a time (`--runInBand`) since they share a database.
- [CI](../../.github/workflows/ci.yml) runs typecheck, lint, format check and tests on every push with a Postgres service container. It hasn't run yet because there's no GitHub remote.

## Phase 2: Auth, shows, seat map, seed

### Layering

`routes → controllers → services → repositories → Postgres`, as the PRD requires:

- **Routes** map URLs to handlers and attach middleware (auth).
- **Controllers** parse/validate input with Zod and send the response. No logic.
- **Services** hold business rules and transactions.
- **Repositories** contain the SQL. Raw, parameterized SQL (`$1, $2`), no ORM, so locks and atomic updates are visible.

### Auth

- **bcrypt** hashes passwords (cost 10 in production, 4 in tests for speed). Max password length 72, because bcrypt ignores bytes after 72.
- **JWT** (HS256, 1 hour): the token carries the user id (`sub`) and role. `requireAuth` verifies it and sets `req.user`. Only HS256 is accepted, which blocks "algorithm confusion" attacks.
- **Login doesn't leak which emails exist:** a wrong password and an unknown email return the same error, and an unknown email still runs a bcrypt comparison (against a dummy hash) so the response time doesn't differ either.
- Emails are lowercased before storage, so `Rahul@X.com` and `rahul@x.com` are one account.
- New error code `EMAIL_TAKEN` (409), which the PRD didn't define.

### Shows and the seat map

- `GET /shows` lists only future shows; `GET /shows/:id` returns 404 for unknown or malformed ids (a malformed id can't exist, so it isn't a 400).
- **The read-time check** ([showRepository.ts](../../apps/api/src/repositories/showRepository.ts)): a seat shows as `HELD` only if its booking is PENDING **and** `expires_at > now()`. An expired hold that the worker hasn't cleaned up yet is shown `AVAILABLE` straight away. Users never see "ghost" holds, and the worker's delay doesn't matter for correctness.
- `POST /admin/shows` (admin only) creates the show and its 50 seats (A1–E10) **in one transaction**, so a show without seats can never exist.

### Seed

[seed.ts](../../packages/db/src/seed.ts) creates an admin (`admin@seatlock.local` / `admin12345`, from `.env`) and one sample show. It's **idempotent**: running it twice changes nothing the second time.

## Things to know

- `.env` holds your local secrets and is git-ignored; `.env.example` is the committed template.
- Postgres bigint ids (`seats.id`) arrive in JavaScript as **strings**, because JS numbers can't represent every 64-bit integer. Treat seat ids as strings.
- The `npm audit` warning is in a dependency of the migration tool, which never runs inside the API. It's accepted, not ignored.
- The project lives in OneDrive. OneDrive may try to sync `node_modules` (thousands of files). Exclude it, or move the project.

## Interview talking points

- "The database enforces the invariant, not just the code": point to `one_confirmed_per_seat`, and T15, which inserts bad data directly and shows Postgres rejecting it.
- Why integer paise, why `timestamptz`, why no ORM.
- Why login has constant timing and identical errors.
