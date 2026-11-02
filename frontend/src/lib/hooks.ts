import { useEffect, useRef, useState } from 'react';

/** Re-renders every second; returns the current time in ms. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/**
 * Calls fn now and then every intervalMs while `active`, never overlapping calls.
 * Pauses while the tab is hidden, so a background tab doesn't keep polling.
 */
export function usePolling(fn: () => Promise<void>, intervalMs: number, active = true): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!document.hidden) await fnRef.current().catch(() => undefined);
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [intervalMs, active]);
}
