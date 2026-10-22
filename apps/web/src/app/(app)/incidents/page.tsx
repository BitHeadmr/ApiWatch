'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Skeleton, StatusLamp } from '@/components/ui';
import { api } from '@/lib/api';
import { useData } from '@/lib/data';
import { formatDateTime, formatDuration, reasonLabel, timeAgo } from '@/lib/format';
import type { Incident } from '@/lib/types';
import { useNow } from '@/lib/use-now';
import { useResource } from '@/lib/use-resource';

type Filter = 'all' | 'open' | 'resolved';
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Ongoing' },
  { id: 'resolved', label: 'Resolved' },
];

function incidentState(i: Incident): string {
  if (i.status === 'OPEN') return 'Ongoing';
  return i.resolution === 'PAUSED' ? 'Ended, monitoring paused' : 'Resolved';
}

export default function IncidentsPage() {
  const { subscribe } = useData();
  const now = useNow(1000);
  const [filter, setFilter] = useState<Filter>('all');
  const fetchList = useCallback(
    () => api.listIncidents({ status: filter === 'all' ? undefined : filter, limit: 100 }),
    [filter],
  );
  const { data: incidents, error, reload } = useResource(filter, fetchList);

  // A new or resolved incident shows up straight away.
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === 'incident.opened' || e.type === 'incident.resolved') reload();
      }),
    [subscribe, reload],
  );

  return (
    <>
      <h1 className="display text-5xl">Incidents</h1>
      <p className="mt-2 text-lg text-muted">
        Every time an endpoint went down, and how long it took to recover.
      </p>

      <div
        role="group"
        aria-label="Filter incidents"
        className="mt-8 flex gap-1 border-b border-rule"
      >
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={`-mb-px border-b-2 px-4 py-2 font-semibold ${filter === f.id ? 'border-ink text-ink' : 'border-transparent text-muted hover:text-ink'}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="mt-6">
        {error && !incidents ? (
          <ErrorState message={error} onRetry={reload} />
        ) : incidents === null ? (
          <div aria-busy="true" className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : incidents.length === 0 ? (
          <EmptyState
            title={
              filter === 'open'
                ? 'Nothing is down right now'
                : filter === 'resolved'
                  ? 'No resolved incidents yet'
                  : 'No incidents yet'
            }
          >
            {filter === 'open'
              ? 'Every endpoint you watch is responding.'
              : 'When an endpoint fails its checks repeatedly, it appears here.'}
          </EmptyState>
        ) : (
          <ul className="border-b border-rule">
            {[...incidents]
              .sort((a, b) => Number(b.status === 'OPEN') - Number(a.status === 'OPEN'))
              .map((i) => (
                <li
                  key={i.id}
                  className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-t border-rule px-3 py-3.5"
                  style={
                    i.status === 'OPEN'
                      ? { background: 'var(--down-wash)', boxShadow: 'inset 3px 0 0 var(--down)' }
                      : undefined
                  }
                >
                  <StatusLamp
                    status={
                      i.status === 'OPEN' ? 'DOWN' : i.resolution === 'PAUSED' ? 'PAUSED' : 'UP'
                    }
                  />
                  <div className="min-w-0">
                    <Link
                      href={`/incidents/${i.id}`}
                      className="font-semibold text-ink no-underline hover:underline"
                    >
                      {i.endpointName}
                    </Link>
                    <p className="text-sm text-muted">{reasonLabel(i.reason)}</p>
                  </div>
                  <div className="text-right">
                    <p className={`tnum font-semibold ${i.status === 'OPEN' ? 'text-down' : ''}`}>
                      {incidentState(i)},{' '}
                      {formatDuration(
                        i.status === 'OPEN' ? now - new Date(i.startedAt).getTime() : i.durationMs,
                      )}
                    </p>
                    <p className="text-sm text-muted" title={formatDateTime(i.startedAt)}>
                      Started {timeAgo(i.startedAt, now)}
                    </p>
                  </div>
                </li>
              ))}
          </ul>
        )}
      </div>
    </>
  );
}
