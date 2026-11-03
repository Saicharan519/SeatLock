# Phase 13: Frontend rebuild

## What this phase is

v1's interface was five plain pages around one sample show: it worked, but nothing about it felt like booking a film. Phase 12 gave the backend real films, theatres, screens, showtimes and seat categories; this phase builds the website a customer would expect on top of them. No backend code changed.

## Design direction: a night at the cinema

One idea, carried through every page:

- **The auditorium:** a warm near-black background (not pure black), soft "projected" white text, and a faint film-grain texture over everything.
- **Marquee type:** headlines in Big Shoulders Display, a condensed face that reads like cinema signage; Hanken Grotesk for body text; IBM Plex Mono for ticket data, seat labels and prices.
- **One accent, one meaning:** marigold is reserved for "yours": your selected seats, your hold, your call to action, your ticket. Status colours (green, amber, red) are only used for availability and booking state.
- **Signature details:** a row of marquee bulbs that gently breathe under the hero; a glowing screen whose light falls across the seat map like a projector beam; and the confirmed ticket printed on cream stock with a perforated tear line and QR code, the only light object on the dark site.

## Pages

| Route           | Page        | What it does                                                                                                                                                                                                                    |
| --------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`             | Home        | Full-bleed hero rotating through the best-rated films showing in the city (backdrop, title, rating, certificate, "from ₹"); language shortcuts; now-showing poster grid; how-it-works strip; films showing in other cities      |
| `/movies`       | Movies      | Search as you type, genre and language chips; filters live in the URL so a filtered list can be shared or reloaded                                                                                                              |
| `/movies/:slug` | Movie       | Backdrop header, poster, synopsis, director and cast; date strip (Today, Tomorrow, then weekdays, in IST); theatres with showtime buttons coloured by availability, prices on hover; empty state offering other cities          |
| `/shows/:id`    | Seats       | The layout drawn from the screen, row bands labelled with their price, live status every 2 s, up to 6 seats, sticky bar with the per-category breakdown and total                                                               |
| `/checkout/:id` | Checkout    | Order summary per category, countdown ring from the server's `expiresAt`, a clearly labelled sandbox payment, a step tracker while the gateway's webhook is awaited, and outcome screens (failed, expired, refunding, released) |
| `/bookings/:id` | Ticket      | The cream ticket: film, date, time, theatre, screen, seats, amount, QR code, short booking ID; printable                                                                                                                        |
| `/bookings`     | My bookings | Upcoming and past tabs, live statuses (held with countdown, processing, confirmed, refund on its way, refunded), view ticket, two-step cancel stating the refund amount                                                         |
| `/profile`      | Profile     | Account details and activity: upcoming shows, tickets, films, amount spent                                                                                                                                                      |
| `/signin`       | Sign in     | Sign in or create an account over a drifting wall of posters                                                                                                                                                                    |
| `*`             | Not found   | "Wrong screen"                                                                                                                                                                                                                  |

### Browse first, sign in to book

v1 put every page behind sign-in. Real ticketing sites let anyone browse, and ask for an account only when it's needed. Now home, movies, movie pages and seat maps are public; holding seats, checkout, bookings and profile require sign-in. A visitor who picks seats and then signs in comes back to the same show **with the same seats still selected**: picks are kept in `sessionStorage` per show, and the sign-in page only redirects to same-site paths (`/…`, not `//…`), so a crafted link can't bounce someone to another site.

### City

The city picker in the header lists cities that have upcoming shows (`GET /api/cities`). The choice is remembered in `localStorage`; a remembered city that no longer has shows falls back to Hyderabad or the first city available.

### Times are IST everywhere

Every date and time is formatted with `timeZone: 'Asia/Kolkata'`, the same zone the API uses for calendar days. Without it, a viewer whose computer is set to another zone would see a date strip that disagrees with the showtimes under it.

### The payment, made visible

The checkout shows the asynchronous payment as it really happens: **Payment started** (recorded before the gateway is called) → **Waiting for confirmation** (the gateway confirms with a signed message to the server) → **Seats confirmed**. The page polls every 1.5 s while the payment is in flight, and says plainly that closing it is safe. The "Test payment" option carries a **Sandbox** label and states that no money moves and no card details are collected.

## Kept from v1

The parts of the old UI that carried correctness were kept unchanged in behaviour: one Pay idempotency key per booking in `sessionStorage` (double taps charge once), a fresh hold key per attempt, the countdown driven by the server's `expiresAt`, the seat map refreshing every 2 s with "just taken by someone else" notices, polling paused in hidden tabs, and the booking-state logic that decides which outcome to show.

## Verification

All in the browser against the running stack (dev mode), signed in and signed out:

| Flow                                                                               | Result                                                                           |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Home: hero rotation, poster grid, language links                                   | Rendered; 14 films in Hyderabad                                                  |
| Movie page → date strip → showtime                                                 | Dates in IST ("Tomorrow 4 Nov" after the evening's last show); availability dots |
| Seats: F7 PRIME + K4 RECLINER                                                      | Bar showed "Prime F7 · Recliner K4 ₹640" (₹230 + ₹410 evening prices)            |
| Hold → checkout → Pay (gateway set to a 6 s delay to observe the tracker) → ticket | Tracker on step 2 while waiting; ticket with QR and booking ID after the webhook |
| My bookings: tabs, two-step cancel                                                 | Cancelled booking moved to "Past & cancelled" with "Refund on its way"           |
| Signed out → pick G8, G9 → "Sign in to continue" → sign in                         | Returned to the same show with G8, G9 (₹460) still selected                      |
| Sold seats to a signed-out viewer                                                  | F7 reported as "sold"                                                            |
| Profile, 404                                                                       | Rendered with correct stats                                                      |
| Phone (375 × 812): home, seat page                                                 | Hero and grid adapt; seat map scrolls sideways and opens centred on the screen   |
| Console errors                                                                     | None after the fixes below                                                       |
| `tsc -b`, production build, isolated Docker build of `frontend/`                   | Clean; 411 kB JS (127 kB gzipped), 52 kB CSS                                     |

Backend tests were not re-run: no backend file changed in this phase (118/118 at the end of Phase 12).

## What happened during this phase

1. **"destroy is not a function" on first load.** The layout scrolled to the top on navigation with `useEffect(() => window.scrollTo(0, 0), [pathname])`. An arrow function without braces returns its expression, and React treats an effect's return value as its cleanup. In this Chromium version `window.scrollTo()` returns a Promise (newer browsers make scroll methods awaitable), so React later tried to call a Promise as a cleanup function and the whole layout crashed. Every effect now has a block body, so it returns nothing unless it means to.
2. **The seat map re-centred itself every 2 seconds.** To start a wide seat map centred on a phone, the first version re-ran the centring whenever the layout prop changed. The map is refetched every 2 s, so the layout is a new array each time and the effect would have undone the user's own scrolling. It now runs once, on mount. Caught by reading the code before shipping, not in testing.
3. **A refund that kept retrying.** Cancelling a booking made before the dev servers were restarted left it at "Refund on its way": the worker's refund call got 404 from the mock gateway, which keeps its charges in memory and had forgotten that payment. The system behaved as designed (retry with backoff, honest status), but it exposes a known limitation of the mock gateway. Phase 14 gives the mock gateway persistent state.
4. **Screenshots taken mid-animation.** Several screenshots showed half-transparent pages. Checking the DOM showed the entrance animations had finished (opacity 1); the screenshot tool had captured an earlier frame. The pages were fine.
5. **Cast list spacing.** Names were laid out as separate flex items with a gap, which put a space before each comma ("Chalamet , Zendaya"). Now a plain joined string.

## Key takeaways

- The site now reads as a product: browse by city, film page with showtimes, a seat picker with priced bands, a checkout that shows the payment in progress, and a real-looking ticket.
- Browsing is public; sign-in is asked for only when booking, and selections survive the detour.
- Dates and times are shown in the same timezone the backend uses for calendar days.
- An arrow-function effect returns its expression, and React treats a returned value as a cleanup; browser APIs that now return Promises turn that into a crash.
- The correctness-carrying UI behaviour from v1 (idempotent pay, server-driven countdown, live seat updates) was kept intact under the new design.
