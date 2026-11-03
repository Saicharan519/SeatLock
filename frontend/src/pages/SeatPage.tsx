import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { Poster } from '../components/Poster';
import { SeatLegend, SeatMap } from '../components/SeatMap';
import {
  Button,
  ButtonLink,
  Certificate,
  EmptyState,
  Notice,
  Skeleton,
  Spinner,
} from '../components/ui';
import { api, ApiError, type SeatMap as SeatMapData, type SeatStatus } from '../lib/api';
import { useAuth } from '../lib/auth';
import { categoryName, formatMoney, formatWhen, seatOrder } from '../lib/format';
import { useLoad, usePolling, useTitle } from '../lib/hooks';

const MAX_SEATS = 6;
const POLL_MS = 2000;

/** Picks survive the trip to the sign-in page and back. */
const pickKey = (showId: string) => `seatlock.pick.${showId}`;

export function SeatPage() {
  const { showId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const { data: showData, error: showError } = useLoad(() => api.show(showId!), [showId]);
  const show = showData?.show;
  useTitle(show ? `Seats · ${show.movie.title}` : undefined);

  const [plan, setPlan] = useState<SeatMapData | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => {
    const saved = sessionStorage.getItem(pickKey(showId!));
    return new Set(saved ? (JSON.parse(saved) as string[]) : []);
  });
  const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: ReactNode } | null>(null);
  const [holding, setHolding] = useState(false);
  /** The signed-in user's own live hold on this show, if any */
  const [myHold, setMyHold] = useState<{ bookingId: string; seats: string[] } | null>(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    sessionStorage.setItem(pickKey(showId!), JSON.stringify([...selected]));
  }, [selected, showId]);

  // Live seat map: other people's holds and sales appear within ~2 s. The public map can't
  // say whose hold a seat is under, so a signed-in user's own live hold is fetched alongside.
  usePolling(async () => {
    const [map, mine] = await Promise.all([
      api.seatMap(showId!),
      user ? api.myBookings() : Promise.resolve(null),
    ]);
    setPlan(map);
    const live = mine?.bookings.find(
      (b) =>
        b.show.id === showId &&
        b.status === 'PENDING' &&
        !b.payment &&
        new Date(b.expiresAt).getTime() > Date.now(),
    );
    setMyHold(live ? { bookingId: live.id, seats: live.seats } : null);

    const status = new Map(map.seats.map((s) => [s.label, s.status]));
    const gone = [...selectedRef.current].filter((l) => status.get(l) !== 'AVAILABLE');
    if (gone.length > 0) {
      setSelected((prev) => new Set([...prev].filter((l) => !gone.includes(l))));
      setNotice({
        tone: 'info',
        text: `${gone.sort(seatOrder).join(', ')} ${gone.length === 1 ? 'was' : 'were'} just taken by someone else.`,
      });
    }
  }, POLL_MS);

  const seats = useMemo(
    () => new Map<string, SeatStatus>(plan?.seats.map((s) => [s.label, s.status]) ?? []),
    [plan],
  );
  const categoryOf = useMemo(
    () => new Map(plan?.seats.map((s) => [s.label, s.category]) ?? []),
    [plan],
  );
  const priceOf = useMemo(
    () => new Map(plan?.prices.map((p) => [p.category, p.price]) ?? []),
    [plan],
  );

  const toggle = (label: string) => {
    setNotice(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else if (next.size < MAX_SEATS) next.add(label);
      else setNotice({ tone: 'info', text: `You can book up to ${MAX_SEATS} seats at a time.` });
      return next;
    });
  };

  const picked = [...selected].sort(seatOrder);
  const total = picked.reduce((sum, l) => sum + (priceOf.get(categoryOf.get(l) ?? '') ?? 0), 0);
  const byCategory = picked.reduce<Record<string, string[]>>((acc, l) => {
    const c = categoryOf.get(l) ?? '';
    (acc[c] ??= []).push(l);
    return acc;
  }, {});

  const hold = async () => {
    if (!user) {
      navigate(`/signin?next=${encodeURIComponent(location.pathname)}`);
      return;
    }
    setHolding(true);
    setNotice(null);
    try {
      // A fresh key per attempt: a double-click is deduplicated by the server, a new try isn't
      const { bookingId } = await api.hold(showId!, picked, crypto.randomUUID());
      sessionStorage.removeItem(pickKey(showId!));
      navigate(`/checkout/${bookingId}`);
    } catch (err) {
      const e = err as ApiError;
      if (e.code === 'SEAT_UNAVAILABLE') {
        setNotice({
          tone: 'error',
          text: 'Someone else got one of those seats first. Pick again from the updated map.',
        });
        const map = await api.seatMap(showId!);
        setPlan(map);
        const free = new Set(map.seats.filter((s) => s.status === 'AVAILABLE').map((s) => s.label));
        setSelected((prev) => new Set([...prev].filter((l) => free.has(l))));
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
        setNotice({ tone: 'error', text: 'This show has already started, so it can’t be booked.' });
      } else if (e.code === 'RATE_LIMITED') {
        setNotice({ tone: 'error', text: 'Too many attempts. Wait a minute, then try again.' });
      } else {
        setNotice({ tone: 'error', text: e.message });
      }
    } finally {
      setHolding(false);
    }
  };

  if (showError) {
    return (
      <div className="mx-auto max-w-3xl px-4 pt-20">
        <EmptyState
          title="Show not found"
          action={<ButtonLink to="/movies">Browse movies</ButtonLink>}
        >
          This showtime doesn’t exist or is no longer listed.
        </EmptyState>
      </div>
    );
  }

  const started = show ? new Date(show.startsAt).getTime() <= Date.now() : false;

  return (
    <div className="pb-40">
      {/* What you're booking */}
      <div className="border-b border-line bg-night-2/50">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-5 sm:px-6">
          {show ? (
            <>
              <Poster
                url={show.movie.posterUrl}
                title={show.movie.title}
                size="w185"
                className="w-12 shrink-0 rounded-lg sm:w-14"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h1 className="font-display truncate text-2xl leading-tight font-extrabold tracking-wide uppercase sm:text-3xl">
                    {show.movie.title}
                  </h1>
                  <span className="text-dim">
                    <Certificate value={show.movie.certificate} />
                  </span>
                </div>
                <div className="mt-0.5 text-sm text-dim sm:truncate">
                  <span className="block truncate sm:inline">
                    {show.theatre.name}, {show.theatre.city} · {show.screen.name}
                  </span>
                  <span className="hidden sm:inline"> · </span>
                  <span className="text-screen">{formatWhen(show.startsAt)}</span>
                </div>
              </div>
              <Link
                to={`/movies/${show.movie.slug}#showtimes`}
                className="hidden shrink-0 rounded-full border border-line-2 px-4 py-2 text-sm text-dim hover:border-dim hover:text-screen sm:block"
              >
                Change showtime
              </Link>
            </>
          ) : (
            <Skeleton className="h-14 w-full max-w-md" />
          )}
        </div>
      </div>

      <div className="mx-auto max-w-7xl px-4 pt-8 sm:px-6">
        {started && (
          <Notice tone="error" className="mb-6">
            This show has already started, so it can’t be booked.
          </Notice>
        )}
        {myHold && (
          <Notice className="mb-6">
            You’re holding{' '}
            <span className="font-semibold text-screen">
              {[...myHold.seats].sort(seatOrder).join(', ')}
            </span>{' '}
            for this show.{' '}
            <Link
              to={`/checkout/${myHold.bookingId}`}
              className="font-semibold text-marigold-hi underline underline-offset-4"
            >
              Continue to payment
            </Link>
          </Notice>
        )}

        {plan ? (
          <div className="animate-fade space-y-6">
            <SeatMap
              rows={plan.layout.rows}
              priceOf={priceOf}
              seats={seats}
              selected={selected}
              mine={new Set(myHold?.seats)}
              onToggle={toggle}
            />
            <SeatLegend />
          </div>
        ) : (
          <Skeleton className="h-[420px] rounded-3xl" />
        )}
      </div>

      {/* The booking bar */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-night/90 backdrop-blur-xl">
        <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6">
          {notice && (
            <Notice tone={notice.tone} className="mb-3">
              {notice.text}
            </Notice>
          )}
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              {picked.length ? (
                <>
                  <div className="truncate text-sm text-dim">
                    {Object.entries(byCategory).map(([c, ls], i) => (
                      <span key={c}>
                        {i > 0 && <span className="text-faint"> · </span>}
                        {categoryName(c)}{' '}
                        <span className="font-mono font-semibold text-screen">{ls.join(', ')}</span>
                      </span>
                    ))}
                  </div>
                  <div className="font-display text-3xl leading-none font-black tracking-wide">
                    {formatMoney(total)}
                  </div>
                </>
              ) : (
                <div className="text-sm text-dim">
                  Tap seats to choose them · up to {MAX_SEATS}
                  {plan && (
                    <div className="mt-0.5 text-xs text-faint">
                      {plan.prices
                        .map((p) => `${categoryName(p.category)} ${formatMoney(p.price)}`)
                        .join('  ·  ')}
                    </div>
                  )}
                </div>
              )}
            </div>
            <Button
              onClick={hold}
              disabled={picked.length === 0 || holding || started || Boolean(myHold)}
              className="shrink-0 px-6 py-3 text-base"
            >
              {holding ? (
                <>
                  <Spinner /> Holding…
                </>
              ) : !user && picked.length ? (
                'Sign in to continue'
              ) : picked.length ? (
                `Hold ${picked.length} seat${picked.length > 1 ? 's' : ''}`
              ) : (
                'Select seats'
              )}
            </Button>
          </div>
          {picked.length > 0 && user && (
            <p className="mt-2 text-xs text-faint">
              Held seats are yours for 5 minutes while you pay. Nobody else can take them.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
