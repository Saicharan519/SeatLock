import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setUnauthenticatedHandler, tokenStore, type User } from './api';

interface AuthState {
  user: User | null;
  /** True until the stored token has been checked */
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (name: string, email: string, password: string) => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

/**
 * Holds the signed-in user. The JWT lives in localStorage (simple, survives reloads; the
 * trade-off is that any XSS could read it, which an httpOnly cookie would prevent).
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const signOut = useCallback(() => {
    tokenStore.clear();
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthenticatedHandler(signOut);
    if (!tokenStore.get()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then(({ user }) => setUser(user))
      .catch(() => signOut())
      .finally(() => setLoading(false));
  }, [signOut]);

  const signIn = async (email: string, password: string) => {
    const { user, token } = await api.login(email, password);
    tokenStore.set(token);
    setUser(user);
  };
  const signUp = async (name: string, email: string, password: string) => {
    const { user, token } = await api.register(name, email, password);
    tokenStore.set(token);
    setUser(user);
  };

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
