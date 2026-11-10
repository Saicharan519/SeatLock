import { useEffect, useState } from 'react';
import { onWaking } from '../lib/api';
import { Spinner } from './ui';

/**
 * Shown while a request is unusually slow, which on free hosting almost always means the
 * backend was asleep and is starting up. Says so plainly instead of looking broken.
 */
export function WakeBanner() {
  const [waking, setWaking] = useState(false);
  useEffect(() => onWaking(setWaking), []);
  if (!waking) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-50 flex animate-fade items-center justify-center gap-3 bg-marigold px-4 py-2 text-center text-sm font-semibold text-night"
    >
      <Spinner />
      Waking up the server. It sleeps when nobody is using it (free hosting); this takes up to a
      minute.
    </div>
  );
}
