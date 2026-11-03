# SeatLock v2: from a backend proof to a real product

**Status:** Plan, agreed direction · **Replaces:** the scope of [prd.md](../prd.md) (v1.2), which stays as the record of how the backend core was designed.

## 1. Why v2

v1 proved one thing very well: no seat is ever sold twice. But its PRD said "the UI is deliberately minimal", so the result is a strong engine with a five-page website and one sample show. Nobody can open it and feel they booked a movie.

For a placement project three things matter together:

1. **A product people recognise** (browse movies, pick a showtime, pick seats, pay, get a ticket).
2. **Hard engineering underneath** that you can explain (concurrency, idempotency, outbox, webhooks).
3. **A live URL and a clean repo** you can open in front of an interviewer.

v2 keeps the engine and builds the product around it.

## 2. What we keep, change and add

| Keep (do not rewrite)                                          | Change                                             | Add                                                   |
| -------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------- |
| Hold/confirm/expire locking logic, state machines, constraints | Data model: movies, theatres, screens, showtimes   | Landing page, movie pages, search and filters         |
| Idempotency keys, webhook dedupe, late-payment handling        | Fixed 50-seat grid becomes per-screen layouts      | Seat categories with different prices                 |
| Transactional outbox and the worker                            | One hard-coded gateway becomes a `PaymentProvider` | Razorpay test mode next to the mock gateway           |
| The 103-test suite (updated as the model grows)                | Plain UI becomes a designed, responsive site       | Digital ticket with QR code, booking history, profile |
| Raw SQL, no ORM                                                | `docker compose` as the only way to run it         | `npm run dev`, one command, for development           |
|                                                                | JWT in `localStorage`                              | Admin dashboard, live deployment, interview material  |

Why not start over: the engine is the part that took the most thought and is the best interview story. Replacing it would cost weeks and make the project weaker.

## 3. Product scope

**Customer**

- Landing page: hero, now showing, upcoming, city picker.
- Movie list with search and filters (genre, language, rating).
- Movie page: poster, synopsis, cast, duration, theatres and showtimes for the chosen day.
- Seat selection: per-screen layout, seat categories and prices, live availability, selection summary, 5-minute hold countdown.
- Checkout: order summary, convenience fee, payment choice (UPI, card, net banking via Razorpay test checkout; "test scenarios" via the mock provider), clear sandbox labelling.
- Confirmation: digital ticket with QR code and booking reference. Status survives closing the browser (the backend is the authority, never the success screen).
- My bookings: upcoming and past, download ticket, cancel with refund status.
- Profile.

**Admin**

- Dashboard: bookings, revenue, occupancy per show.
- Manage movies, theatres, screens and showtimes.
- Outbox and payment inspection (already in the API, now with a UI).

**Not in scope:** real money, real SMS or email, recommendation engine, multi-city inventory sync, mobile apps.

## 4. Data model changes

The seat-locking tables stay as they are. The model grows above them.

```
Movie → Theatre → Screen → Show → Seat → Booking → Payment

movies ──< shows >── screens >── theatres
                │
                └──< seats (per show, as today) ── category
```

**Prices are snapshots.** The price a customer pays is copied into `booking_items.price` when the hold is made. Changing a category's price later never changes an existing booking.

**Showtimes roll forward.** The seed creates showtimes relative to today (the next 7 days), and re-running it tops them up, so a fresh install always has something to book. (v1's single sample show was created once at "now + 7 days" and silently disappears a week later.)

| Table           | New / changed | Notes                                                                                                       |
| --------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `movies`        | new           | title, synopsis, genres, language, duration, certificate, rating, poster/backdrop URL, release date         |
| `theatres`      | new           | name, city, address                                                                                         |
| `screens`       | new           | theatre, name, rows and columns, seat layout with categories                                                |
| `shows`         | changed       | now a showtime: references a movie and a screen, `starts_at`, price per category (no more single price)     |
| `seats`         | changed       | adds `category`; still one row per show and seat, still locked in id order, so every concurrency rule holds |
| `booking_items` | unchanged     | already stores the price at booking time, which is exactly what category pricing needs                      |
| `payments`      | changed       | adds `provider` (`MOCK` or `RAZORPAY`) and the provider's order id                                          |

The invariant constraints (`one_confirmed_per_seat`, `seat_status_owner`, `one_pending_per_user_show`) are untouched.

## 5. Payments: one interface, two providers

```ts
interface PaymentProvider {
  // Razorpay: create an order. Mock: start a charge.
  startPayment(payment): Promise<StartResult>; // what the browser needs to open checkout
  verifyCheckoutSignature?(fields): boolean; // browser callback (Razorpay only)
  verifyWebhook(rawBody, headers): boolean; // server-to-server callback
  parseWebhook(rawBody): PaymentEvent;
  refund(payment): Promise<RefundResult>;
}
```

**Razorpay flow**

1. Backend creates a Razorpay **order** for the booking (amount from our database, never from the browser).
2. Browser opens Razorpay Checkout; the customer pays with a test card or UPI.
3. Checkout returns `payment_id`, `order_id` and a **checkout signature** to the browser, which forwards them to the backend.
4. Backend verifies the checkout signature. This proves the browser's message is genuine, so the UI can move to "payment received, confirming".
5. Razorpay sends a **webhook**, signed with a separate webhook secret.
6. Backend verifies the webhook signature, dedupes the event and runs the existing confirm / late-payment / refund logic.

**Two signatures, two jobs:** the checkout signature is a fast, user-facing hint; the webhook is the authority. If the browser closes after paying, step 3 never reaches us, but step 5 still confirms the booking. Both paths are idempotent, so receiving both is harmless.

**Local development:** Razorpay can't call `localhost`, so webhooks need a tunnel (for example cloudflared) or a deployed backend. This is one reason deployment moves earlier (section 9).

- **Mock provider** (exists): lets us force failure, timeout, duplicate and late-payment scenarios on demand. This is the deterministic test and demo tool.
- **Razorpay test mode** (new): real third-party integration with its hosted checkout (UPI, cards, net banking, no money moves). The app never sees card numbers.
- Switched by configuration. Both feed the same webhook pipeline, so dedupe, signature checks, state guards and late-payment recovery are shared.
- The UI states plainly that it is a sandbox.

Needs from you: a free Razorpay account (test keys). I can't create accounts or handle keys for you.

## 6. Design direction

Modern hybrid: dark cinematic hero and poster-led browsing, clean light-weight dashboards and forms, smooth but restrained motion. Fully responsive. Real loading, empty and error states.

## 7. Dev experience

- `npm run dev` starts the API, worker, mock gateway and website in one terminal (databases come from `docker compose up -d postgres redis`).
- `docker compose up --build` stays as the "run it anywhere" mode and the base for deployment.
- JWT moves to an httpOnly cookie (with CSRF protection) before deployment.

## 8. Deployment

Decided after the product works, because it needs your accounts. Two candidates:

- **A (free):** Vercel frontend, one Render service running API + worker + mock gateway, Neon Postgres, Upstash Redis. Sleeps when idle.
- **B (simplest and most faithful):** one small VPS running the existing `docker-compose.yml` behind Caddy for HTTPS. Never sleeps.

Before either: trust exactly one proxy hop, real secrets, mock-gateway control endpoint off.

## 9. Roadmap

| Phase | Name                           | Outcome                                                                                                   |
| ----- | ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 11    | Dev workflow and understanding | `npm run dev`; both workflows verified; test suite run; a guided first booking with database checks       |
| 12    | Product data model             | Movies, theatres, screens, showtimes, seat categories; migrations, API, rolling seed with ~12 movies      |
| 13    | Frontend rebuild               | Landing, discovery, movie page, seat selection, checkout, ticket, bookings, profile                       |
| 13.5  | First deployment               | The Phase 13 product live on a public URL (needed for Razorpay webhooks; surfaces hosting problems early) |
| 14    | Payments v2                    | `PaymentProvider`, Razorpay test mode, sandbox checkout UX, both providers tested                         |
| 15    | Admin dashboard                | Movies, shows, stats, outbox UI                                                                           |
| 16    | Hardening                      | Cookie auth, proxy fix, secrets, end-to-end browser tests, final deployment                               |
| 17    | Interview pack                 | Architecture walkthrough, decision defence, Q&A, demo video script                                        |

If time runs short, cut in this order: admin dashboard extras, then cookie auth. Never the frontend, the deployment or the tests.

**Rules carried over from v1:** every phase ends with a write-up in `docs/phases/`, updated PROGRESS/decisions/results, and a test suite that was actually run. Concurrency tests (T1 to T19) stay green through every change to the data model. Tests may be **edited** when the model changes (for example, shows no longer always have 50 seats), never deleted to make the suite pass; every edit is listed in the phase write-up.

## 10. Testing and acceptance

**Automated (Jest, real Postgres and Redis)**

- Everything in v1 (T1 to T19, S1 to S10).
- New: movie, theatre and showtime data; seat categories and price snapshots; admin authorisation on every admin route; session expiry; Razorpay checkout and webhook signature checks; refund failure and retry.

**Browser end-to-end (Playwright, a few flows, not a full UI suite)**

- Register → browse → pick showtime → pick seats → pay (mock) → ticket → My bookings.
- Hold expiry shown and handled in the UI.
- Cancel a booking and see the refund status.

**Fresh-install demo (acceptance criterion)**

From a clean clone, with no manual database edits: a visitor opens the site, browses movies, picks a theatre and showtime, picks seats, pays in test mode, gets a digital ticket and sees it in booking history.

## 11. Claims: correctness vs performance

Two different claims, kept apart in the README and in interviews:

- **Correctness** (proven by tests): no seat is ever confirmed twice, overlapping multi-seat holds never deadlock, and a retried request never pays twice. T1 fires 1,000 concurrent holds at 50 seats; exactly 50 succeed every run.
- **Performance** (measured, not guaranteed): latency and throughput numbers from k6, on one laptop, with the environment stated. They say how this machine behaved, not how a production deployment would.

## 12. The interview story

> "I built a movie-ticket platform where correctness is enforced by the database. Seats are locked in a fixed order, so overlapping bookings can't deadlock, and a unique index makes a double-sold seat impossible even if the code has a bug. In tests, 1,000 concurrent requests for 50 seats always produce exactly 50 bookings. Payments are idempotent and confirmed only by signed webhooks, and a transactional outbox means a crash can't lose a confirmation. It runs against Razorpay's test gateway and a mock gateway I use to reproduce late payments and failures, and it's deployed live."
