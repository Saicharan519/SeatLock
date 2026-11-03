import { useState } from 'react';

/** TMDB serves each image at several widths; ask for the one the layout needs. */
export function tmdbSize(url: string | null, size: 'w185' | 'w342' | 'w500' | 'w780' | 'w1280') {
  return url?.replace(/\/t\/p\/w\d+\//, `/t/p/${size}/`) ?? null;
}

/**
 * A movie poster at 2:3. If there's no image, or it fails to load, a typographic poster
 * stands in: the title set in the marquee face over a warm gradient, so the grid never
 * shows a broken image.
 */
export function Poster({
  url,
  title,
  size = 'w342',
  className = '',
  eager = false,
}: {
  url: string | null;
  title: string;
  size?: 'w185' | 'w342' | 'w500';
  className?: string;
  eager?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const src = tmdbSize(url, size);
  return (
    <div
      className={`relative aspect-[2/3] overflow-hidden rounded-xl bg-night-3 ring-1 ring-white/5 ${className}`}
    >
      {src && !failed ? (
        <img
          src={src}
          alt={`${title} poster`}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-end bg-[radial-gradient(120%_80%_at_20%_0%,#5a3a1a,transparent_60%),linear-gradient(160deg,#2a211b,#0e0c0b)] p-3">
          <span className="font-display text-xl leading-none font-extrabold tracking-wide text-screen/90 uppercase">
            {title}
          </span>
        </div>
      )}
    </div>
  );
}
