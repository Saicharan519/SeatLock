import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { Button, Notice, Skeleton } from '../../components/ui';
import { api, ApiError, type AdminShow, type AdminTheatre } from '../../lib/api';
import {
  TIMEZONE,
  categoryName,
  dayParts,
  formatMoney,
  formatTime,
  todayIst,
} from '../../lib/format';
import { useLoad, useTitle } from '../../lib/hooks';
import { Field, Input, PageHeader, Panel, Select } from './kit';

/** Today and the next 13 days, as YYYY-MM-DD in IST. */
function nextDays(n = 14): string[] {
  const noon = new Date(`${todayIst()}T12:00:00+05:30`).getTime();
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE });
  return Array.from({ length: n }, (_, i) => fmt.format(new Date(noon + i * 86_400_000)));
}

/** Suggested price per seat, in rupees, for a new show */
const DEFAULT_RUPEES: Record<string, number> = { CLASSIC: 200, PRIME: 280, RECLINER: 450 };

function AddShowtime({
  theatre,
  date,
  onAdded,
}: {
  theatre: AdminTheatre;
  date: string;
  onAdded: (message: string) => void;
}) {
  const movies = useLoad(() => api.movies({}), []);
  const [movieId, setMovieId] = useState('');
  const [screenId, setScreenId] = useState(theatre.screens[0]?.id ?? '');
  const [day, setDay] = useState(date);
  const [time, setTime] = useState('18:30');
  const [rupees, setRupees] = useState<Record<string, string>>({});
  const [error, setError] = useState<{
    message: string;
    overlap: boolean;
    screen?: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  // The form is remounted per theatre (key); a new day picked above carries into it
  useEffect(() => setDay(date), [date]);
  // An error is about the slot that was tried: changing the slot clears it
  useEffect(() => setError(null), [screenId, day, time]);
  const screen = theatre.screens.find((s) => s.id === screenId);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!screen) return;
    setBusy(true);
    setError(null);
    try {
      const prices = Object.fromEntries(
        screen.categories.map((c) => [
          c,
          Math.round(Number(rupees[c] ?? DEFAULT_RUPEES[c] ?? 250) * 100),
        ]),
      );
      const { show } = await api.admin.createShow({
        movieId,
        screenId,
        // The admin types an IST wall-clock time
        startsAt: `${day}T${time}:00+05:30`,
        prices,
      });
      onAdded(`Scheduled ${show.movie.title} on ${screen.name} at ${formatTime(show.startsAt)}.`);
    } catch (err) {
      setError({
        message: (err as Error).message,
        overlap: err instanceof ApiError && err.code === 'SHOW_OVERLAP',
        screen: screen.name,
      });
    } finally {
      setBusy(false);
    }
  };

  if (theatre.screens.length === 0) {
    return (
      <Panel title="Add showtime">
        <p className="text-sm text-dim">This theatre has no screens yet.</p>
      </Panel>
    );
  }

  return (
    <Panel title="Add showtime">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Movie">
          <Select required value={movieId} onChange={(e) => setMovieId(e.target.value)}>
            <option value="" disabled>
              {movies.loading ? 'Loading…' : 'Choose a movie'}
            </option>
            {movies.data?.movies.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title} ({m.durationMinutes} min)
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Screen">
          <Select value={screenId} onChange={(e) => setScreenId(e.target.value)}>
            {theatre.screens.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.seatCount} seats
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <Input
              required
              type="date"
              min={todayIst()}
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </Field>
          <Field label="Starts (IST)">
            <Input required type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
        </div>
        {screen && (
          <fieldset>
            <legend className="mb-1 text-xs font-semibold text-dim">Price per seat (₹)</legend>
            <div className="grid grid-cols-2 gap-3">
              {screen.categories.map((c) => (
                <Field key={c} label={categoryName(c)}>
                  <Input
                    required
                    type="number"
                    min={1}
                    step={1}
                    value={rupees[c] ?? String(DEFAULT_RUPEES[c] ?? 250)}
                    onChange={(e) => setRupees((r) => ({ ...r, [c]: e.target.value }))}
                  />
                </Field>
              ))}
            </div>
          </fieldset>
        )}
        <p className="text-xs text-faint">
          The show ends after the movie’s running time plus a 15-minute changeover. The database
          refuses a show that overlaps another on the same screen.
        </p>
        {error && (
          <Notice tone="error">
            {error.overlap ? (
              <>
                <strong>Clash on {error.screen}.</strong> {error.message}. Pick another time or
                screen; the schedule on the left shows what’s already on.
              </>
            ) : (
              error.message
            )}
          </Notice>
        )}
        <Button type="submit" disabled={busy || !movieId} className="w-full">
          {busy ? 'Scheduling…' : 'Add showtime'}
        </Button>
      </form>
    </Panel>
  );
}

function ShowRow({ show, onDelete }: { show: AdminShow; onDelete: (s: AdminShow) => void }) {
  const past = new Date(show.startsAt).getTime() < Date.now();
  return (
    <li
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm ${past ? 'opacity-50' : ''}`}
    >
      <span className="w-36 font-mono text-xs whitespace-nowrap tabular-nums">
        {formatTime(show.startsAt)}–{formatTime(show.endsAt)}
      </span>
      <span className="min-w-0 flex-1 truncate font-semibold">{show.movie.title}</span>
      <span className="text-xs text-faint">
        {show.prices.map((p) => `${categoryName(p.category)} ${formatMoney(p.price)}`).join(' · ')}
      </span>
      <span className="w-24 text-right font-mono text-xs tabular-nums">
        {show.bookedSeats}/{show.totalSeats} sold
      </span>
      <button
        type="button"
        onClick={() => onDelete(show)}
        disabled={show.bookings > 0}
        title={
          show.bookings > 0
            ? 'Has bookings: kept, because bookings and payments point at it'
            : 'Delete this show'
        }
        className="text-xs font-semibold text-dim hover:text-bad disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-dim"
      >
        Delete
      </button>
    </li>
  );
}

export function Showtimes() {
  useTitle('Showtimes · Admin');
  const [params, setParams] = useSearchParams();
  const days = useMemo(() => nextDays(), []);
  const date = params.get('date') ?? days[0]!;
  const theatres = useLoad(() => api.admin.theatres(), []);
  const theatre =
    theatres.data?.theatres.find((t) => t.id === params.get('theatre')) ??
    theatres.data?.theatres[0];

  const [version, setVersion] = useState(0);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const schedule = useLoad(
    () => (theatre ? api.admin.shows(theatre.id, date) : Promise.resolve({ shows: [] })),
    [theatre?.id, date, version],
  );

  const choose = (key: 'theatre' | 'date', value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
    setMessage(null);
  };

  const remove = async (show: AdminShow) => {
    if (!confirm(`Delete ${show.movie.title} at ${formatTime(show.startsAt)}?`)) return;
    try {
      await api.admin.deleteShow(show.id);
      setMessage({
        tone: 'success',
        text: `Deleted ${show.movie.title} at ${formatTime(show.startsAt)}.`,
      });
      setVersion((v) => v + 1);
    } catch (err) {
      setMessage({ tone: 'error', text: (err as Error).message });
    }
  };

  const byScreen = new Map<string, AdminShow[]>();
  for (const s of schedule.data?.shows ?? []) {
    byScreen.set(s.screen.name, [...(byScreen.get(s.screen.name) ?? []), s]);
  }

  if (theatres.error) return <Notice tone="error">{theatres.error}</Notice>;

  return (
    <>
      <PageHeader title="Showtimes">
        One theatre, one day at a time. A show can be deleted until someone books it.
      </PageHeader>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select
          aria-label="Theatre"
          value={theatre?.id ?? ''}
          onChange={(e) => choose('theatre', e.target.value)}
          className="sm:max-w-sm"
        >
          {theatres.data?.theatres.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}, {t.city}
            </option>
          ))}
        </Select>
      </div>
      <div className="no-scrollbar mb-6 flex gap-2 overflow-x-auto pb-1" role="tablist">
        {days.map((d) => {
          const p = dayParts(d);
          const active = d === date;
          return (
            <button
              key={d}
              type="button"
              role="tab"
              aria-label={`${p.top} ${p.day} ${p.month}`}
              aria-selected={active}
              onClick={() => choose('date', d)}
              className={`flex w-14 shrink-0 flex-col items-center rounded-xl border py-1.5 transition-colors ${
                active
                  ? 'border-marigold bg-marigold/15 text-marigold-hi'
                  : 'border-line-2 text-dim hover:border-dim'
              }`}
            >
              <span className="text-[10px] uppercase">{p.top === 'Tomorrow' ? 'Tmrw' : p.top}</span>
              <span className="font-display text-xl font-bold">{p.day}</span>
              <span className="text-[10px] uppercase">{p.month}</span>
            </button>
          );
        })}
      </div>

      {message && (
        <Notice tone={message.tone} className="mb-4">
          {message.text}
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className={`space-y-4 transition-opacity ${schedule.loading ? 'opacity-50' : ''}`}>
          {(theatres.loading || (schedule.loading && !schedule.data)) && (
            <Skeleton className="h-64" />
          )}
          {schedule.error && <Notice tone="error">{schedule.error}</Notice>}
          {theatre && schedule.data && byScreen.size === 0 && (
            <Panel>
              <p className="py-6 text-center text-sm text-faint">Nothing scheduled this day.</p>
            </Panel>
          )}
          {[...byScreen].map(([screenName, shows]) => (
            <Panel key={screenName} title={screenName}>
              <ul className="-my-2.5 divide-y divide-line/60">
                {shows.map((s) => (
                  <ShowRow key={s.id} show={s} onDelete={remove} />
                ))}
              </ul>
            </Panel>
          ))}
        </div>
        {theatre && (
          <AddShowtime
            key={theatre.id}
            theatre={theatre}
            date={date}
            onAdded={(text) => {
              setMessage({ tone: 'success', text });
              setVersion((v) => v + 1);
            }}
          />
        )}
      </div>
    </>
  );
}
