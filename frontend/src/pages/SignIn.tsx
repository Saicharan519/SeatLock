import { useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { Logo } from '../components/Layout';
import { tmdbSize } from '../components/Poster';
import { Button, Notice, Spinner } from '../components/ui';
import { WakeBanner } from '../components/WakeBanner';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useLoad, useTitle } from '../lib/hooks';

/**
 * A shared account for visitors (set at build time on the hosted site). Not a secret: it is
 * a normal USER account, shown to anyone who opens the sign-in page.
 */
const DEMO =
  import.meta.env.VITE_DEMO_EMAIL && import.meta.env.VITE_DEMO_PASSWORD
    ? { email: import.meta.env.VITE_DEMO_EMAIL, password: import.meta.env.VITE_DEMO_PASSWORD }
    : null;

const field =
  'w-full rounded-xl border border-line-2 bg-night-2 px-4 py-3 text-sm text-screen outline-none transition-colors placeholder:text-faint focus:border-marigold';

/** A slowly drifting wall of posters behind the form. */
function PosterWall() {
  const { data } = useLoad(() => api.movies({}), []);
  const posters = (data?.movies ?? [])
    .map((m) => tmdbSize(m.posterUrl, 'w185'))
    .filter(Boolean) as string[];
  if (posters.length === 0) return null;
  const wall = [...posters, ...posters, ...posters].slice(0, 36);
  return (
    <div className="absolute inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <div className="grid -rotate-6 scale-125 grid-cols-4 gap-3 opacity-40 sm:grid-cols-6">
        {wall.map((src, i) => (
          <img
            key={i}
            src={src}
            alt=""
            className="aspect-[2/3] w-full rounded-lg object-cover"
            loading="lazy"
          />
        ))}
      </div>
      <div className="absolute inset-0 bg-gradient-to-r from-night via-night/90 to-night/50" />
      <div className="absolute inset-0 bg-gradient-to-t from-night via-transparent to-night/60" />
    </div>
  );
}

export function SignIn() {
  const { user, signIn, signUp } = useAuth();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<'signin' | 'signup'>(
    params.get('mode') === 'signup' ? 'signup' : 'signin',
  );
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useTitle(mode === 'signin' ? 'Sign in' : 'Create account');

  const next = params.get('next');
  // Only same-site paths, so a crafted link can't bounce someone to another site after sign-in.
  // "//evil.com" and "/\evil.com" both mean another host to a browser.
  const safeNext = next && /^\/(?![/\\])/.test(next) ? next : '/';
  if (user) return <Navigate to={safeNext} replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    return attempt(() =>
      mode === 'signin' ? signIn(email, password) : signUp(name, email, password),
    );
  };

  const attempt = async (action: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (err) {
      const e = err as ApiError;
      setError(
        e.code === 'EMAIL_TAKEN'
          ? 'An account with this email already exists. Sign in instead.'
          : e.code === 'VALIDATION_ERROR'
            ? 'Check the details: a valid email and a password of at least 8 characters.'
            : e.code === 'UNAUTHENTICATED'
              ? 'That email and password don’t match.'
              : e.code === 'RATE_LIMITED'
                ? 'Too many attempts. Wait a minute, then try again.'
                : e.message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grain relative isolate flex min-h-screen flex-col">
      <WakeBanner />
      <PosterWall />
      <div className="px-6 py-6 sm:px-10">
        <Logo />
      </div>
      <div className="flex flex-1 items-center px-6 pb-16 sm:px-10">
        <div className="w-full max-w-sm animate-rise">
          <h1 className="font-display text-6xl leading-[0.85] font-black tracking-wide uppercase">
            {mode === 'signin' ? (
              <>
                Welcome
                <br />
                back
              </>
            ) : (
              <>
                Grab
                <br />a seat
              </>
            )}
          </h1>
          <p className="mt-4 mb-8 text-dim">
            {next?.startsWith('/shows/')
              ? 'Sign in to hold your seats. Your picks are saved.'
              : 'Pick your seats. Nobody else can take them while you pay.'}
          </p>

          {DEMO && (
            <div className="mb-6 rounded-2xl border border-marigold/40 bg-marigold/5 p-4">
              <div className="text-sm font-semibold">Just looking around?</div>
              <p className="mt-1 text-xs text-dim">
                Use the shared demo account: no sign-up, test payments only.
              </p>
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={() => attempt(() => signIn(DEMO.email, DEMO.password))}
                className="mt-3 w-full"
              >
                Continue with the demo account
              </Button>
            </div>
          )}

          <form onSubmit={submit} className="space-y-4" noValidate>
            {mode === 'signup' && (
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-dim">Name</span>
                <input
                  className={field}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  required
                />
              </label>
            )}
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-dim">Email</span>
              <input
                className={field}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-dim">Password</span>
              <input
                className={field}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                minLength={8}
                required
              />
              {mode === 'signup' && (
                <span className="text-xs text-faint">At least 8 characters</span>
              )}
            </label>
            {error && <Notice tone="error">{error}</Notice>}
            <Button type="submit" disabled={busy} className="w-full py-3 text-base">
              {busy && <Spinner />}
              {mode === 'signin' ? 'Sign in' : 'Create account'}
            </Button>
          </form>

          <p className="mt-6 text-sm text-dim">
            {mode === 'signin' ? 'New here? ' : 'Already have an account? '}
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'signin' ? 'signup' : 'signin');
                setError(null);
              }}
              className="font-semibold text-marigold-hi underline-offset-4 hover:underline"
            >
              {mode === 'signin' ? 'Create an account' : 'Sign in'}
            </button>
          </p>
          <p className="mt-10 text-xs text-faint">
            <Link to="/" className="hover:text-dim">
              ← Keep browsing without signing in
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
