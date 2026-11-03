import { useEffect, useRef, useState } from 'react';

/** Re-renders every intervalMs; returns the current time in ms. */
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

/** Loads data once per key change, tracking loading and error. Stale responses are ignored. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  useEffect(() => {
    let current = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    load()
      .then((data) => current && setState({ data, error: null, loading: false }))
      .catch((e: Error) => current && setState({ data: null, error: e.message, loading: false }));
    return () => {
      current = false;
    };
  }, deps);
  return state;
}

/** Sets document.title while mounted. */
export function useTitle(title: string | undefined) {
  useEffect(() => {
    if (title) document.title = `${title} · SeatLock`;
  }, [title]);
}
