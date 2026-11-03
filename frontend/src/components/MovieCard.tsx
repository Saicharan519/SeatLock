import { Link } from 'react-router';
import type { MovieListItem } from '../lib/api';
import { formatMoney } from '../lib/format';
import { Poster } from './Poster';
import { Certificate, Rating, Skeleton } from './ui';

export function MovieCard({ movie, index = 0 }: { movie: MovieListItem; index?: number }) {
  return (
    <Link
      to={`/movies/${movie.slug}`}
      className="poster-card group block animate-rise"
      style={{ animationDelay: `${Math.min(index, 12) * 45}ms` }}
    >
      <div className="relative">
        <Poster url={movie.posterUrl} title={movie.title} />
        {movie.rating !== null && (
          <div className="absolute top-2 left-2 rounded-full bg-night/80 px-2 py-1 text-xs backdrop-blur">
            <Rating value={movie.rating} />
          </div>
        )}
        {/* On hover the poster dims and the call to action rises from the bottom */}
        <div className="absolute inset-0 flex items-end rounded-xl bg-gradient-to-t from-night via-night/30 to-transparent p-3 opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100">
          <span className="w-full rounded-full bg-marigold py-2 text-center text-sm font-semibold text-night">
            {movie.nowShowing ? 'Book tickets' : 'View details'}
          </span>
        </div>
      </div>
      <div className="mt-3 space-y-1">
        <h3 className="leading-snug font-semibold group-hover:text-marigold-hi">{movie.title}</h3>
        <div className="flex items-center gap-2 text-xs text-faint">
          <Certificate value={movie.certificate} />
          <span>{movie.language}</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">{movie.genres.slice(0, 2).join(', ')}</span>
        </div>
        <div className="text-xs">
          {movie.nowShowing && movie.minPrice !== null ? (
            <span className="text-dim">
              From <span className="font-semibold text-screen">{formatMoney(movie.minPrice)}</span>
            </span>
          ) : (
            <span className="text-faint">No shows in your city</span>
          )}
        </div>
      </div>
    </Link>
  );
}

export function MovieGridSkeleton({ count = 10 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <Skeleton className="aspect-[2/3] rounded-xl" />
          <Skeleton className="mt-3 h-4 w-3/4" />
          <Skeleton className="mt-2 h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}

export function MovieGrid({ movies }: { movies: MovieListItem[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
      {movies.map((m, i) => (
        <MovieCard key={m.id} movie={m} index={i} />
      ))}
    </div>
  );
}
