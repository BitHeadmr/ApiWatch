import type { Endpoint, EndpointStats, Incident, LiveEvent, RecentCheck } from './types';

export const RECENT_LIMIT = 30;

export interface DataState {
  loaded: boolean;
  error: string | null;
  endpoints: Record<string, Endpoint>;
  stats: Record<string, EndpointStats>;
  openIncidents: Record<string, Incident>;
}

export const initialState: DataState = {
  loaded: false,
  error: null,
  endpoints: {},
  stats: {},
  openIncidents: {},
};

export type Action =
  | {
      type: 'loaded';
      endpoints: Endpoint[];
      stats: Record<string, EndpointStats>;
      openIncidents: Incident[];
    }
  | { type: 'failed'; error: string }
  | { type: 'event'; event: LiveEvent };

const emptyStats = (): EndpointStats => ({
  checks24h: 0,
  uptime24h: null,
  recent: [],
  recentAvgResponseMs: null,
});

/** A copy of the record without one key. */
const omit = <T>(record: Record<string, T>, key: string): Record<string, T> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

const byId = <T extends { id: string }>(items: T[]) =>
  Object.fromEntries(items.map((i) => [i.id, i]));

function recentAverage(recent: RecentCheck[]): number | null {
  const times = recent.filter((r) => r.ok && r.ms !== null).map((r) => r.ms as number);
  return times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null;
}

export function reducer(state: DataState, action: Action): DataState {
  switch (action.type) {
    case 'loaded': {
      const endpoints = byId(action.endpoints);
      const stats: Record<string, EndpointStats> = {};
      for (const id of Object.keys(endpoints)) stats[id] = action.stats[id] ?? emptyStats();
      return {
        loaded: true,
        error: null,
        endpoints,
        stats,
        openIncidents: byId(action.openIncidents),
      };
    }

    case 'failed':
      return { ...state, error: action.error };

    case 'event': {
      const { event } = action;
      switch (event.type) {
        case 'check': {
          const d = event.data;
          const endpoint = state.endpoints[d.endpointId];
          if (!endpoint) return state; // not loaded yet, or deleted: the next full load fixes it

          const current = state.stats[d.endpointId] ?? emptyStats();
          const recent = [
            ...current.recent,
            { ok: d.success, ms: d.responseTimeMs, at: d.checkedAt },
          ].slice(-RECENT_LIMIT);
          // Keep the 24h figure moving without a refetch: fold this check into the old ratio.
          const okBefore =
            current.uptime24h === null
              ? 0
              : Math.round((current.uptime24h / 100) * current.checks24h);
          const checks24h = current.checks24h + 1;
          const okNow = okBefore + (d.success ? 1 : 0);

          return {
            ...state,
            endpoints: {
              ...state.endpoints,
              [d.endpointId]: {
                ...endpoint,
                lastCheckedAt: d.lastCheckedAt ?? endpoint.lastCheckedAt,
                ...(d.currentStatus ? { currentStatus: d.currentStatus } : {}),
                ...(d.consecutiveFailures !== undefined
                  ? { consecutiveFailures: d.consecutiveFailures }
                  : {}),
              },
            },
            stats: {
              ...state.stats,
              [d.endpointId]: {
                checks24h,
                uptime24h: Math.round((okNow / checks24h) * 10_000) / 100,
                recent,
                recentAvgResponseMs: recentAverage(recent),
              },
            },
          };
        }

        case 'incident.opened':
          return {
            ...state,
            openIncidents: { ...state.openIncidents, [event.data.id]: event.data },
          };

        case 'incident.resolved':
          return { ...state, openIncidents: omit(state.openIncidents, event.data.id) };

        case 'endpoint.upserted':
          return {
            ...state,
            endpoints: { ...state.endpoints, [event.data.id]: event.data },
            stats: { ...state.stats, [event.data.id]: state.stats[event.data.id] ?? emptyStats() },
          };

        case 'endpoint.deleted': {
          const id = event.data.id;
          const endpoints = omit(state.endpoints, id);
          const stats = omit(state.stats, id);
          const openIncidents = Object.fromEntries(
            Object.entries(state.openIncidents).filter(([, i]) => i.endpointId !== id),
          );
          return { ...state, endpoints, stats, openIncidents };
        }
      }
    }
  }
  return state;
}
