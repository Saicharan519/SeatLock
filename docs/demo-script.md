# Demo script

Two short recordings show the two hardest guarantees: **the race** (1,000 people, 50 seats) and **the late payment** (money arrives after the hold expired). Each step below was rehearsed against the Docker stack, and the timings are measured, not estimated.

Total running time is about 4 minutes. Any screen recorder works: Xbox Game Bar (`Win + Alt + R`), OBS, or Loom.

## Before recording

1. Start the stack from the repo root and wait until http://localhost:8080 loads:

   ```bash
   docker compose up --build -d
   ```

2. One-time setup for the race demo (it runs on the host, against its own `seatlock_load` database):

   ```bash
   npm ci
   cp .env.example .env
   docker compose exec postgres createdb -U seatlock seatlock_load   # "already exists" is fine
   DATABASE_URL=postgres://seatlock:seatlock@localhost:5433/seatlock_load npm run migrate:up
   ```

3. Open two browser windows side by side: a normal one ("Alice") and a private/incognito one ("Bob"). Create an account in each at http://localhost:8080.
4. Make the terminal font large enough to read in the recording.

## Recording 1: the race (about 1 minute)

**Point:** "check the seat is free, then take it" breaks under concurrency; SeatLock doesn't.

1. In the terminal, run:

   ```bash
   npm run demo:race
   ```

2. It takes about 30 seconds and prints a table like this one (measured on the Docker stack):

   | implementation                       | told | held | misled |
   | ------------------------------------ | ---- | ---- | ------ |
   | naive read-then-write, 20 ms work    | 723  | 50   | 673    |
   | naive read-then-write, no delay      | 532  | 50   | 482    |
   | SeatLock (locks + conditional claim) | 50   | 50   | 0      |

3. Points to show on screen:
   - **told** is how many customers were told "you hold a seat". Only 50 seats exist.
   - The naive version misled hundreds of customers. Its last column shows the database's partial unique index blocking every second confirmation, so even the naive version can't actually sell a seat twice. The customers were still lied to.
   - SeatLock: 50 told, 50 held, 0 misled.

## Recording 2: the late payment (about 3 minutes)

**Point:** a payment that arrives after the hold expired either re-claims _all_ the seats or is refunded in full. Never a partial booking, never charged with no ticket.

### Setup (not recorded)

Restart the API with a 30-second hold, and make the mock gateway confirm payments late:

```bash
HOLD_TTL_SECONDS=30 docker compose up -d
curl -X POST localhost:4000/__control -H "content-type: application/json" -d "{\"mode\":\"late-webhook\",\"lateMs\":50000}"
```

Each payment's success webhook now arrives 50 seconds after Pay is clicked, which is 20 seconds after the hold expired. The worker marks the expired hold `EXPIRED` within its 5-second tick.

### Case A: the seats are still free → confirmed

1. **Alice:** open the show, pick two seats (say B1 and B2), click **Hold**, then **Pay** right away.
2. The checkout shows **Processing**. The hold's countdown runs out at 30 s; the payment is still in flight, so the page keeps waiting.
3. At about 50 s the late webhook lands. Nobody took B1 or B2, so SeatLock re-claims both: the page switches to **Confirmed**.

Rehearsed through the API with a 45 s gateway delay: hold expired at 31.9 s, confirmed at 45.5 s.

### Case B: a seat was taken → refunded

1. **Alice:** pick two seats (say C1 and C2), **Hold**, **Pay**. The page shows **Processing**.
2. Wait about 35 seconds, until Alice's hold has expired. In **Bob's** window the seat map now shows C1 and C2 as available again.
3. **Bob:** pick **C2** and click **Hold**. It succeeds: Alice's hold is gone.
4. At about 50 s Alice's payment arrives. C2 now belongs to Bob, and SeatLock never confirms part of a booking, so Alice's page switches to **Refund on its way**: "Your payment arrived after the hold expired and the seats had been taken."
5. About 2 seconds later the worker has sent the refund to the gateway and the refund webhook has come back. Reload Alice's page: **Refunded**.
6. Bob's hold on C2 is untouched, and C1 is free for anyone.

Rehearsed in the UI exactly as written (50 s delay, Bob holding at 36 s): Alice's page stayed on Processing past the expiry, switched to Refund on its way, and showed Refunded after a reload; the payment reached `REFUNDED` 52 s after Pay.

### Afterwards

Put the stack back to normal: a 5-minute hold and instant payments.

```bash
docker compose up -d
curl -X POST localhost:4000/__control -H "content-type: application/json" -d "{\"mode\":\"success\"}"
```

## Optional extras

- **Double-click Pay:** with the normal settings, click Pay twice quickly. Exactly one payment is created, because both clicks send the same idempotency key.
- **Admin view of the outbox:** sign in as `admin@seatlock.local`. Call `GET /api/admin/outbox-events` with the admin's token to show the `BookingConfirmed` and `RefundRequired` events the worker delivered.
