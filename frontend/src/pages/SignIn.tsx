import { useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { Button, Notice } from '../components/ui';
import { ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';

const field =
  'w-full rounded-md border border-rule bg-card px-3 py-2.5 text-sm text-ink outline-none placeholder:text-ink-soft/60 focus:border-ink';

export function SignIn() {
  const { user, signIn, signUp } = useAuth();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={params.get('next') ?? '/'} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'signin') await signIn(email, password);
      else await signUp(name, email, password);
    } catch (err) {
      const e = err as ApiError;
      setError(
        e.code === 'EMAIL_TAKEN'
          ? 'An account with this email already exists. Sign in instead.'
          : e.code === 'VALIDATION_ERROR'
            ? 'Check the details: a valid email and a password of at least 8 characters.'
            : e.message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center px-5">
      <div className="w-full max-w-sm">
        <div className="font-display mb-1 text-3xl font-bold tracking-tight">
          Seat<span className="text-marigold-deep">Lock</span>
        </div>
        <p className="mb-8 text-sm text-ink-soft">
          Pick your seats. Nobody else can take them while you pay.
        </p>

        <form onSubmit={submit} className="space-y-4" noValidate>
          {mode === 'signup' && (
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Name</span>
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
            <span className="text-sm font-medium">Email</span>
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
            <span className="text-sm font-medium">Password</span>
            <input
              className={field}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              required
            />
          </label>
          {error && <Notice tone="error">{error}</Notice>}
          <Button type="submit" disabled={busy} className="w-full">
            {mode === 'signin' ? 'Sign in' : 'Create account'}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-ink-soft">
          {mode === 'signin' ? 'New here?' : 'Already have an account?'}{' '}
          <button
            className="font-medium text-ink underline underline-offset-4"
            onClick={() => {
              setMode(mode === 'signin' ? 'signup' : 'signin');
              setError(null);
            }}
          >
            {mode === 'signin' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
