# Manual test guide: run SeatLock and check every page

A hands-on tour. Each step says what to do, what you should see, and what is happening underneath. Tick the boxes as you go. Takes about 45 minutes end to end.

You need two terminals (VS Code's terminal or PowerShell, both in the `SeatLock` folder) and a browser.

---

## 0. Start everything

**1. Start Docker Desktop** from the Start menu and wait until it says "Engine running" (bottom left). Postgres and Redis run inside it.

**2. Terminal 1: start the databases.**

```bash
npm run dev:db
```

You should see `Container seatlock-postgres-1 Started` and `Container seatlock-redis-1 Started`.

**3. Terminal 1: top up showtimes.** The seed only adds shows for the next 7 days from when it runs. Run it whenever you come back after a few days. It never duplicates anything.

```bash
npm run seed
```

You should see `Catalogue ready: 14 movies, 7 theatres, 11 screens; N shows added, ...`.

**4. Terminal 1: start the four programs.**

```bash
npm run dev
```

Wait for these lines (order varies): `[worker] worker started`, `[gateway] mock gateway listening`, `[web] Local: http://localhost:5173/`, `[api] api listening`.

**5. Terminal 2** stays free for checking the database later:

```bash
npm run db:peek
```

- [ ] All four programs started, no red errors
- [ ] http://localhost:5173 opens

> If you see "port already in use": the Docker full stack is still running. Run `docker compose stop frontend api worker gateway` and try again.

---

## 1. Browsing while signed out

Use a **private/incognito window** for this part, so you start signed out.

### Home (`/`)

- [ ] A big rotating banner (a new film every 7 seconds; hovering pauses it; the small bars underneath switch films)
- [ ] The marquee "bulb" lights under the banner
- [ ] **Now showing** grid: posters with a rating badge, certificate (U, U/A, A), language, genres and "From ₹…"
- [ ] Hovering a poster dims it and shows "Book tickets"
- [ ] The language chips (English, Hindi, Telugu, Kannada) open the Movies page filtered by language
- [ ] The "01 / 02 / 03" how-it-works strip
- [ ] Footer: sandbox note, TMDB credit, GitHub link

**Underneath:** the page calls `GET /api/movies?city=Hyderabad`. Movies with shows in the city come first, best rated first.

### City picker (top right)

- [ ] Switch to **Bengaluru**: the banner and grid change; prices are a little higher there
- [ ] Reload the page: the city stays Bengaluru (remembered in your browser)
- [ ] Switch back to **Hyderabad**

> In your development database you may also see a city called **Unknown**. That is the old v1 sample show converted by the Phase 12 migration; a fresh install doesn't have it.

### Movies (`/movies`)

- [ ] Type `dune` in search: the list narrows as you type
- [ ] Look at the address bar: it now contains `?q=dune`
- [ ] Clear search, click **Action**, then **Telugu**: only Telugu action films (RRR, Baahubali 2, Kalki 2898 AD)
- [ ] Copy the address, paste it into a new tab: the same filters are applied (filters live in the URL)
- [ ] A combination with no results shows "No films match"

### A movie page (`/movies/rrr`)

- [ ] Backdrop or blurred poster at the top, poster on the left, title, rating, certificate, running time, language, year, synopsis, director, cast
- [ ] Genre chips link to the filtered Movies page
- [ ] **Book tickets** scrolls down to Showtimes
- [ ] **Date strip:** Today / Tomorrow / weekday buttons. Clicking one changes the theatres listed and puts `?date=…` in the address
- [ ] Each theatre shows its showtimes as buttons with a coloured dot (green available, amber filling fast, red almost full)
- [ ] Hover a showtime: a small box lists the prices per category and seats left
- [ ] Switch city to one where the film isn't playing that day: you get "No shows in …" with buttons to try other cities

**Underneath:** `GET /api/movies/rrr/showtimes?city=Hyderabad&date=…`. Days are counted in India time (IST): a show at 00:30 belongs to the next day.

### Seat page while signed out

Click any showtime.

- [ ] Header: poster, film, theatre, screen, date and time; "Change showtime" goes back
- [ ] The glowing screen at the top, rows labelled on both sides, gaps for aisles
- [ ] Price bands: **Classic** (front rows), **Prime** (middle), **Recliner** (back row)
- [ ] Click 2 seats in different bands: they turn marigold and glow. The bottom bar shows each band with its seats and the correct total
- [ ] Try a 7th seat: "You can book up to 6 seats at a time"
- [ ] The button says **Sign in to continue**. Click it

### Sign in / create account (`/signin`)

- [ ] A tilted wall of posters behind the form; the text says "Your picks are saved"
- [ ] Click **Create an account**. Try a 5-character password: an error about 8 characters
- [ ] Create an account with any name, any email (it's local) and a password of 8+ characters
- [ ] You land back on the **same seat page with the same seats still selected**

---

## 2. A complete booking

### Hold

- [ ] Click **Hold 2 seats**. You go to Checkout

**Underneath (one database transaction):** a PENDING booking expiring in 5 minutes, the seat rows locked in id order, flipped AVAILABLE → HELD only if still free, each seat's price copied into the booking.

Check it in **Terminal 2**:

```bash
npm run db:peek
```

- [ ] Latest booking: `PENDING`, `hold_still_live: true`; its seats `HELD` with their prices; no payment yet

### Checkout (`/checkout/:id`)

- [ ] Left: order summary, one line per band ("Prime F7, 1 × ₹230"), total
- [ ] Right: the countdown ring counting down from 5:00 (it turns red under 1 minute)
- [ ] The payment option is labelled **Sandbox**: no card details are asked for
- [ ] Reload the page: the countdown continues where it was (it comes from the server, not your browser)

### Pay

- [ ] Click **Pay**. In a moment: **You're in**, and the cream ticket

To actually see the "waiting for confirmation" step, make the fake bank slow first. In **Terminal 2** (PowerShell):

```bash
Invoke-RestMethod -Method Post -Uri http://localhost:4000/__control -ContentType 'application/json' -Body '{"mode":"delayed","delayMs":8000}'
```

Then do another booking and press Pay:

- [ ] Tracker: ✓ Payment started → spinner on **Waiting for confirmation** → after ~8 s the ticket appears
- [ ] While it waits, `npm run db:peek` shows the payment `INITIATED` and the booking still `PENDING`
- [ ] After: booking `CONFIRMED`, payment `SUCCESS`, seats `BOOKED`, one webhook received, an outbox event `PUBLISHED` with `notification_written: true`

Set the bank back to normal afterwards:

```bash
Invoke-RestMethod -Method Post -Uri http://localhost:4000/__control -ContentType 'application/json' -Body '{"mode":"success"}'
```

**Underneath:** Pay records the payment, commits, then calls the gateway and answers `202` ("started"). The gateway later calls our server with a signed webhook; only that confirms the booking. The worker then delivers the confirmation notification from the outbox.

### The ticket

- [ ] Film, date, time, theatre, screen, seats with their bands, amount paid
- [ ] A QR code (scan it with your phone camera: it reads `SEATLOCK:<booking id>:<seats>`)
- [ ] An 8-character booking ID
- [ ] **Print ticket** opens the print dialog with just the ticket

---

## 3. Your account

### My bookings (`/bookings`)

- [ ] **Upcoming** tab: your confirmed booking with poster, time, theatre, seats, total, booking ID, a green "Confirmed" pill
- [ ] **View ticket** opens the same ticket
- [ ] **Cancel booking** → it asks "Cancel and refund ₹… ?" → **Yes, cancel**
- [ ] The booking moves to **Past & cancelled** with "Refund on its way", then within about 5–10 seconds "Refunded" (the page refreshes itself)

**Underneath:** cancel is one transaction (booking CANCELLED, seats back to AVAILABLE, payment REFUND_REQUIRED, an outbox row). The worker then asks the gateway for the refund; the gateway's signed `refund.succeeded` webhook marks it REFUNDED.

> If it stays on "Refund on its way": the booking was paid before you last restarted `npm run dev`. The mock gateway keeps charges in memory, so after a restart it doesn't recognise the payment. This is a known limitation, fixed in the next phase. New bookings refund fine.

### Profile (`/profile`)

- [ ] Your initials, name and email; activity: upcoming shows, tickets booked, films seen, amount spent
- [ ] **Sign out** works and returns you to Home

### Account menu (initials, top right)

- [ ] Opens a menu (My bookings, Profile, Sign out); clicking outside or pressing Esc closes it

---

## 4. The interesting cases (the engineering)

### Two people, one seat

Open a **second browser** (or a normal window plus an incognito window) and sign in as **two different accounts**. Open the **same showtime** in both.

- [ ] In window A, select a seat and **Hold**
- [ ] In window B, within ~2 seconds that seat turns **hatched** (being booked by someone else) and can't be clicked
- [ ] Now try a race: in both windows select the same free seat, then click Hold in both as fast as you can. **Exactly one** gets the hold; the other sees "Someone else got one of those seats first"
- [ ] After A pays, B sees the seat as **Sold** (dark)

**Underneath:** the seat row is locked in the database; the second transaction waits, then finds the seat no longer free, and rolls back.

### One hold per show

- [ ] With a live hold, go back to the seat page of the same show: a notice says you're holding seats, with "Continue to payment"; you can't start a second hold for that show

### Let a hold expire

- [ ] Hold seats and **don't pay**. Watch the countdown reach 0:00: "Hold expired"
- [ ] Open the seat page: those seats are free again (another person could take them immediately; the worker also marks the booking EXPIRED within 5 seconds)

### Release a hold

- [ ] Hold seats, then click **Release seats** on checkout: you go back to the seat map and the seats are free

### Payment failures (the fake bank's modes)

Each time: set the mode in Terminal 2, then hold seats and Pay. Set it back to `success` at the end.

| Mode                         | Command body                        | What you should see                                                                                                                                                 |
| ---------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Declined immediately         | `{"mode":"reject"}`                 | "Payment failed · Not charged"; seats released                                                                                                                      |
| Fails after accepting        | `{"mode":"fail"}`                   | Processing, then "Payment failed"; seats released                                                                                                                   |
| Duplicate webhook            | `{"mode":"duplicate-webhook"}`      | Confirmed once; `db:peek` shows one confirmation, not two                                                                                                           |
| Bank never answers (timeout) | `{"mode":"timeout","delayMs":8000}` | The Pay button spins ~5 s (our API gives up waiting), Processing, then confirmed at ~8 s: a timeout is never treated as a failure, because the money may have moved |

Command template:

```bash
Invoke-RestMethod -Method Post -Uri http://localhost:4000/__control -ContentType 'application/json' -Body '{"mode":"reject"}'
```

- [ ] Double-click **Pay** quickly: still exactly one payment (`db:peek` shows one payment row)

### Late payment (the hardest case)

1. Set the bank to answer after 6 minutes: `{"mode":"late-webhook","lateMs":360000}`
2. Hold seats and Pay. Leave the page on "Processing".
3. After 5 minutes the hold expires. Two possible endings:
   - [ ] **Nobody took your seats:** when the webhook arrives at 6 minutes, the booking still becomes **Confirmed** (the seats are re-claimed)
   - [ ] **Someone took one of them** (use your second account to book one of those seats between minute 5 and 6): you get **"Refund on its way"**, then **Refunded**. You never get a partial booking, and nobody else's seat is taken

---

## 5. Phone layout

In Chrome, press **F12**, then the phone icon (Toggle device toolbar), and pick a phone.

- [ ] Home: the banner and grid fit; the menu links sit under the logo
- [ ] Seat page: the seat map scrolls sideways and opens centred on the screen; the bottom bar stays visible
- [ ] Checkout and ticket stack in one column

---

## 6. The other way to run it: the full Docker stack

This is how an interviewer (or a server) runs it: one command, no Node needed.

1. Stop `npm run dev` with **Ctrl+C** in Terminal 1 (answer `Y` to "Terminate batch job" or ignore it)
2. Run:

```bash
docker compose up --build
```

3. Open **http://localhost:8080** (not 5173)

- [ ] The same site, served by nginx; booking works end to end
- [ ] Stop it with Ctrl+C, then `docker compose stop`

---

## 7. Shutting down

- **Ctrl+C** in the terminal running `npm run dev`
- `docker compose stop` stops Postgres and Redis (your data stays)
- You can quit Docker Desktop

## If something looks wrong

| Symptom                               | Likely cause                                        | Fix                                                        |
| ------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| Home shows "Nothing in Hyderabad yet" | Showtimes ran out (seeded more than 7 days ago)     | `npm run seed`                                             |
| "Can't reach SeatLock"                | The API isn't running                               | Check Terminal 1 for `[api]` errors; restart `npm run dev` |
| `ECONNREFUSED ... 5433` in Terminal 1 | Databases not running                               | Start Docker Desktop, then `npm run dev:db`                |
| "port already in use"                 | The Docker full stack is still running              | `docker compose stop frontend api worker gateway`          |
| Refund stuck on "on its way"          | Paid before the last restart (mock gateway forgets) | Known limitation; new bookings refund fine                 |

When something doesn't match this guide, note the page, what you did and what you saw (a screenshot helps), and we'll look at it together.
