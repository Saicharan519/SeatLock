import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { SeatGrid, SeatLegend } from '../components/SeatGrid';
import { Button, Label, Notice } from '../components/ui';
import { api, ApiError, venueOf, type SeatMap, type SeatStatus, type Show } from '../lib/api';
import { formatMoney, formatWhen } from '../lib/format';
import { usePolling } from '../lib/hooks';

const MAX_SEATS = 6;
const SEAT_ORDER = (a: string, b: string) =>
  a[0]! === b[0]! ? Number(a.slice(1)) - Number(b.slice(1)) : a.localeCompare(b);

export function ShowSeats() {
  const { showId } = useParams();
  const navigate = useNavigate();
  const [show, setShow] = useState<Show | null>(null);
  const [seats, setSeats] = useState<Map<string, SeatStatus>>(new Map());
  const [plan, setPlan] = useState<Pick<SeatMap, 'layout' | 'prices'> | null>(null);
  /** label -> price in paise, from the seat's category */
  const [priceOf, setPriceOf] = useState<Map<string, number>>(new Map());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: React.ReactNode } | null>(
    null,
  );
  const [holding, setHolding] = useState(false);
  /** The signed-in user's own live hold on this show, if any */
  const [myHold, setMyHold] = useState<{ bookingId: string; seats: string[] } | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    api
      .show(showId!)
      .then(({ show }) => setShow(show))
      .catch(() =>
        setNotice({ tone: 'error', text: 'This show doesn’t exist or is no longer listed.' }),
      );
  }, [showId]);

  // Live seat map: other people's holds and bookings appear within ~2 s. The public map
  // can't say whose hold a seat is under, so the user's own live hold is fetched alongside.
  usePolling(async () => {
    const [{ seats: list, layout, prices }, { bookings }] = await Promise.all([
      api.seatMap(showId!),
      api.myBookings(),
    ]);
    const next = new Map(list.map((s) => [s.label, s.status]));
    const byCategory = new Map(prices.map((p) => [p.category, p.price]));
    setPlan({ layout, prices });
    setPriceOf(new Map(list.map((s) => [s.label, byCategory.get(s.category) ?? 0])));
    const live = bookings.find(
      (b) =>
        b.show.id === showId &&
        b.status === 'PENDING' &&
        new Date(b.expiresAt).getTime() > Date.now(),
    );
    setSeats(next);
    setMyHold(live ? { bookingId: live.id, seats: live.seats } : null);

    const gone = [...selectedRef.current].filter((l) => next.get(l) !== 'AVAILABLE');
    if (gone.length > 0) {
      setSelected((prev) => new Set([...prev].filter((l) => !gone.includes(l))));
      setNotice({
        tone: 'info',
        text: `${gone.sort(SEAT_ORDER).join(', ')} ${gone.length === 1 ? 'was' : 'were'} just taken by someone else.`,
      });
    }
  }, 2000);

  const toggle = (label: string) => {
    setNotice(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else if (next.size < MAX_SEATS) next.add(label);
      else setNotice({ tone: 'info', text: `You can hold up to ${MAX_SEATS} seats at a time.` });
      return next;
    });
  };

  const hold = async () => {
    setHolding(true);
    setNotice(null);
    try {
      // A fresh key per attempt: a double-click is deduplicated by the server, a new try isn't
      const { bookingId } = await api.hold(showId!, [...selected], crypto.randomUUID());
      navigate(`/checkout/${bookingId}`);
    } catch (err) {
      const e = err as ApiError;
      if (e.code === 'SEAT_UNAVAILABLE') {
        setNotice({
          tone: 'error',
          text: 'Someone else got one of those seats first. Pick again from the updated map.',
        });
        const { seats: list } = await api.seatMap(showId!);
        const next = new Map(list.map((s) => [s.label, s.status]));
        setSeats(next);
        setSelected((prev) => new Set([...prev].filter((l) => next.get(l) === 'AVAILABLE')));
      } else if (e.code === 'ACTIVE_HOLD_EXISTS') {
        setNotice({
          tone: 'error',
          text: (
            <>
              You’re already holding seats for this show.{' '}
              <Link
                to={myHold ? `/checkout/${myHold.bookingId}` : '/bookings'}
                className="font-semibold underline underline-offset-4"
              >
                Finish or release that hold
              </Link>{' '}
              first.
            </>
          ),
        });
      } else if (e.code === 'INVALID_STATE') {
        setNotice({
          tone: 'error',
          text: 'This show has already started, so it can’t be booked any more.',
        });
      } else {
        setNotice({ tone: 'error', text: e.message });
      }
    } finally {
      setHolding(false);
    }
  };

  const picked = [...selected].sort(SEAT_ORDER);
  const total = picked.reduce((sum, l) => sum + (priceOf.get(l) ?? 0), 0);

  return (
    <div>
      <Link to="/" className="text-sm text-ink-soft hover:text-ink">
        ← All shows
      </Link>
      {show && (
        <div className="mt-3 mb-10">
          <h1 className="font-display text-3xl font-bold tracking-tight">{show.movie.title}</h1>
          <p className="text-ink-soft">
            {venueOf(show)} · {formatWhen(show.startsAt)}
          </p>
          <p className="mt-1 font-mono text-xs text-ink-soft">
            {show.prices
              .map((p) => `${p.category.replace(/_/g, ' ')} ${formatMoney(p.price)}`)
              .join('  ·  ')}
          </p>
        </div>
      )}

      <div className="grid gap-10 lg:grid-cols-[1fr_280px]">
        <section aria-label="Seat map" className="min-w-0 space-y-8">
          {/* Not before the first real seat map: an empty map would show every seat as free */}
          {seats.size > 0 && plan ? (
            <SeatGrid
              rows={plan.layout.rows}
              seats={seats}
              selected={selected}
              mine={new Set(myHold?.seats)}
              onToggle={toggle}
            />
          ) : (
            <p className="py-24 text-center text-sm text-ink-soft">Loading the seat map…</p>
          )}
          <SeatLegend />
        </section>

        {myHold ? (
          // One live hold per show: finish (or release) it rather than starting another
          <aside className="h-fit rounded-lg border border-ink/20 bg-card p-5 lg:sticky lg:top-6">
            <Label>Your hold</Label>
            <div className="mt-2 font-mono text-lg font-medium">
              {[...myHold.seats].sort(SEAT_ORDER).join(' · ')}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-ink-soft">
              These seats are yours until the timer runs out. Pay to keep them, or release them to
              pick others.
            </p>
            <Link
              to={`/checkout/${myHold.bookingId}`}
              className="mt-5 flex w-full items-center justify-center rounded-md bg-ink px-4 py-2.5 text-sm font-semibold text-paper hover:bg-booked"
            >
              Continue to payment
            </Link>
          </aside>
        ) : (
          <aside className="h-fit rounded-lg border border-rule bg-card p-5 lg:sticky lg:top-6">
            <Label>Your seats</Label>
            <div className="mt-2 min-h-8 font-mono text-lg font-medium">
              {picked.length ? (
                picked.join(' · ')
              ) : (
                <span className="text-sm text-ink-soft">Tap seats on the map</span>
              )}
            </div>
            <div className="my-5 border-t border-dashed border-rule" />
            <div className="flex items-baseline justify-between">
              <Label>Total</Label>
              <span className="font-mono text-xl font-semibold">{formatMoney(total)}</span>
            </div>
            {picked.length > 0 && (
              <div className="mt-1 text-right font-mono text-xs text-ink-soft">
                {picked.map((l) => `${l} ${formatMoney(priceOf.get(l) ?? 0)}`).join(' + ')}
              </div>
            )}
            <Button
              onClick={hold}
              disabled={picked.length === 0 || holding}
              className="mt-5 w-full"
            >
              {holding
                ? 'Holding…'
                : picked.length
                  ? `Hold ${picked.length} seat${picked.length > 1 ? 's' : ''}`
                  : 'Hold seats'}
            </Button>
            <p className="mt-3 text-xs leading-relaxed text-ink-soft">
              Held seats are yours for 5 minutes while you pay. Nobody else can take them.
            </p>
            {notice && (
              <div className="mt-4">
                <Notice tone={notice.tone}>{notice.text}</Notice>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
