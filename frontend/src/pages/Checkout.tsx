import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Ticket } from '../components/Ticket';
import { Button, Label, Notice } from '../components/ui';
import { api, ApiError, type Booking } from '../lib/api';
import { formatCountdown, formatMoney } from '../lib/format';
import { useNow, usePolling } from '../lib/hooks';

const POLL_MS = 1500;
const STILL_PROCESSING_AFTER_MS = 60_000;

type View = 'ready' | 'expired' | 'processing' | 'confirmed' | 'failed' | 'refunding' | 'released';

/** Where the booking stands, from the server's statuses (and the clock, for an unpaid hold). */
function viewOf(b: Booking, now: number): View {
  const pay = b.payment?.status;
  if (b.status === 'CONFIRMED') return 'confirmed';
  if (b.status === 'CANCELLED' && !pay) return 'released';
  if (pay === 'REFUND_REQUIRED' || pay === 'REFUNDED') return 'refunding';
  if (b.status === 'FAILED' || pay === 'FAILED') return 'failed';
  if (pay === 'INITIATED') return 'processing';
  if (b.status === 'EXPIRED' || new Date(b.expiresAt).getTime() <= now) return 'expired';
  return 'ready';
}

/**
 * One idempotency key per booking, kept for the session: tapping Pay twice, or retrying
 * after a dropped connection, sends the same key, so the server charges once.
 */
function payKey(bookingId: string): string {
  const k = `seatlock.pay.${bookingId}`;
  let key = sessionStorage.getItem(k);
  if (!key) {
    key = crypto.randomUUID();
    sessionStorage.setItem(k, key);
  }
  return key;
}

export function Checkout() {
  const { bookingId } = useParams();
  const navigate = useNavigate();
  const now = useNow();
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [processingSince, setProcessingSince] = useState<number | null>(null);

  const load = useCallback(async () => {
    const { booking } = await api.booking(bookingId!);
    setBooking(booking);
  }, [bookingId]);

  useEffect(() => {
    load().catch(() => setError('We couldn’t find this booking.'));
  }, [load]);

  const view = booking ? (declined ? 'failed' : viewOf(booking, now)) : null;

  // While a payment is in flight, poll until the gateway's answer lands
  usePolling(load, POLL_MS, view === 'processing');
  useEffect(() => {
    if (view === 'processing' && processingSince === null) setProcessingSince(Date.now());
  }, [view, processingSince]);

  const pay = async () => {
    setPaying(true);
    setError(null);
    try {
      await api.pay(bookingId!, payKey(bookingId!));
      setProcessingSince(Date.now());
      await load();
    } catch (err) {
      const e = err as ApiError;
      if (e.code === 'PAYMENT_GATEWAY_ERROR') setDeclined(true);
      else if (e.code === 'BOOKING_NOT_PAYABLE' || e.code === 'PAYMENT_IN_PROGRESS') await load();
      else setError(e.message);
    } finally {
      setPaying(false);
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

  if (!booking) return error ? <Notice tone="error">{error}</Notice> : null;

  const secondsLeft = (new Date(booking.expiresAt).getTime() - now) / 1000;
  const slow = processingSince !== null && now - processingSince > STILL_PROCESSING_AFTER_MS;
  const again = (
    <Link to={`/shows/${booking.show.id}`} className="font-semibold underline underline-offset-4">
      Choose seats again
    </Link>
  );

  const stubs: Record<View, React.ReactNode> = {
    ready: (
      <div className="flex h-full flex-col">
        <Label>Held for</Label>
        <div
          className={`font-mono text-5xl font-semibold tabular-nums ${secondsLeft < 60 ? 'text-brick' : ''}`}
          role="timer"
          aria-label={`${Math.ceil(secondsLeft)} seconds left to pay`}
        >
          {formatCountdown(secondsLeft)}
        </div>
        <p className="mt-2 text-xs text-ink-soft">Nobody else can take these seats until then.</p>
        <Button onClick={pay} disabled={paying} className="mt-6 w-full">
          {paying ? 'Starting payment…' : `Pay ${formatMoney(booking.totalAmount)}`}
        </Button>
        <Button variant="quiet" onClick={release} className="mt-2 w-full">
          Release seats
        </Button>
      </div>
    ),
    processing: (
      <div aria-live="polite">
        <Label>Payment</Label>
        <div className="font-display mt-1 text-xl font-semibold">Processing…</div>
        <p className="mt-2 text-xs leading-relaxed text-ink-soft">
          {slow
            ? 'This is taking longer than usual. You can leave this page; the result will appear in My bookings.'
            : 'Waiting for your bank to confirm. Tapping Pay again won’t charge you twice.'}
        </p>
        {slow && (
          <Link
            to="/bookings"
            className="mt-4 inline-block text-sm font-semibold underline underline-offset-4"
          >
            Go to My bookings
          </Link>
        )}
      </div>
    ),
    confirmed: (
      <div>
        <Label>Status</Label>
        <div className="font-display mt-1 text-2xl font-bold text-teal">Confirmed</div>
        <p className="mt-2 text-xs text-ink-soft">Your seats are booked. Enjoy the show.</p>
        <Link
          to="/bookings"
          className="mt-4 inline-block text-sm font-semibold underline underline-offset-4"
        >
          My bookings
        </Link>
      </div>
    ),
    failed: (
      <div>
        <Label>Status</Label>
        <div className="font-display mt-1 text-2xl font-bold text-brick">Payment failed</div>
        <p className="mt-2 text-xs text-ink-soft">
          You weren’t charged, and the seats were released.
        </p>
        <p className="mt-4 text-sm">{again}</p>
      </div>
    ),
    expired: (
      <div>
        <Label>Status</Label>
        <div className="font-display mt-1 text-2xl font-bold">Hold expired</div>
        <p className="mt-2 text-xs text-ink-soft">
          Time ran out before payment, so the seats went back on sale.
        </p>
        <p className="mt-4 text-sm">{again}</p>
      </div>
    ),
    refunding: (
      <div>
        <Label>Status</Label>
        <div className="font-display mt-1 text-xl font-bold">
          {booking.payment?.status === 'REFUNDED' ? 'Refunded' : 'Refund on its way'}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-ink-soft">
          {booking.status === 'CANCELLED'
            ? 'This booking was cancelled.'
            : 'Your payment arrived after the hold expired and the seats had been taken.'}{' '}
          {booking.payment?.status === 'REFUNDED'
            ? 'The money is back on your card.'
            : 'The full amount goes back to your card.'}
        </p>
        <p className="mt-4 text-sm">{again}</p>
      </div>
    ),
    released: (
      <div>
        <Label>Status</Label>
        <div className="font-display mt-1 text-2xl font-bold">Released</div>
        <p className="mt-2 text-xs text-ink-soft">You gave these seats back.</p>
        <p className="mt-4 text-sm">{again}</p>
      </div>
    ),
  };

  return (
    <div className="mx-auto max-w-2xl">
      <Link to={`/shows/${booking.show.id}`} className="text-sm text-ink-soft hover:text-ink">
        ← Back to seats
      </Link>
      <div className="mt-4">
        <Ticket booking={booking} stub={stubs[view!]} />
      </div>
      {error && (
        <div className="mt-4">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
    </div>
  );
}
