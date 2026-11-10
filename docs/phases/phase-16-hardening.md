# Phase 16: Hardening

## What this phase is

The product was complete and deployed. This phase made it safer and proved it works end to end, in three parts:

1. **A security review** against the problems reports keep finding in AI-built apps, done by testing rather than reading ([security-review.md](../security-review.md)).
2. **Cookie sessions**: the sign-in token moved out of `localStorage` into an httpOnly cookie, with CSRF protection.
3. **Browser tests**: six complete flows in a real Chromium, in CI on every push.

The plan also listed "proxy fix" and "secrets"; those were done in Phase 13.5 (one trusted proxy hop, the origin secret, no default admin password in production) and were re-checked in the review.

## 1. Security review

The full table is in [security-review.md](../security-review.md). In short:

| Checked                                        | Result                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Secrets in git history, in the frontend bundle | Clean (only a fake test key); no source maps. `.gitignore` widened to `.env.*`, `*.pem`, `.claude/`                  |
| Someone else's booking (IDOR), admin routes    | Enforced in SQL and already tested for every route                                                                   |
| The backend called directly, around Vercel     | 403                                                                                                                  |
| Logs                                           | A day of real local logs held only ids and states. **Gap fixed:** the admin booking search logged the searched email |
| Error responses                                | Generic message and request id; startup errors name settings, never values                                           |
| Security headers                               | **Gap fixed:** only HSTS before; now a Content-Security-Policy and the standard headers on the site and the API      |
| Redirect after sign-in                         | **Tightened:** `/\evil.com` refused as well as `//evil.com`                                                          |
| Dependencies                                   | Frontend clean; 3 moderate findings in the migration tool's `glob` (only our fixed pattern, at startup), recorded    |

The Content-Security-Policy is tested before it ships: it lives in `vercel.json`, and `npm run preview` serves the production build with the same headers. Under it, a real Cashfree sandbox checkout still worked. That same check found a Phase 14 bug: "Release seats" on "Finish your payment" could never work (the API refuses a release while a Cashfree payment is open), so it was replaced with an explanation.

## 2. Cookie sessions and CSRF

**Before:** the JWT sat in `localStorage`. Any script that ran on the page could read it and use it elsewhere.

**Now:**

| Piece             | How                                                                                                                                                                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The session       | The same JWT, in a cookie: `HttpOnly` (scripts can't read it), `SameSite=Lax`, `Secure` in production, `Path=/api`, one hour like the token                                                                                                                                                                                |
| Sign-in / sign-up | The API sets the cookie. The token is still in the response body for API clients; the website ignores it                                                                                                                                                                                                                   |
| Sign-out          | `POST /api/auth/logout` (a script can't delete an httpOnly cookie). The page goes home first, then signs out                                                                                                                                                                                                               |
| CSRF              | The browser attaches cookies even to requests another site triggers. So a write authenticated by the cookie must also carry `X-SeatLock-Client`, which another site can't make a browser send (cross-origin, a custom header needs a CORS preflight, and the API allows none). SameSite=Lax is a second, independent layer |
| API clients       | `Authorization: Bearer` still works (tests, k6, curl). A browser never sends it on its own, so it needs no CSRF check. A Bearer token wins over a cookie; a bad Bearer isn't rescued by a good cookie                                                                                                                      |
| Old sessions      | A token left in `localStorage` by an earlier version is removed on load                                                                                                                                                                                                                                                    |

Why a custom header instead of CSRF tokens: there's no token state to create, store or rotate, and it's the defence OWASP lists for JSON APIs that refuse cross-origin requests. Why Vercel makes this simple: the site and `/api` share one origin (Vercel proxies `/api` to Render), so the cookie is first-party and `SameSite=Lax` works.

Verified live: the demo button signs in through Vercel; page scripts see no cookie and nothing in `localStorage`; a write without the header gets 403; logout ends the session.

## 3. Browser tests (Playwright)

| Flow                                                                                                      | What it proves                                                                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Hold two seats, pay with the simulated gateway, see the ticket and QR code; it's Confirmed in My bookings | UI, API, gateway webhook and booking state machine together                          |
| Two browsers pick the same seat and press Hold at the same moment                                         | Exactly one reaches checkout; the other gets the message and an updated map          |
| Book, then cancel from My bookings                                                                        | It moves to "Past & cancelled" and becomes Refunded (the worker's outbox refund)     |
| Sign in, then out                                                                                         | No readable cookie, nothing in localStorage; a private page then asks you to sign in |
| An admin schedules a show on an empty screen, then the same slot again                                    | "0/10 sold" in the schedule; "Clash on Screen 1" from the exclusion constraint       |
| A customer opens `/admin`                                                                                 | "Admins only"                                                                        |

How they run:

- Against the **production build** (`vite preview`) with the production security headers, and the **all-in-one backend** used on Render.
- On a dedicated `seatlock_e2e` database that the e2e server creates, migrates, empties and seeds on every run. It refuses to reset a database whose name doesn't end in `_e2e`, and ignores the developer's `.env` (which may hold real gateway keys).
- One worker, **no retries**: a flaky test must fail, not pass on the second try. Each test uses its own show and new accounts.
- In CI as a third job (`e2e`), with the HTML report and traces uploaded when it fails. First CI run: all six passed.

### What the browser tests found

1. **Signing out from a private page went to the sign-in page, not home.** The page's guard saw "no user" and redirected before the navigation home happened. Fixed by navigating first.
2. **A bug in the test itself.** The race test sorted its results array in place, which scrambled which browser was the loser; it failed one run in three. Kept honest by the no-retries rule; fixed with a sorted copy. Three clean runs in a row after the fix, then green in CI.

## Two flaky tests made robust

Two Jest tests failed now and then on Windows (never in CI):

| Test                                  | Cause                                                                                                                           | Change                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| "holds seats and returns the booking" | Compared the database's clock (expiry) with the test's clock to the millisecond                                                 | 2 s tolerance on the upper bound |
| T19 (stale hold taken over)           | Waited 0.5 s past the 5 s TTL; Docker Desktop's VM clock runs slow between corrections, so the database sometimes saw under 5 s | Waits 1.5 s past the TTL         |

The product uses one clock (the database's, rule R5); only the tests compared two. Two full runs after the change: 164 / 164.

## Tests

| Suite                                                | Count                                                                       |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Jest (API, worker, gateway, real Postgres and Redis) | **164** in 25 files (+5 `securityChecks`, +9 `sessionCookie` in this phase) |
| Playwright (Chromium)                                | **6** flows in 2 files                                                      |

## Live checks (2026-11-10, https://seat-lock-ten.vercel.app)

| Check                                   | Result                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------ |
| Security headers on the site            | CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy, HSTS |
| Render without the origin secret        | 403                                                                      |
| Demo sign-in through Vercel             | Cookie set (`HttpOnly; Secure; SameSite=Lax`), invisible to scripts      |
| Write without `X-SeatLock-Client`       | 403                                                                      |
| Hold D1, pay with the simulated gateway | Ticket 79018E77 with QR code                                             |
| Cancel from My bookings                 | CANCELLED, payment REFUNDED within 10 s, seat available again            |
| Console during the flow                 | No policy violations                                                     |

## Key takeaways

- Audit by testing: grep the real logs, scan the real bundle, call the real endpoints. Two of the gaps (headers, a logged email) were invisible from the code's intent.
- httpOnly cookies remove token theft by XSS but bring CSRF; a custom-header check plus SameSite is a small, complete answer for a same-origin JSON API.
- A security policy is only safe to ship if the exact production policy can be tested locally.
- Browser tests found a real UX bug in their first run; a no-retries rule exposed a bug in the tests themselves.
