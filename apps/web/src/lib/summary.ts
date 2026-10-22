import { formatDuration } from './format';
import type { Endpoint, EndpointStatus, Incident } from './types';

const RANK: Record<EndpointStatus, number> = { DOWN: 0, UNKNOWN: 1, UP: 2, PAUSED: 3 };

/** Problems first, then everything else, alphabetically. */
export function sortEndpoints(endpoints: Endpoint[]): Endpoint[] {
  return [...endpoints].sort(
    (a, b) => RANK[a.currentStatus] - RANK[b.currentStatus] || a.name.localeCompare(b.name),
  );
}

export interface Summary {
  total: number;
  down: Endpoint[];
  up: number;
  paused: number;
  unknown: number;
}

export function summarize(endpoints: Endpoint[]): Summary {
  const s: Summary = { total: endpoints.length, down: [], up: 0, paused: 0, unknown: 0 };
  for (const e of endpoints) {
    if (e.currentStatus === 'DOWN') s.down.push(e);
    else if (e.currentStatus === 'UP') s.up++;
    else if (e.currentStatus === 'PAUSED') s.paused++;
    else s.unknown++;
  }
  return s;
}

/** The one sentence the overview leads with. */
export function headline(s: Summary): string {
  if (s.total === 0) return 'Nothing is being watched yet.';
  if (s.down.length === 1) return '1 endpoint is down.';
  if (s.down.length > 1) return `${s.down.length} endpoints are down.`;
  if (s.up === 0 && s.unknown === 0) return 'Everything is paused.';
  if (s.up === 0) return 'Waiting for the first checks.';
  if (s.unknown > 0) return 'Everything checked so far is up.';
  return 'Everything is up.';
}

/** "Payments API for 4m 12s, Auth for 1h 2m". Uses the open incident for the real downtime. */
export function downSubline(
  down: Endpoint[],
  openIncidents: Incident[],
  now: number = Date.now(),
): string {
  return down
    .map((e) => {
      const incident = openIncidents.find((i) => i.endpointId === e.id);
      return incident
        ? `${e.name} for ${formatDuration(now - new Date(incident.startedAt).getTime())}`
        : e.name;
    })
    .join(', ');
}
