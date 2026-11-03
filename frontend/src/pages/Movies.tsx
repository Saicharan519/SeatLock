import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { MovieGrid, MovieGridSkeleton } from '../components/MovieCard';
import { Chip, EmptyState, Eyebrow, Notice } from '../components/ui';
import { api } from '../lib/api';
import { useCity } from '../lib/city';
import { useLoad, useTitle } from '../lib/hooks';

/**
 * Every film, with search and filters. Filters live in the URL (?genre=Action&q=dune),
 * so a filtered list can be bookmarked, shared, and survives a reload.
 */
export function Movies() {
  const { city } = useCity();
  useTitle('Movies');
  const [params, setParams] = useSearchParams();
  const genre = params.get('genre') ?? undefined;
  const language = params.get('language') ?? undefined;
  const q = params.get('q') ?? '';
  const [search, setSearch] = useState(q);

  // Search as you type, a moment after the last keystroke
  useEffect(() => {
    const t = setTimeout(() => {
      if (search.trim() !== q) update('q', search.trim() || undefined);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, error, loading } = useLoad(
    () => api.movies({ city, genre, language, q: q || undefined }),
    [city, genre, language, q],
  );

  function update(key: string, value: string | undefined) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }

  const showing = data?.movies.filter((m) => m.nowShowing) ?? [];
  const rest = data?.movies.filter((m) => !m.nowShowing) ?? [];
  const filtered = Boolean(genre || language || q);

  return (
    <div className="mx-auto max-w-7xl px-4 pt-12 sm:px-6">
      <Eyebrow>{city}</Eyebrow>
      <h1 className="font-display mt-1 text-5xl font-black tracking-wide uppercase sm:text-6xl">
        Movies
      </h1>

      <div className="mt-8 space-y-4">
        <label className="relative block max-w-xl">
          <span className="sr-only">Search films</span>
          <svg
            viewBox="0 0 20 20"
            className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 fill-faint"
            aria-hidden="true"
          >
            <path d="M8.5 2a6.5 6.5 0 0 1 5.2 10.4l4 4-1.4 1.4-4-4A6.5 6.5 0 1 1 8.5 2zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z" />
          </svg>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search films"
            className="w-full rounded-full border border-line-2 bg-night-2 py-3 pr-4 pl-11 text-sm text-screen placeholder:text-faint focus:border-marigold focus:outline-none"
          />
        </label>

        {data && (
          <div className="space-y-3">
            <div className="no-scrollbar flex gap-2 overflow-x-auto" aria-label="Genre">
              <Chip active={!genre} onClick={() => update('genre', undefined)}>
                All genres
              </Chip>
              {data.facets.genres.map((g) => (
                <Chip
                  key={g}
                  active={genre === g}
                  onClick={() => update('genre', genre === g ? undefined : g)}
                >
                  {g}
                </Chip>
              ))}
            </div>
            <div className="no-scrollbar flex gap-2 overflow-x-auto" aria-label="Language">
              <Chip active={!language} onClick={() => update('language', undefined)}>
                All languages
              </Chip>
              {data.facets.languages.map((l) => (
                <Chip
                  key={l}
                  active={language === l}
                  onClick={() => update('language', language === l ? undefined : l)}
                >
                  {l}
                </Chip>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mt-10">
        {error && <Notice tone="error">{error}</Notice>}
        {loading && !data && <MovieGridSkeleton />}
        {data && data.movies.length === 0 && (
          <EmptyState title="No films match">
            {filtered ? 'Try fewer filters or a different search.' : 'There are no films yet.'}
          </EmptyState>
        )}
        {showing.length > 0 && (
          <section aria-label={`Showing in ${city}`}>
            <div className="mb-5 text-sm text-dim">
              <span className="font-semibold text-screen">{showing.length}</span> showing in {city}
            </div>
            <MovieGrid movies={showing} />
          </section>
        )}
        {rest.length > 0 && (
          <section className="mt-16" aria-label="Not showing in your city">
            <div className="mb-5 text-sm text-dim">Not showing in {city}</div>
            <MovieGrid movies={rest} />
          </section>
        )}
      </div>
    </div>
  );
}
