import { useState } from 'react';
import { Link } from 'react-router';
import { Poster } from '../components/Poster';
import {
  bookingPill,
  Button,
  ButtonLink,
  EmptyState,
  Eyebrow,
  Notice,
  Skeleton,
  StatusPill,
} from '../components/ui';
import { api, ApiError, type Booking } from '../lib/api';
import { bookingRef, formatCountdown, formatMoney, formatWhen, seatOrder } from '../lib/format';
import { useNow, usePolling, useTitle } from '../lib/hooks';

type Tab = 'upcoming' | 'past';

/** Upcoming: the show hasn't started and the booking is (or may still become) yours. */
function isUpcoming(b: Booking, now: number) {
  const future = new Date(b.show.startsAt).getTime() > now;
  const live =
    b.status === 'CONFIRMED' ||
    b.payment?.status === 'INITIATED' ||
    (b.status === 'PENDING' && new Date(b.expiresAt).getTime() > now);
  return future && live;
}

function BookingCard({
  booking,
  now,
  onCancelled,
}: {
  booking: Booking;
  now: number;
  onCancelled: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const b = booking;
  const pill = bookingPill(b.status, b.payment?.status);
  const secondsLeft = (new Date(b.expiresAt).getTime() - now) / 1000;
  const held = b.status === 'PENDING' && !b.payment && secondsLeft > 0;
  const cancellable = b.status === 'CONFIRMED' && new Date(b.show.startsAt).getTime() > now;

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.cancel(b.id);
      setConfirming(false);
      await onCancelled();
    } catch (err) {
      const e = err as ApiError;
      setError(
        e.code === 'INVALID_STATE'
          ? 'This booking can’t be cancelled: the show has already started.'
          : e.message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="animate-rise rounded-2xl border border-line bg-night-2/60 p-4 sm:p-5">
      <div className="flex gap-4">
        <Link to={`/movies/${b.show.movie.slug}`} className="shrink-0">
          <Poster
            url={b.show.movie.posterUrl}
            title={b.show.movie.title}
            size="w185"
            className="w-16 rounded-lg sm:w-20"
          />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="font-display truncate text-2xl leading-tight font-extrabold tracking-wide uppercase">
                {b.show.movie.title}
              </h3>
              <div className="text-sm text-dim">{formatWhen(b.show.startsAt)}</div>
              <div className="truncate text-sm text-faint">
                {b.show.theatre.name}, {b.show.theatre.city} · {b.show.screen.name}
              </div>
            </div>
            <StatusPill
              pill={
                held ? { label: `Held · ${formatCountdown(secondsLeft)} left`, tone: 'mine' } : pill
              }
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className="font-mono font-semibold">
              {[...b.seats].sort(seatOrder).join(', ')}
            </span>
            <span className="text-dim">{formatMoney(b.totalAmount)}</span>
            <span className="font-mono text-xs text-faint">#{bookingRef(b.id)}</span>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {b.status === 'CONFIRMED' && (
              <ButtonLink to={`/bookings/${b.id}`} className="px-4 py-2">
                View ticket
              </ButtonLink>
            )}
            {(held || b.payment?.status === 'INITIATED') && (
              <ButtonLink to={`/checkout/${b.id}`} className="px-4 py-2">
                {held ? 'Continue to payment' : 'View payment'}
              </ButtonLink>
            )}
            {cancellable &&
              (confirming ? (
                <div className="flex flex-wrap items-center gap-2 rounded-full border border-bad/40 bg-bad/5 py-1 pr-1 pl-4 text-sm">
                  <span className="text-dim">
                    Cancel and refund{' '}
                    <span className="font-semibold text-screen">{formatMoney(b.totalAmount)}</span>?
                  </span>
                  <Button variant="danger" onClick={cancel} disabled={busy} className="px-4 py-1.5">
                    {busy ? 'Cancelling…' : 'Yes, cancel'}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => setConfirming(false)}
                    className="px-3 py-1.5"
                  >
                    Keep it
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" onClick={() => setConfirming(true)} className="px-3 py-2">
                  Cancel booking
                </Button>
              ))}
          </div>
          {error && (
            <Notice tone="error" className="mt-3">
              {error}
            </Notice>
          )}
        </div>
      </div>
    </li>
  );
}

export function MyBookings() {
  useTitle('My bookings');
  const now = useNow();
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('upcoming');

  const refresh = async () => {
    try {
      const { bookings } = await api.myBookings();
      setBookings(bookings);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // Refunds and late payments settle in the background; keep the list current
  usePolling(refresh, 3000);

  const upcoming = bookings?.filter((b) => isUpcoming(b, now)) ?? [];
  const past = bookings?.filter((b) => !isUpcoming(b, now)) ?? [];
  const list = tab === 'upcoming' ? upcoming : past;

  return (
    <div className="mx-auto max-w-4xl px-4 pt-12 sm:px-6">
      <Eyebrow>Your account</Eyebrow>
      <h1 className="font-display mt-1 text-5xl font-black tracking-wide uppercase">My bookings</h1>

      <div className="mt-8 inline-flex rounded-full border border-line-2 p-1" role="tablist">
        {(
          [
            ['upcoming', `Upcoming${bookings ? ` · ${upcoming.length}` : ''}`],
            ['past', `Past & cancelled${bookings ? ` · ${past.length}` : ''}`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition-colors ${
              tab === key ? 'bg-screen text-night' : 'text-dim hover:text-screen'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {error && <Notice tone="error">{error}</Notice>}
        {!bookings && !error && (
          <div className="space-y-4">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-36 rounded-2xl" />
            ))}
          </div>
        )}
        {bookings && list.length === 0 && (
          <EmptyState
            title={tab === 'upcoming' ? 'No upcoming shows' : 'Nothing here yet'}
            action={<ButtonLink to="/movies">Find a film</ButtonLink>}
          >
            {tab === 'upcoming'
              ? 'Tickets you book appear here, ready to show at the entrance.'
              : 'Past, cancelled and expired bookings appear here.'}
          </EmptyState>
        )}
        <ul className="space-y-4">
          {list.map((b) => (
            <BookingCard key={b.id} booking={b} now={now} onCancelled={refresh} />
          ))}
        </ul>
      </div>
    </div>
  );
}
