'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError } from './api';
import { API_URL } from './config';
import { initialState, reducer, type DataState } from './live-state';
import { connectStream } from './sse';
import { getToken } from './token';
import type { ConnectionState, LiveEvent } from './types';

const EVENT_TYPES = new Set([
  'check',
  'incident.opened',
  'incident.resolved',
  'endpoint.upserted',
  'endpoint.deleted',
]);
const FULL_REFRESH_MS = 5 * 60_000;

interface DataContextValue extends DataState {
  connection: ConnectionState;
  /** Reload everything from the API. */
  refresh: () => Promise<void>;
  /** Receive every live event as it arrives. Returns an unsubscribe function. */
  subscribe: (listener: (event: LiveEvent) => void) => () => void;
}

const DataContext = createContext<DataContextValue | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const listeners = useRef(new Set<(event: LiveEvent) => void>());
  const hasOpenedBefore = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const [endpoints, overview, open] = await Promise.all([
        api.listEndpoints(),
        api.overview(),
        api.listIncidents({ status: 'open', limit: 200 }),
      ]);
      dispatch({ type: 'loaded', endpoints, stats: overview.endpoints, openIncidents: open });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return; // the auth layer handles sign-out
      dispatch({
        type: 'failed',
        error: err instanceof Error ? err.message : 'Something went wrong',
      });
    }
  }, []);

  // First load, plus a slow full refresh as a safety net against any missed live event.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), FULL_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // The live stream.
  useEffect(() => {
    const stream = connectStream({
      url: `${API_URL}/stream`,
      getToken,
      onOpen: () => {
        setConnection('live');
        // After a drop, events may have been missed: re-sync from the API.
        if (hasOpenedBefore.current) void refresh();
        hasOpenedBefore.current = true;
      },
      onClose: () => setConnection('offline'),
      onMessage: ({ event, data }) => {
        if (!EVENT_TYPES.has(event)) return; // ready, ping, ...
        const live = { type: event, data } as LiveEvent;
        dispatch({ type: 'event', event: live });
        listeners.current.forEach((listener) => listener(live));
      },
    });
    return () => stream.close();
  }, [refresh]);

  const subscribe = useCallback((listener: (event: LiveEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const value = useMemo<DataContextValue>(
    () => ({ ...state, connection, refresh, subscribe }),
    [state, connection, refresh, subscribe],
  );
  return <DataContext.Provider value={value}>{children}</DataContext.Provider>;
}

export function useData(): DataContextValue {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useData must be used inside <DataProvider>');
  return ctx;
}
