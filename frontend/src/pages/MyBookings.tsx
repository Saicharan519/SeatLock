import { useState } from 'react';
import { Link } from 'react-router';
import { Button, Notice } from '../components/ui';
import { api, ApiError, venueOf, type Booking } from '../lib/api';
import { formatCountdown, formatMoney, formatWhen } from '../lib/format';
import { useNow, usePolling } from '../lib/hooks';

type Tone = 'teal' | 'brick' | 'ink' | 'soft' | 'marigold';
const TONE: Record<Tone, string> = {
  teal: 'bg-teal/10 text-teal',
  brick: 'bg-brick/10 text-brick',
  ink: 'bg-ink text-paper',
  soft: 'bg-seat text-ink-soft',
  marigold: 'bg-marigold/25 text-marigold-deep',
};

/** What the customer needs to know about a booking, in their words. */
function describe(b: Booking, now: number): { text: string; tone: Tone } {
  const pay = b.payment?.status;
  const left = (new Date(b.expiresAt).getTime() - now) / 1000;
  if (b.status === 'CONFIRMED') return { text: 'Confirmed', tone: 'teal' };
  if (pay === 'REFUNDED')
    return { text: b.status === 'CANCELLED' ? 'Cancelled · refunded' : 'Refunded', tone: 'soft' };
  if (pay === 'REFUND_REQUIRED')
    return {
      text: b.status === 'CANCELLED' ? 'Cancelled · refund on its way' : 'Refund on its way',
      tone: 'marigold',
    };
  if (pay === 'INITIATED') return { text: 'Processing payment', tone: 'marigold' };
  if (b.status === 'FAILED' || pay === 'FAILED') return { text: 'Payment failed', tone: 'brick' };
  if (b.status === 'CANCELLED') return { text: 'Released', tone: 'soft' };
  if (b.status === 'PENDING' && left > 0)
    return { text: `Held · ${formatCountdown(left)} left`, tone: 'ink' };
  return { text: 'Hold expired', tone: 'soft' };
}

export function MyBookings() {
  const now = useNow();
  const [bookings, setBookings] = useState<Booking[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refunds and late payments settle in the background; keep the list current
  usePolling(async () => {
    const { bookings } = await api.myBookings();
    setBookings(bookings);
  }, 3000);

  const cancel = async (id: string) => {
    setError(null);
    try {
      await api.cancel(id);
      setConfirming(null);
      const { bookings } = await api.myBookings();
      setBookings(bookings);
    } catch (err) {
      const e = err as ApiError;
      setError(
        e.code === 'INVALID_STATE'
          ? 'This booking can’t be cancelled: the show has already started.'
          : e.message,
      );
    }
  };

  return (
    <div>
      <h1 className="font-display mb-8 text-3xl font-bold tracking-tight">My bookings</h1>
      {error && (
        <div className="mb-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {bookings?.length === 0 && (
        <Notice>
          No bookings yet.{' '}
          <Link to="/" className="font-semibold underline underline-offset-4">
            Find a show
          </Link>
        </Notice>
      )}
      <ul className="space-y-3">
        {bookings?.map((b) => {
          const status = describe(b, now);
          const live =
            b.status === 'PENDING' && !b.payment && new Date(b.expiresAt).getTime() > now;
          const cancellable = b.status === 'CONFIRMED' && new Date(b.show.startsAt).getTime() > now;
          return (
            <li key={b.id} className="rounded-lg border border-rule bg-card px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-display text-lg font-semibold">{b.show.movie.title}</div>
                  <div className="text-sm text-ink-soft">
                    {venueOf(b.show)} · {formatWhen(b.show.startsAt)}
                  </div>
                  <div className="mt-2 font-mono text-sm">
                    {b.seats.join(' · ')}{' '}
                    <span className="text-ink-soft">· {formatMoney(b.totalAmount)}</span>
                  </div>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${TONE[status.tone]}`}
                >
                  {status.text}
                </span>
              </div>

              {(live || cancellable) && (
                <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-dashed border-rule pt-4">
                  {live && (
                    <Link
                      to={`/checkout/${b.id}`}
                      className="text-sm font-semibold underline underline-offset-4"
                    >
                      Continue to payment
                    </Link>
                  )}
                  {cancellable &&
                    (confirming === b.id ? (
                      <>
                        <span className="text-sm">
                          Cancel and refund {formatMoney(b.totalAmount)}?
                        </span>
                        <Button variant="danger" onClick={() => cancel(b.id)}>
                          Cancel booking
                        </Button>
                        <Button variant="quiet" onClick={() => setConfirming(null)}>
                          Keep it
                        </Button>
                      </>
                    ) : (
                      <Button variant="secondary" onClick={() => setConfirming(b.id)}>
                        Cancel booking
                      </Button>
                    ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
