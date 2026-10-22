'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError } from './api';
import { clearToken, getToken, setToken, setUnauthorizedHandler } from './token';
import type { User } from './types';

type Status = 'loading' | 'authed' | 'anon' | 'unreachable';

interface AuthContextValue {
  status: Status;
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, teamName: string) => Promise<void>;
  logout: () => void;
  /** Try again after the API couldn't be reached. */
  retry: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);
  const [attempt, setAttempt] = useState(0);

  const signOut = useCallback(() => {
    clearToken();
    setUser(null);
    setStatus('anon');
  }, []);

  // Restore a saved session, checking with the server that it is still valid.
  useEffect(() => {
    const controller = new AbortController();
    const restore = async () => {
      if (!getToken()) {
        setStatus('anon');
        return;
      }
      try {
        const me = await api.me(controller.signal);
        setUser(me);
        setStatus('authed');
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        if (err instanceof ApiError && err.status === 0) setStatus('unreachable');
        else signOut();
      }
    };
    void restore();
    return () => controller.abort();
  }, [attempt, signOut]);

  // Any API call or the live stream hearing "401" signs the user out everywhere.
  useEffect(() => {
    setUnauthorizedHandler(signOut);
    return () => setUnauthorizedHandler(null);
  }, [signOut]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      login: async (email, password) => {
        const res = await api.login({ email, password });
        setToken(res.accessToken);
        setUser(res.user);
        setStatus('authed');
      },
      register: async (email, password, teamName) => {
        const res = await api.register({ email, password, teamName });
        setToken(res.accessToken);
        setUser(res.user);
        setStatus('authed');
      },
      logout: signOut,
      retry: () => {
        setStatus('loading');
        setAttempt((n) => n + 1);
      },
    }),
    [status, user, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
