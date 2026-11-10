import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Poster } from '../components/Poster';
import { Ticket } from '../components/Ticket';
import {
  Button,
  ButtonLink,
  Certificate,
  EmptyState,
  Eyebrow,
  Notice,
  Skeleton,
  Spinner,
} from '../components/ui';
import { api, ApiError, type Booking, type PaymentProvider } from '../lib/api';
import { openCashfreeCheckout } from '../lib/cashfree';
import { categoryName, formatCountdown, formatMoney, formatWhen, seatOrder } from '../lib/format';
import { useNow, usePolling, useTitle } from '../lib/hooks';

const POLL_MS = 1500;
const STILL_PROCESSING_AFTER_MS = 60_000;
const HOLD_SECONDS = 300;

type View =
  'ready' | 'finish' | 'expired' | 'processing' | 'confirmed' | 'failed' | 'refunding' | 'released';

/** Where the booking stands, from the server's statuses (and the clock, for an unpaid hold). */
function viewOf(b: Booking, now: number): View {
  const pay = b.payment?.status;
  if (b.status === 'CONFIRMED') return 'confirmed';
  if (b.status === 'CANCELLED' && !pay) return 'released';
  if (pay === 'REFUND_REQUIRED' || pay === 'REFUNDED') return 'refunding';
  if (b.status === 'FAILED' || pay === 'FAILED') return 'failed';
  // A Cashfree payment that's open while the hold is live: the customer may not have paid yet
  // (closed the checkout, or came back without finishing), so offer to finish it
  if (
    pay === 'INITIATED' &&
    b.payment?.provider === 'CASHFREE' &&
    b.status === 'PENDING' &&
    new Date(b.expiresAt).getTime() > now
  ) {
    return 'finish';
  }
  if (pay === 'INITIATED') return 'processing';
  if (b.status === 'EXPIRED' || new Date(b.expiresAt).getTime() <= now) return 'expired';
  return 'ready';
}

/**
 * One idempotency key per booking, kept for the session: tapping Pay twice, or retrying
 * after a dropped connection, sends the same key, so the server charges once.
 */
function payKey(bookingId: string, provider: PaymentProvider): string {
  const k = `seatlock.pay.${bookingId}${provider === 'MOCK' ? '' : '.' + provider}`;
  let key = sessionStorage.getItem(k);
  if (!key) {
    key = crypto.randomUUID();
    sessionStorage.setItem(k, key);
  }
  return key;
}

/** The time left on the hold, as a ring that empties. */
function Countdown({ seconds }: { seconds: number }) {
  const fraction = Math.max(0, Math.min(1, seconds / HOLD_SECONDS));
  const r = 52;
  const c = 2 * Math.PI * r;
  const urgent = seconds < 60;
  return (
    <div
      className="relative mx-auto h-36 w-36"
      role="timer"
      aria-label={`${Math.ceil(Math.max(0, seconds))} seconds left to pay`}
    >
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90" aria-hidden="true">
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--color-line)" strokeWidth="6" />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke={urgent ? 'var(--color-bad)' : 'var(--color-marigold)'}
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - fraction)}
          style={{ transition: 'stroke-dashoffset 1s linear, stroke 300ms' }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <div
            className={`font-mono text-3xl font-semibold tabular-nums ${urgent ? 'text-bad' : ''}`}
          >
            {formatCountdown(seconds)}
          </div>
          <div className="text-[10px] tracking-[0.2em] text-faint uppercase">left to pay</div>
        </div>
      </div>
    </div>
  );
}

/** The payment as it travels: started, waiting for the gateway's signed callback, done. */
function Tracker({ done }: { done: number }) {
  const steps = [
    ['Payment started', 'Recorded before the gateway was called'],
    ['Waiting for confirmation', 'The gateway confirms with a signed message to our server'],
    ['Seats confirmed', 'Your ticket is ready'],
  ];
  return (
    <ol className="space-y-5">
      {steps.map(([title, text], i) => {
        const state = i < done ? 'done' : i === done ? 'active' : 'todo';
        return (
          <li key={title} className="flex gap-4">
            <span
              className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border text-sm font-semibold ${
                state === 'done'
                  ? 'border-ok bg-ok/15 text-ok'
                  : state === 'active'
                    ? 'border-marigold text-marigold'
                    : 'border-line-2 text-faint'
              }`}
            >
              {state === 'done' ? '✓' : state === 'active' ? <Spinner /> : i + 1}
            </span>
            <div>
              <div className={state === 'todo' ? 'text-faint' : 'font-semibold'}>{title}</div>
              <div className="text-xs text-faint">{text}</div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Summary({ booking }: { booking: Booking }) {
  const { show } = booking;
  const groups = [...booking.items]
    .sort((a, b) => seatOrder(a.label, b.label))
    .reduce<Record<string, { seats: string[]; price: number }>>((acc, i) => {
      const g = (acc[i.category] ??= { seats: [], price: i.price });
      g.seats.push(i.label);
      return acc;
    }, {});
  return (
    <section
      className="rounded-3xl border border-line bg-night-2/60 p-6"
      aria-label="Order summary"
    >
      <div className="flex gap-4">
        <Poster
          url={show.movie.posterUrl}
          title={show.movie.title}
          size="w185"
          className="w-20 shrink-0 rounded-lg"
        />
        <div className="min-w-0">
          <h2 className="font-display text-3xl leading-none font-black tracking-wide uppercase">
            {show.movie.title}
          </h2>
          <div className="mt-2 flex items-center gap-2 text-xs text-dim">
            <Certificate value={show.movie.certificate} />
            {show.movie.language}
          </div>
          <div className="mt-3 text-sm">{formatWhen(show.startsAt)}</div>
          <div className="text-sm text-dim">
            {show.theatre.name}, {show.theatre.city} · {show.screen.name}
          </div>
        </div>
      </div>
      <dl className="mt-6 space-y-3 border-t border-dashed border-line-2 pt-5 text-sm">
        {Object.entries(groups).map(([category, g]) => (
          <div key={category} className="flex justify-between gap-4">
            <dt>
              <span className="text-dim">{categoryName(category)}</span>{' '}
              <span className="font-mono font-semibold">{g.seats.join(', ')}</span>
              <div className="text-xs text-faint">
                {g.seats.length} × {formatMoney(g.price)}
              </div>
            </dt>
            <dd className="font-mono">{formatMoney(g.price * g.seats.length)}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-5 flex items-baseline justify-between border-t border-line-2 pt-5">
        <span className="text-sm text-dim">Total</span>
        <span className="font-display text-4xl font-black tracking-wide">
          {formatMoney(booking.totalAmount)}
        </span>
      </div>
    </section>
  );
}

function MethodOption({
  selected,
  onSelect,
  title,
  text,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  text: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={`flex w-full items-start gap-3 rounded-2xl border p-4 text-left transition-colors ${
        selected ? 'border-marigold/60 bg-marigold/5' : 'border-line-2 hover:border-dim'
      }`}
    >
      <span
        className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 ${
          selected ? 'border-marigold' : 'border-line-2'
        }`}
      >
        {selected && <span className="h-2 w-2 rounded-full bg-marigold" />}
      </span>
      <span className="text-sm">
        <span className="block font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-dim">{text}</span>
      </span>
    </button>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-3xl border border-line bg-night-2 p-6 sm:p-8">{children}</section>
  );
}

export function BookingPage() {
  const { bookingId } = useParams();
  const navigate = useNavigate();
  const now = useNow();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [paying, setPaying] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [processingSince, setProcessingSince] = useState<number | null>(null);
  const [providers, setProviders] = useState<PaymentProvider[]>(['MOCK']);
  const [method, setMethod] = useState<PaymentProvider>('MOCK');
  const [opening, setOpening] = useState(false);
  const [searchParams] = useSearchParams();
  /** Back from Cashfree's page (Cashfree adds ?order_id=...) */
  const returned = Boolean(searchParams.get('order_id'));

  const load = useCallback(async () => {
    const { booking } = await api.booking(bookingId!);
    setBooking(booking);
  }, [bookingId]);

  useEffect(() => {
    load().catch(() => setNotFound(true));
  }, [load]);

  useEffect(() => {
    api
      .paymentOptions()
      .then(({ providers }) => {
        setProviders(providers);
        if (providers.includes('CASHFREE')) setMethod('CASHFREE');
      })
      .catch(() => undefined);
  }, []);

  // Back from Cashfree's page (?order_id=...): ask for the outcome right away
  useEffect(() => {
    if (searchParams.get('order_id')) {
      api
        .refreshPayment(bookingId!)
        .then(load)
        .catch(() => undefined);
    }
  }, [searchParams, bookingId, load]);

  const view = booking ? (declined ? 'failed' : viewOf(booking, now)) : null;
  useTitle(view === 'confirmed' ? 'Your ticket' : 'Checkout');

  // While a payment is in flight, poll until the gateway's answer lands
  usePolling(load, POLL_MS, view === 'processing' || view === 'finish');
  // Cashfree: also ask Cashfree directly every few seconds, in case its webhook is slow
  const viaCashfree = booking?.payment?.provider === 'CASHFREE';
  usePolling(
    async () => {
      await api.refreshPayment(bookingId!);
    },
    5000,
    (view === 'processing' || view === 'finish') && viaCashfree,
  );
  useEffect(() => {
    if (view === 'processing' && processingSince === null) setProcessingSince(Date.now());
  }, [view, processingSince]);

  const pay = async () => {
    setPaying(true);
    setError(null);
    try {
      const res = await api.pay(bookingId!, payKey(bookingId!, method), method);
      setProcessingSince(Date.now());
      await load();
      if (res.provider === 'CASHFREE') await openCheckout(res.paymentSessionId);
    } catch (err) {
      const e = err as ApiError;
      if (e.code === 'PAYMENT_GATEWAY_ERROR') setDeclined(true);
      else if (e.code === 'BOOKING_NOT_PAYABLE' || e.code === 'PAYMENT_IN_PROGRESS') await load();
      else setError(e.message);
    } finally {
      setPaying(false);
    }
  };

  /** Opens (or re-opens) Cashfree's checkout, then asks SeatLock for the real outcome */
  const openCheckout = async (sessionId?: string) => {
    setOpening(true);
    setError(null);
    try {
      const id = sessionId ?? (await api.paymentSession(bookingId!)).paymentSessionId;
      await openCashfreeCheckout(id);
      await api.refreshPayment(bookingId!).catch(() => undefined);
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setOpening(false);
    }
  };

  const release = async () => {
    try {
      await api.release(bookingId!);
      navigate(`/shows/${booking!.show.id}`);
    } catch (err) {
      setError((err as ApiError).message);
    }
  };

  if (notFound) {
    return (
      <div className="mx-auto max-w-3xl px-4 pt-20">
        <EmptyState
          title="Booking not found"
          action={<ButtonLink to="/bookings">My bookings</ButtonLink>}
        >
          This booking doesn’t exist, or it belongs to another account.
        </EmptyState>
      </div>
    );
  }
  if (!booking || !view) {
    return (
      <div className="mx-auto grid max-w-6xl gap-6 px-4 pt-12 sm:px-6 lg:grid-cols-[1fr_420px]">
        <Skeleton className="h-80 rounded-3xl" />
        <Skeleton className="h-80 rounded-3xl" />
      </div>
    );
  }

  const secondsLeft = (new Date(booking.expiresAt).getTime() - now) / 1000;
  const slow = processingSince !== null && now - processingSince > STILL_PROCESSING_AFTER_MS;
  const again = (
    <ButtonLink to={`/shows/${booking.show.id}`} variant="secondary">
      Choose seats again
    </ButtonLink>
  );

  if (view === 'confirmed') {
    return (
      <div className="mx-auto max-w-6xl px-4 pt-12 sm:px-6">
        <div className="mb-10 animate-rise text-center print:hidden">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-ok/15 text-2xl text-ok">
            ✓
          </div>
          <h1 className="font-display mt-4 text-5xl font-black tracking-wide uppercase">
            You’re in
          </h1>
          <p className="mt-2 text-dim">
            Booking confirmed. Your ticket is below and in{' '}
            <Link to="/bookings" className="text-screen underline underline-offset-4">
              My bookings
            </Link>
            .
          </p>
        </div>
        <div className="animate-rise [animation-delay:120ms]">
          <Ticket booking={booking} />
        </div>
        <div className="mt-8 flex flex-wrap justify-center gap-3 print:hidden">
          <Button variant="secondary" onClick={() => window.print()}>
            Print ticket
          </Button>
          <ButtonLink to="/movies" variant="ghost">
            Book another film
          </ButtonLink>
        </div>
      </div>
    );
  }

  const side: Record<Exclude<View, 'confirmed'>, ReactNode> = {
    ready: (
      <Panel>
        <Countdown seconds={secondsLeft} />
        <p className="mt-3 text-center text-sm text-dim">
          These seats are locked to you. Nobody else can take them until the timer runs out.
        </p>
        <div className="mt-8">
          <div className="flex items-center justify-between">
            <Eyebrow>Payment</Eyebrow>
            <span className="rounded-full border border-warn/40 bg-warn/10 px-2.5 py-0.5 font-mono text-[10px] tracking-widest text-warn uppercase">
              Sandbox
            </span>
          </div>
          <div className="mt-3 space-y-2" role="radiogroup" aria-label="Payment method">
            {providers.includes('CASHFREE') && (
              <MethodOption
                selected={method === 'CASHFREE'}
                onSelect={() => setMethod('CASHFREE')}
                title="Cashfree (test mode)"
                text="A real payment gateway in sandbox mode: UPI, cards and net banking with test details. No real money moves."
              />
            )}
            <MethodOption
              selected={method === 'MOCK'}
              onSelect={() => setMethod('MOCK')}
              title="Simulated gateway"
              text="SeatLock's own test gateway: pays instantly, no details asked for."
            />
          </div>
        </div>
        <Button onClick={pay} disabled={paying} className="mt-6 w-full py-3.5 text-base">
          {paying ? (
            <>
              <Spinner /> Starting payment…
            </>
          ) : (
            `Pay ${formatMoney(booking.totalAmount)}`
          )}
        </Button>
        <Button variant="ghost" onClick={release} className="mt-2 w-full">
          Release seats
        </Button>
      </Panel>
    ),
    finish: (
      <Panel>
        <Countdown seconds={secondsLeft} />
        <div className="mt-6" aria-live="polite">
          <Eyebrow>Cashfree · test mode</Eyebrow>
          <h2 className="font-display mt-1 text-3xl font-black tracking-wide uppercase">
            Finish your payment
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-dim">
            {returned
              ? 'The payment isn’t complete yet. If you just paid, this page updates by itself within a few seconds.'
              : 'Your seats are held. Continue to Cashfree to pay; it’s the same payment, so you can’t be charged twice.'}
          </p>
        </div>
        <Button
          onClick={() => openCheckout()}
          disabled={opening}
          className="mt-6 w-full py-3.5 text-base"
        >
          {opening ? (
            <>
              <Spinner /> Opening Cashfree…
            </>
          ) : (
            `Continue to Cashfree · ${formatMoney(booking.totalAmount)}`
          )}
        </Button>
        <Button variant="ghost" onClick={release} className="mt-2 w-full">
          Release seats
        </Button>
      </Panel>
    ),
    processing: (
      <Panel>
        <div aria-live="polite">
          <Eyebrow>Payment</Eyebrow>
          <h2 className="font-display mt-1 mb-6 text-3xl font-black tracking-wide uppercase">
            Processing
          </h2>
          <Tracker done={1} />
          <p className="mt-6 text-xs leading-relaxed text-faint">
            {slow
              ? 'This is taking longer than usual. You can leave this page: the result will appear in My bookings.'
              : 'Tapping Pay again won’t charge you twice. You can close this page; the booking still completes.'}
          </p>
          {slow && (
            <ButtonLink to="/bookings" variant="secondary" className="mt-4">
              Go to My bookings
            </ButtonLink>
          )}
        </div>
      </Panel>
    ),
    failed: (
      <Panel>
        <Eyebrow className="text-bad">Payment failed</Eyebrow>
        <h2 className="font-display mt-1 text-3xl font-black tracking-wide uppercase">
          Not charged
        </h2>
        <p className="mt-3 text-sm text-dim">
          The payment was declined, so the seats were released.
        </p>
        <div className="mt-6">{again}</div>
      </Panel>
    ),
    expired: (
      <Panel>
        <Eyebrow>Time’s up</Eyebrow>
        <h2 className="font-display mt-1 text-3xl font-black tracking-wide uppercase">
          Hold expired
        </h2>
        <p className="mt-3 text-sm text-dim">
          Time ran out before payment, so the seats went back on sale.
        </p>
        <div className="mt-6">{again}</div>
      </Panel>
    ),
    refunding: (
      <Panel>
        <Eyebrow className="text-warn">
          {booking.payment?.status === 'REFUNDED' ? 'Refunded' : 'Refund in progress'}
        </Eyebrow>
        <h2 className="font-display mt-1 text-3xl font-black tracking-wide uppercase">
          {booking.payment?.status === 'REFUNDED' ? 'Money returned' : 'Refund on its way'}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-dim">
          {booking.status === 'CANCELLED'
            ? 'This booking was cancelled.'
            : 'Your payment arrived after the hold had expired and the seats had been taken, so you weren’t booked.'}{' '}
          {booking.payment?.status === 'REFUNDED'
            ? 'The full amount has been returned.'
            : 'The full amount is being returned.'}
        </p>
        <div className="mt-6">{again}</div>
      </Panel>
    ),
    released: (
      <Panel>
        <Eyebrow>Released</Eyebrow>
        <h2 className="font-display mt-1 text-3xl font-black tracking-wide uppercase">
          Seats given back
        </h2>
        <p className="mt-3 text-sm text-dim">You released this hold. Nothing was charged.</p>
        <div className="mt-6">{again}</div>
      </Panel>
    ),
  };

  return (
    <div className="mx-auto max-w-6xl px-4 pt-10 sm:px-6">
      <Link to={`/shows/${booking.show.id}`} className="text-sm text-dim hover:text-screen">
        ← Back to seats
      </Link>
      <h1 className="font-display mt-3 mb-8 text-5xl font-black tracking-wide uppercase">
        Checkout
      </h1>
      <div className="grid animate-rise items-start gap-6 lg:grid-cols-[1fr_420px]">
        <Summary booking={booking} />
        <div>{side[view]}</div>
      </div>
      {error && (
        <Notice tone="error" className="mt-6">
          {error}
        </Notice>
      )}
    </div>
  );
}
