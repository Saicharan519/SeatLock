# Phase 15: Admin dashboard

## What this phase is

Until now, running SeatLock meant calling admin endpoints with `curl`, or waiting for the seed to fill the catalogue. This phase adds an **admin section at `/admin`**: what an operator of a cinema chain needs day to day.

| Page                   | What it does                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**           | Revenue, tickets sold, occupancy of upcoming shows, live holds, pending refunds; revenue for the last 7 days; split by gateway; top movies; latest bookings |
| **Bookings**           | Everyone's bookings, filtered by state, searched by customer email or the reference printed on the ticket                                                   |
| **Movies**             | The catalogue, with add and edit (title, synopsis, genres, running time, certificate, rating, cast, posters)                                                |
| **Theatres & screens** | Theatres by city; add a theatre; add a screen with a **visual seat-layout editor** (rows, categories, aisles) that previews exactly what customers will see |
| **Showtimes**          | One theatre's schedule for a day, screen by screen, with seats sold; add a showtime with a price per seat category; delete a show nobody has booked         |
| **Background events**  | The outbox: failed, waiting, in-progress and done events, with the error and attempt count, and Retry for failed ones                                       |

Only `ADMIN` accounts get in. The server enforces the role on every admin endpoint; the page guard only spares customers an empty screen. Admins also get an "Admin dashboard" link in the account menu.

## What the backend gained

| Endpoint                                | Purpose                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /api/admin/overview`               | Every dashboard number in one call (seven queries run in parallel)                                        |
| `GET /api/admin/bookings?status=&q=`    | Everyone's bookings, newest first, with customer, show, seats and payment                                 |
| `GET /api/admin/theatres`               | Theatres with their screens, layouts, seat categories and upcoming show counts                            |
| `GET /api/admin/shows?theatreId=&date=` | A theatre's schedule for one calendar day in IST, past shows included, with seats sold and booking counts |
| `PATCH /api/admin/movies/:id`           | Edit any subset of a movie's fields                                                                       |
| `DELETE /api/admin/shows/:id`           | Delete a show, only if nobody ever booked it                                                              |

Creating movies, theatres, screens and shows, and the outbox endpoints, already existed (Phases 6 and 12); the UI now uses them.

## Decisions inside the phase

### Editing a movie: only the fields sent, and never the slug

The first version of the edit schema was `createMovieSchema.partial()`. A quick check showed that Zod 4 still applies `.default()` values inside `.partial()`: sending `{ "title": "X" }` came back as `{ title, synopsis: "", genres: [], cast: [], rating: null, posterUrl: null, ... }`. Saving a title would have **wiped the synopsis, cast and posters**. The fix keeps the field rules in one place (`movieFields`, no defaults); creation adds the defaults, editing doesn't. A test sends three fields and checks that the synopsis, cast and rating survive.

The UPDATE builds its `SET` list from a fixed whitelist of column names, never from the request's keys. The slug can't be changed (links people shared would break), and unknown fields are rejected (`.strict()`).

A movie's running time can change, but **existing shows keep their end times**. Moving them could make a show overlap the next one on its screen, which the database would refuse halfway through. The edit page says so.

### Deleting a show: only if nobody ever booked it

Bookings, payments and refunds point at a show, and those records are history that must be kept. So a show can be deleted only while it has no bookings at all, even expired holds. Otherwise the answer is `409 INVALID_STATE`, and the UI greys out the button with the reason.

**The race with a customer.** An admin deleting a show while a customer holds a seat on it is a real concurrency case:

1. The delete locks the show row (`SELECT ... FOR UPDATE`), checks for bookings, then deletes seats, prices and the show.
2. Inserting a booking takes a `FOR KEY SHARE` lock on its show row: that's how Postgres checks the foreign key. `FOR KEY SHARE` conflicts with `FOR UPDATE`.

So the two are serialised. Either the hold commits first, and the delete sees the booking and refuses. Or the delete goes first, and the hold's foreign-key check waits on the locked row and then fails, because the show is gone. Without a fix, that second case was an unhandled error, a **500**. The hold now maps the foreign-key violation (`bookings_show_id_fkey`) to **404 "Show not found"**.

A test reproduces it deterministically: it opens a transaction, deletes the show without committing, and fires a hold. It then waits until `pg_stat_activity` shows the hold blocked on a lock, commits, and expects a 404 with no booking left behind. Disabling the mapping makes the test fail with a 500 (mutation check).

### The overview: one request, honest numbers

- **Revenue counts CONFIRMED bookings only.** Cancelled bookings were refunded, and holds and failed payments never paid.
- **Occupancy** is seats sold across all upcoming shows. The count of sold seats uses the partial index `seats_booking` (`booking_id IS NOT NULL`), so it doesn't scan every seat of every future show (`EXPLAIN` shows a bitmap index scan on `seats_booking`).
- **Days are IST calendar days**, like the rest of the product. Missing days are filled with zeros by `generate_series`, so the chart always has seven bars.
- A booking's day is when it was **made**, not when its payment confirmed (normally seconds apart).

### The seat-layout editor previews the real seat map

The editor reuses the customer seat map component, so the preview is exactly what customers will see, aisles included. Rows are labelled by position (row A nearest the screen). The editor checks what the API checks: 1–99 seats per row, aisles inside the row, categories in UPPER_SNAKE_CASE, at most 600 seats. It shows every problem row by row before anything is sent. The API still validates everything.

A screen's layout can't be edited after creation: every show on it has seats generated from that layout, and bookings point at those seats.

### Showtimes: clashes explained where they happen

The database already refuses overlapping shows on a screen (exclusion constraint, Phase 12). The form turns `SHOW_OVERLAP` into "Clash on Audi 1. Pick another time or screen", next to the day's schedule. Prices are typed in rupees and sent as paise. The time is typed as IST wall-clock time and sent with `+05:30`, whatever the admin's own timezone.

### The chart

The overview has one chart: confirmed revenue per day, one series. That means one colour (marigold) and no legend. A readout above the bars names the hovered day, or today by default. The same numbers are in a hidden table for screen readers. Gateways and booking states are plain lists, not charts: a few numbers read better as numbers.

## Tests

`adminDashboard.test.ts`, 12 tests:

| Test                                                                                                                | Proves                                        |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Every new route: 401 without a token, 403 for a customer                                                            | Authorisation on every route                  |
| Overview with two paid bookings (two gateways), a live hold and a failed event                                      | Every number, the 7-day series, gateway split |
| Overview on an empty database                                                                                       | Zeros, not division by zero or nulls          |
| Bookings: order, status filter, email search (case-insensitive), ticket-reference search, `%` not a wildcard        | The search a support person would do          |
| Theatres with screens, categories and upcoming counts                                                               | The editor's data                             |
| A theatre's day in IST, seats sold, bookings; another day empty; unknown theatre 404; bad date 400                  | The schedule view                             |
| Edit: three fields change, synopsis, cast and rating survive; public page shows the edit; clearing the rating works | Partial update (the Zod defaults bug)         |
| Edit rejects slug, unknown fields, empty body, bad values, `javascript:` URLs                                       | Validation                                    |
| Edit of an unknown movie, or a malformed id: 404                                                                    |                                               |
| Delete an unbooked show: seats and prices gone, public 404, second delete 404                                       | Clean removal                                 |
| Delete a show with only an expired hold: 409, show kept                                                             | History is kept                               |
| A hold racing an uncommitted delete waits, then gets 404, no booking left                                           | The lock reasoning above (mutation-checked)   |

Suite: **150 tests** in 23 files. One full local run had one failure in `expiry.test.ts` (T19), a test that compares the database clock with the test process's clock. It passed on both re-runs: the Docker Desktop clock drift recorded in Phase 14, not this phase.

## Verified in the browser (local, as the seeded admin)

| Check                              | Result                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Overview with the local data       | ₹3,090 from 8 confirmed bookings, 13 tickets, 0% of 36,350 upcoming seats, 3 refunds pending; the failed outbox event raised a banner linking to Background events |
| Chart hover                        | Hovering Wednesday's bar read "₹400 · Wed 4 Nov · 1 booking"                                                                                                       |
| Showtime at 18:30 on a busy screen | "Clash on Audi 1. Another show is running on this screen at that time..."                                                                                          |
| Showtime on a free screen          | Scheduled 6:30–9:13 pm (148 min + 15 min changeover); listed at once                                                                                               |
| Delete that show                   | "Deleted Inception at 6:30 pm"; day empty again                                                                                                                    |
| Screen editor                      | Preview identical to the customer seat map; an aisle after seat 20 of a 14-seat row listed as a problem and the preview hidden until fixed                         |
| Edit Inception's rating            | Saved; public API showed 8.9; cast and synopsis unchanged (then set back to 8.8)                                                                                   |
| Bookings search "cflocal"          | The two Cashfree test bookings, both "Refund on its way"                                                                                                           |
| Phone width                        | Section nav scrolls sideways under the header; tiles stack                                                                                                         |

The browser check found five problems, all fixed before commit:

1. A clash error stayed on screen after switching theatre, and then named the new theatre's screen. The form now resets per theatre, and an error clears when the slot changes.
2. The previous theatre's schedule stayed visible while the new one loaded. It's now dimmed while loading.
3. Time ranges wrapped onto two lines.
4. The poster preview never loaded: it was lazy-loaded, but it's always on screen.
5. Status pills wrapped in narrow table cells.

## Key takeaways

- An admin UI is mostly read models: one query per question, shaped for the screen, computed by the database.
- "Partial update" is a classic bug source; here the library's defaults would have silently erased data. One test caught what a review could miss.
- Every write an admin makes meets a customer's write somewhere. Deleting a show meets holding a seat, and the foreign-key lock already decides who wins. The code only had to turn the loser's error into a clean answer.
- The database's constraints (no overlapping shows, foreign keys) remain the source of truth; the UI explains them.
