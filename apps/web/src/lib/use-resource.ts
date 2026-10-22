'use client';

import { useCallback, useEffect, useState } from 'react';

interface Loaded<T> {
  key: string;
  data: T | null;
  error: string | null;
}

/**
 * Loads data when `key` changes (and whenever `reload()` is called).
 *
 *  - `data` is null while loading, and also right after the key changes, so a page never
 *    shows the previous filter's results under a new filter.
 *  - If a reload fails, the data already on screen is kept and `error` is set.
 *  - `fetcher` must be stable (wrap it in useCallback), and a response that arrives after the
 *    key changed or the component unmounted is ignored.
 */
export function useResource<T>(key: string, fetcher: () => Promise<T>) {
  const [state, setState] = useState<Loaded<T>>({ key, data: null, error: null });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetcher().then(
      (data) => {
        if (!cancelled) setState({ key, data, error: null });
      },
      (err: unknown) => {
        if (cancelled) return;
        const error = err instanceof Error ? err.message : 'Something went wrong';
        setState((prev) => ({ key, data: prev.key === key ? prev.data : null, error }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, fetcher, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const current = state.key === key;
  return { data: current ? state.data : null, error: current ? state.error : null, reload };
}
