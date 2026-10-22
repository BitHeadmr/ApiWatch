'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, Fact, Skeleton, StatusLamp } from '@/components/ui';
import { api } from '@/lib/api';
import { useData } from '@/lib/data';
import { formatDateTime, formatDuration, formatMs, formatTime, reasonLabel } from '@/lib/format';
import { useNow } from '@/lib/use-now';
import { useResource } from '@/lib/use-resource';

const FAILED_SHOWN = 10;
const ALERT_EVENT = {
  'incident.opened': 'Down alert',
  'incident.resolved': 'Recovery alert',
} as const;

export default function IncidentDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <IncidentDetailView key={id} id={id} />;
}

function IncidentDetailView({ id }: { id: string }) {
  const { endpoints, subscribe } = useData();
  const now = useNow(1000);
  const [showAllFailed, setShowAllFailed] = useState(false);
  const fetchIncident = useCallback(() => api.getIncident(id), [id]);
  const { data: incident, error, reload } = useResource(id, fetchIncident);

  useEffect(
    () =>
      subscribe((e) => {
        if ((e.type === 'incident.opened' || e.type === 'incident.resolved') && e.data.id === id)
          reload();
      }),
    [subscribe, id, reload],
  );

  if (error && !incident) {
    return /not found/i.test(error) ? (
      <EmptyState
        title="That incident doesn't exist"
        action={
          <Link href="/incidents" className="btn">
            Back to incidents
          </Link>
        }
      >
        It may have been deleted along with its endpoint.
      </EmptyState>
    ) : (
      <ErrorState message={error} onRetry={reload} />
    );
  }
  if (!incident) return <Skeleton className="h-12 w-96 max-w-full" />;

  const open = incident.status === 'OPEN';
  const duration = open ? now - new Date(incident.startedAt).getTime() : incident.durationMs;
  const endpointExists = Boolean(endpoints[incident.endpointId]);

  return (
    <>
      <Link href="/incidents">All incidents</Link>
      <h1 className="display mt-3 text-5xl">
        {open
          ? `${incident.endpointName} is down`
          : incident.resolution === 'PAUSED'
            ? `${incident.endpointName} stopped being monitored`
            : `${incident.endpointName} recovered`}
      </h1>
      <p
        className={`mt-3 flex items-center gap-3 text-lg font-semibold ${open ? 'text-down' : ''}`}
      >
        <StatusLamp status={open ? 'DOWN' : incident.resolution === 'PAUSED' ? 'PAUSED' : 'UP'} />
        {open
          ? 'Ongoing'
          : incident.resolution === 'PAUSED'
            ? 'Ended when monitoring was paused'
            : 'Resolved'}
      </p>

      <dl className="mt-8 grid grid-cols-2 gap-x-10 gap-y-6 border-y border-rule py-6 md:grid-cols-4">
        <Fact label="Went down">{formatDateTime(incident.startedAt)}</Fact>
        <Fact label="Raised">{formatDateTime(incident.detectedAt)}</Fact>
        <Fact label={open ? 'Still down' : 'Recovered'}>
          {open ? 'Yes' : formatDateTime(incident.resolvedAt)}
        </Fact>
        <Fact label="Downtime">{formatDuration(duration)}</Fact>
      </dl>

      <section className="mt-12 max-w-2xl" aria-labelledby="what-h">
        <h2 id="what-h" className="display text-3xl">
          What happened
        </h2>
        <p className="mt-3 text-lg">{reasonLabel(incident.reason)}.</p>
        {incident.errorMessage && <p className="mt-1 text-muted">{incident.errorMessage}</p>}
        <p className="mt-3 text-muted">
          {incident.consecutiveFailures} failed{' '}
          {incident.consecutiveFailures === 1 ? 'check' : 'checks'} in a row triggered this
          incident.
        </p>
        {endpointExists && (
          <p className="mt-4">
            <Link href={`/endpoints/${incident.endpointId}`}>Open {incident.endpointName}</Link>
          </p>
        )}
      </section>

      <section className="mt-12" aria-labelledby="alerts-h">
        <h2 id="alerts-h" className="display text-3xl">
          Alerts sent
        </h2>
        {incident.alerts.length === 0 ? (
          <p className="mt-3 max-w-xl text-muted">
            No alerts were sent for this incident. Add an email or webhook on the endpoint page to
            be told next time.
          </p>
        ) : (
          <ul className="mt-4 border-b border-rule">
            {incident.alerts.map((a) => (
              <li
                key={a.id}
                className="grid gap-x-6 gap-y-1 border-t border-rule py-3 sm:grid-cols-[9rem_minmax(0,1fr)_auto]"
              >
                <span className="font-semibold">{ALERT_EVENT[a.event]}</span>
                <span className="min-w-0 break-all">
                  {a.channelType === 'EMAIL' ? 'Email' : 'Webhook'}: {a.target}
                </span>
                <span
                  className={
                    a.status === 'FAILED'
                      ? 'text-down font-semibold'
                      : a.status === 'PENDING'
                        ? 'text-muted'
                        : ''
                  }
                >
                  {a.status === 'SENT' ? 'Delivered' : a.status === 'FAILED' ? 'Failed' : 'Sending'}
                  {a.attempts > 1 && `, ${a.attempts} attempts`}
                </span>
                {a.lastError && (
                  <span className="text-sm text-muted sm:col-span-3">{a.lastError}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-12" aria-labelledby="failed-h">
        <h2 id="failed-h" className="display text-3xl">
          Failed checks
        </h2>
        {incident.failedChecks.length === 0 ? (
          <p className="mt-3 text-muted">No failed checks were recorded for this incident.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-sm text-muted">
                  <th className="py-2 pr-4 font-normal">Time</th>
                  <th className="py-2 pr-4 font-normal">What happened</th>
                  <th className="py-2 pr-4 font-normal">Status</th>
                  <th className="py-2 text-right font-normal">Response</th>
                </tr>
              </thead>
              <tbody>
                {(showAllFailed
                  ? incident.failedChecks
                  : incident.failedChecks.slice(0, FAILED_SHOWN)
                ).map((c) => (
                  <tr key={c.id} className="border-t border-rule">
                    <td className="py-2 pr-4 tnum whitespace-nowrap">{formatTime(c.checkedAt)}</td>
                    <td className="py-2 pr-4">{c.errorMessage ?? reasonLabel(c.failureReason)}</td>
                    <td className="py-2 pr-4 tnum">{c.statusCode ?? '—'}</td>
                    <td className="py-2 text-right tnum">{formatMs(c.responseTimeMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {incident.failedChecks.length > FAILED_SHOWN && (
              <button
                type="button"
                className="btn mt-4"
                onClick={() => setShowAllFailed((v) => !v)}
              >
                {showAllFailed
                  ? 'Show fewer'
                  : `Show all ${incident.failedChecks.length} failed checks`}
              </button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
