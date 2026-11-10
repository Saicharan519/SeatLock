import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, setUnauthenticatedHandler, type User } from './api';

interface AuthState {
  user: User | null;
  /** True until the session has been checked */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Holds the signed-in user. The session itself is an httpOnly cookie set by the API, which
 * page scripts can't read; on load, asking /auth/me is how the page finds out whether that
 * cookie is (still) valid.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // The API says the session is gone (expired after an hour, or signed out elsewhere)
    setUnauthenticatedHandler(() => setUser(null));
    api
      .me()
      .then(({ user }) => setUser(user))
      .catch((err) => {
        // 401 just means "not signed in"; anything else (backend asleep) also leaves you
        // signed out for now, and the next action will try again
        if (!(err instanceof ApiError)) console.error(err);
      })
      .finally(() => setLoading(false));
  }, []);

  const signIn = async (email: string, password: string) => {
    setUser((await api.login(email, password)).user);
  };
  const signUp = async (name: string, email: string, password: string) => {
    setUser((await api.register(name, email, password)).user);
  };
  /** Only the API can delete an httpOnly cookie, so signing out is a request */
  const signOut = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
