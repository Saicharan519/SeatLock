import { Link, useParams, useSearchParams } from 'react-router';
import { Poster, tmdbSize } from '../components/Poster';
import {
  ButtonLink,
  Certificate,
  EmptyState,
  Eyebrow,
  Notice,
  Rating,
  Skeleton,
} from '../components/ui';
import { api, type MovieDetail, type Showtime } from '../lib/api';
import { useCity } from '../lib/city';
import { categoryName, dayParts, formatDuration, formatMoney, formatTime } from '../lib/format';
import { useLoad, useTitle } from '../lib/hooks';

/** How full a show is, in the words (and colours) a customer expects. */
function availability(s: Showtime) {
  const ratio = s.availableSeats / s.totalSeats;
  if (s.availableSeats === 0) return { label: 'Sold out', dot: 'bg-faint', text: 'text-faint' };
  if (ratio <= 0.2) return { label: 'Almost full', dot: 'bg-bad', text: 'text-bad' };
  if (ratio <= 0.5) return { label: 'Filling fast', dot: 'bg-warn', text: 'text-warn' };
  return { label: 'Available', dot: 'bg-ok', text: 'text-ok' };
}

function Header({ movie }: { movie: MovieDetail }) {
  const backdrop = tmdbSize(movie.backdropUrl, 'w1280') ?? tmdbSize(movie.posterUrl, 'w780');
  const year = movie.releaseDate.slice(0, 4);
  return (
    <section className="relative isolate overflow-hidden">
      {backdrop && (
        <img
          src={backdrop}
          alt=""
          aria-hidden="true"
          className={`absolute inset-0 -z-10 h-full w-full object-cover object-[center_20%] ${
            movie.backdropUrl ? 'opacity-45' : 'scale-110 opacity-30 blur-2xl'
          }`}
        />
      )}
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-night via-night/70 to-night/30" />
      <div className="mx-auto grid max-w-7xl gap-8 px-4 pt-12 pb-12 sm:grid-cols-[220px_1fr] sm:px-6 sm:pt-20 md:grid-cols-[260px_1fr] md:gap-12">
        <Poster
          url={movie.posterUrl}
          title={movie.title}
          size="w500"
          eager
          className="mx-auto w-48 animate-rise shadow-2xl shadow-black/70 sm:mx-0 sm:w-full"
        />
        <div className="animate-rise self-end [animation-delay:80ms]">
          <div className="flex flex-wrap gap-2">
            {movie.genres.map((g) => (
              <Link
                key={g}
                to={`/movies?genre=${encodeURIComponent(g)}`}
                className="rounded-full border border-screen/20 px-3 py-1 text-xs font-semibold text-dim hover:border-marigold hover:text-marigold-hi"
              >
                {g}
              </Link>
            ))}
          </div>
          <h1 className="font-display mt-4 text-5xl leading-[0.9] font-black tracking-wide uppercase sm:text-7xl">
            {movie.title}
          </h1>
          <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-dim">
            <Rating value={movie.rating} className="text-base text-screen" />
            <Certificate value={movie.certificate} />
            <span>{formatDuration(movie.durationMinutes)}</span>
            <span aria-hidden="true">·</span>
            <span>{movie.language}</span>
            <span aria-hidden="true">·</span>
            <span>{year}</span>
          </div>
          <p className="mt-6 max-w-2xl text-base leading-relaxed text-screen/85">
            {movie.synopsis}
          </p>
          <dl className="mt-6 grid max-w-2xl gap-4 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-6 sm:gap-y-3">
            {movie.director && (
              <>
                <dt className="text-faint">Director</dt>
                <dd>{movie.director}</dd>
              </>
            )}
            {movie.cast.length > 0 && (
              <>
                <dt className="text-faint">Cast</dt>
                <dd>{movie.cast.join(', ')}</dd>
              </>
            )}
          </dl>
          <a
            href="#showtimes"
            className="mt-8 inline-flex rounded-full bg-marigold px-7 py-3 font-semibold text-night shadow-[0_8px_30px_-8px_rgb(242_169_59/0.6)] hover:bg-marigold-hi"
          >
            Book tickets
          </a>
        </div>
      </div>
    </section>
  );
}

function ShowtimeButton({ show }: { show: Showtime }) {
  const a = availability(show);
  const soldOut = show.availableSeats === 0;
  const prices = show.prices.map((p) => `${categoryName(p.category)} ${formatMoney(p.price)}`);
  const inner = (
    <>
      <span className="font-mono text-base font-semibold tabular-nums">
        {formatTime(show.startsAt)}
      </span>
      <span className="flex items-center gap-1.5 text-[11px] text-faint">
        <span className={`h-1.5 w-1.5 rounded-full ${a.dot}`} aria-hidden="true" />
        {show.screen.name}
      </span>
      {/* Prices appear on hover, like the tooltip on a real box-office site */}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden w-max -translate-x-1/2 rounded-lg border border-line-2 bg-night-3 px-3 py-2 text-left text-xs text-dim shadow-xl group-hover:block group-focus-visible:block"
      >
        {prices.map((p) => (
          <span key={p} className="block whitespace-nowrap">
            {p}
          </span>
        ))}
        <span className={`mt-1 block font-semibold ${a.text}`}>
          {a.label} · {show.availableSeats} of {show.totalSeats} left
        </span>
      </span>
    </>
  );
  const cls =
    'group relative flex min-w-[104px] flex-col items-center gap-0.5 rounded-xl border px-4 py-2.5 transition-colors';
  if (soldOut) {
    return (
      <span
        className={`${cls} cursor-not-allowed border-line text-faint line-through`}
        aria-disabled="true"
      >
        {inner}
      </span>
    );
  }
  return (
    <Link
      to={`/shows/${show.id}`}
      className={`${cls} border-line-2 hover:border-marigold hover:bg-marigold/10`}
      aria-label={`${formatTime(show.startsAt)}, ${show.screen.name}, ${a.label}, ${show.availableSeats} seats left`}
    >
      {inner}
    </Link>
  );
}

function Showtimes({ slug }: { slug: string }) {
  const { city, cities, setCity } = useCity();
  const [params, setParams] = useSearchParams();
  const date = params.get('date') ?? undefined;
  const { data, error, loading } = useLoad(
    () => api.showtimes(slug, { city, date }),
    [slug, city, date],
  );

  const pick = (d: string) => {
    const next = new URLSearchParams(params);
    next.set('date', d);
    setParams(next, { replace: true });
  };

  return (
    <section id="showtimes" className="mx-auto max-w-7xl scroll-mt-24 px-4 pt-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Eyebrow>{city}</Eyebrow>
          <h2 className="font-display mt-1 text-4xl font-extrabold tracking-wide uppercase">
            Showtimes
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs text-faint">
          {[
            ['bg-ok', 'Available'],
            ['bg-warn', 'Filling fast'],
            ['bg-bad', 'Almost full'],
          ].map(([dot, label]) => (
            <span key={label} className="flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
              {label}
            </span>
          ))}
        </div>
      </div>

      {data && data.dates.length > 0 && (
        <div
          className="no-scrollbar mt-6 flex gap-2 overflow-x-auto pb-1"
          role="tablist"
          aria-label="Date"
        >
          {data.dates.map((d) => {
            const p = dayParts(d);
            const active = d === data.date;
            return (
              <button
                key={d}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => pick(d)}
                className={`flex w-16 shrink-0 flex-col items-center rounded-xl border py-2.5 transition-colors ${
                  active
                    ? 'border-marigold bg-marigold text-night'
                    : 'border-line-2 text-dim hover:border-dim hover:text-screen'
                }`}
              >
                <span className="text-[10px] font-semibold tracking-wider uppercase">{p.top}</span>
                <span className="font-display text-2xl leading-tight font-black">{p.day}</span>
                <span className="text-[10px] tracking-wider uppercase">{p.month}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-8 space-y-4">
        {error && <Notice tone="error">{error}</Notice>}
        {loading &&
          !data &&
          [0, 1, 2].map((i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
        {data && data.theatres.length === 0 && (
          <EmptyState
            title={`No shows in ${city}`}
            action={
              cities.length > 1 && (
                <div className="flex flex-wrap justify-center gap-2">
                  {cities
                    .filter((c) => c.city !== city)
                    .map((c) => (
                      <button
                        key={c.city}
                        type="button"
                        onClick={() => setCity(c.city)}
                        className="rounded-full border border-line-2 px-4 py-1.5 text-sm text-dim hover:border-marigold hover:text-marigold-hi"
                      >
                        Try {c.city}
                      </button>
                    ))}
                </div>
              )
            }
          >
            This film isn’t scheduled in {city} in the next few days.
          </EmptyState>
        )}
        {data?.theatres.map(({ theatre, shows }, i) => (
          <div
            key={theatre.id}
            className="animate-rise rounded-2xl border border-line bg-night-2/60 p-5 sm:flex sm:gap-8 sm:p-6"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <div className="mb-4 sm:mb-0 sm:w-64 sm:shrink-0">
              <div className="font-semibold">{theatre.name}</div>
              <div className="mt-0.5 text-xs text-faint">{theatre.address}</div>
            </div>
            <div className="flex flex-wrap gap-3">
              {shows.map((s) => (
                <ShowtimeButton key={s.id} show={s} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function MoviePage() {
  const { slug } = useParams();
  const { data, error } = useLoad(() => api.movie(slug!), [slug]);
  useTitle(data?.movie.title);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl px-4 pt-20">
        <EmptyState
          title="Film not found"
          action={<ButtonLink to="/movies">Browse movies</ButtonLink>}
        >
          This film doesn’t exist, or its link has changed.
        </EmptyState>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="mx-auto grid max-w-7xl gap-10 px-4 pt-16 sm:grid-cols-[260px_1fr] sm:px-6">
        <Skeleton className="aspect-[2/3] rounded-xl" />
        <div className="space-y-4 self-end">
          <Skeleton className="h-16 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }
  return (
    <div>
      <Header movie={data.movie} />
      <Showtimes slug={data.movie.slug} />
    </div>
  );
}
