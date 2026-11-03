import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { MovieGrid, MovieGridSkeleton } from '../components/MovieCard';
import { tmdbSize } from '../components/Poster';
import { ButtonLink, Certificate, EmptyState, Eyebrow, Notice, Rating } from '../components/ui';
import { api, type MovieListItem } from '../lib/api';
import { useCity } from '../lib/city';
import { formatDuration, formatMoney } from '../lib/format';
import { useLoad, useTitle } from '../lib/hooks';

const ROTATE_MS = 7000;

/** Full-bleed backdrop of the best-rated films showing in the city, rotating. */
function Hero({ movies, city }: { movies: MovieListItem[]; city: string }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    setIndex(0);
  }, [movies]);
  useEffect(() => {
    if (paused || movies.length < 2) return;
    const t = setTimeout(() => setIndex((i) => (i + 1) % movies.length), ROTATE_MS);
    return () => clearTimeout(t);
  }, [index, paused, movies.length]);

  const m = movies[index];
  if (!m) return null;

  return (
    <section
      className="relative isolate overflow-hidden"
      aria-roledescription="carousel"
      aria-label="Featured films"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {movies.map((f, i) => (
        <img
          key={f.id}
          src={tmdbSize(f.backdropUrl, 'w1280')!}
          alt=""
          aria-hidden="true"
          className={`absolute inset-0 -z-10 h-full w-full object-cover object-[center_25%] transition-opacity duration-1000 ${
            i === index ? 'opacity-100' : 'opacity-0'
          }`}
        />
      ))}
      {/* Fade into the auditorium: from the left for the text, from below into the page */}
      <div className="absolute inset-0 -z-10 bg-gradient-to-r from-night via-night/75 to-night/10" />
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-night via-transparent to-night/40" />

      <div className="mx-auto flex min-h-[460px] max-w-7xl flex-col justify-end px-4 pt-24 pb-14 sm:min-h-[560px] sm:px-6">
        <div key={m.id} className="max-w-2xl animate-rise">
          <Eyebrow className="text-marigold">Now showing in {city}</Eyebrow>
          <h1 className="font-display mt-3 text-6xl leading-[0.85] font-black tracking-wide uppercase drop-shadow-[0_4px_30px_rgb(0_0_0/0.6)] sm:text-8xl">
            {m.title}
          </h1>
          <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-dim">
            <Rating value={m.rating} className="text-screen" />
            <Certificate value={m.certificate} />
            <span>{formatDuration(m.durationMinutes)}</span>
            <span aria-hidden="true">·</span>
            <span>{m.genres.join(', ')}</span>
            <span aria-hidden="true">·</span>
            <span>{m.language}</span>
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <ButtonLink to={`/movies/${m.slug}`} className="px-7 py-3 text-base">
              Book tickets
            </ButtonLink>
            {m.minPrice !== null && (
              <span className="text-sm text-dim">
                {m.showCount} shows · from{' '}
                <span className="font-semibold text-screen">{formatMoney(m.minPrice)}</span>
              </span>
            )}
          </div>
        </div>

        {movies.length > 1 && (
          <div className="mt-10 flex gap-2" role="tablist" aria-label="Choose a featured film">
            {movies.map((f, i) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={i === index}
                aria-label={f.title}
                onClick={() => setIndex(i)}
                className="group h-6 py-2.5"
              >
                <span
                  className={`block h-1 rounded-full transition-all duration-500 ${
                    i === index ? 'w-10 bg-marigold' : 'w-5 bg-screen/30 group-hover:bg-screen/60'
                  }`}
                />
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

const STEPS = [
  ['Pick a showtime', 'Every theatre and time in your city, with live seats left.'],
  [
    'Hold your seats',
    'The seats you choose are locked to you for 5 minutes. Nobody else can take them.',
  ],
  [
    'Pay and you’re in',
    'Your ticket appears the moment the payment is confirmed, even if you close the tab.',
  ],
];

export function Home() {
  const { city } = useCity();
  useTitle('Movie tickets');
  const { data, error, loading } = useLoad(() => api.movies({ city }), [city]);

  const showing = data?.movies.filter((m) => m.nowShowing) ?? [];
  const elsewhere = data?.movies.filter((m) => !m.nowShowing) ?? [];
  const featured = showing.filter((m) => m.backdropUrl).slice(0, 5);
  const languages = [...new Set(showing.map((m) => m.language))];

  return (
    <div>
      {featured.length > 0 ? (
        <Hero movies={featured} city={city} />
      ) : (
        <div className="h-[420px] animate-pulse bg-night-2" aria-hidden="true" />
      )}
      <div className="bulbs mx-auto max-w-7xl" aria-hidden="true" />

      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <section className="mt-14" aria-labelledby="now-showing">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <Eyebrow>{city}</Eyebrow>
              <h2
                id="now-showing"
                className="font-display mt-1 text-4xl font-extrabold tracking-wide uppercase sm:text-5xl"
              >
                Now showing
              </h2>
            </div>
            {languages.length > 1 && (
              <div className="flex flex-wrap gap-2">
                {languages.map((l) => (
                  <Link
                    key={l}
                    to={`/movies?language=${encodeURIComponent(l)}`}
                    className="rounded-full border border-line-2 px-3.5 py-1.5 text-xs font-semibold text-dim transition-colors hover:border-marigold hover:text-marigold-hi"
                  >
                    {l}
                  </Link>
                ))}
              </div>
            )}
          </div>
          {error && <Notice tone="error">{error}</Notice>}
          {loading && !data && <MovieGridSkeleton />}
          {data && showing.length === 0 && (
            <EmptyState title={`Nothing in ${city} yet`}>
              No shows are scheduled here right now. Try another city from the menu at the top.
            </EmptyState>
          )}
          {showing.length > 0 && <MovieGrid movies={showing} />}
        </section>

        <section className="mt-24 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-3">
          {STEPS.map(([title, text], i) => (
            <div key={title} className="bg-night-2 p-7">
              <div className="font-display text-5xl font-black text-marigold/80">0{i + 1}</div>
              <div className="mt-3 text-lg font-semibold">{title}</div>
              <p className="mt-1 text-sm leading-relaxed text-dim">{text}</p>
            </div>
          ))}
        </section>

        {elsewhere.length > 0 && (
          <section className="mt-24" aria-labelledby="elsewhere">
            <Eyebrow>Not in {city} right now</Eyebrow>
            <h2
              id="elsewhere"
              className="font-display mt-1 mb-8 text-4xl font-extrabold tracking-wide uppercase"
            >
              Showing in other cities
            </h2>
            <MovieGrid movies={elsewhere} />
          </section>
        )}
      </div>
    </div>
  );
}
