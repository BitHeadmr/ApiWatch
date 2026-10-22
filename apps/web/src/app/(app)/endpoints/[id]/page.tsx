'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ChannelsPanel } from '@/components/ChannelsPanel';
import { EmptyState, ErrorState, Fact, Heartbeat, Skeleton, StatusLamp } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useData } from '@/lib/data';
import {
  STATUS_LABEL,
  formatDateTime,
  formatDuration,
  formatMs,
  formatPercent,
  formatTime,
  intervalLabel,
  intervalShort,
  plural,
  reasonLabel,
  timeAgo,
} from '@/lib/format';
import type { CheckResult, LiveEvent } from '@/lib/types';
import { useNow } from '@/lib/use-now';
import { useResource } from '@/lib/use-resource';

const MAX_CHECKS = 50;
const SHOWN_CHECKS = 12;

/** Newest first, one row per check id. */
function mergeChecks(a: CheckResult[], b: CheckResult[]): CheckResult[] {
  const byId = new Map<string, CheckResult>();
  [...a, ...b].forEach((c) => byId.set(c.id, c));
  return [...byId.values()]
    .sort((x, y) => +new Date(y.checkedAt) - +new Date(x.checkedAt))
    .slice(0, MAX_CHECKS);
}

export default function EndpointDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <EndpointDetailView key={id} id={id} />;
}

function EndpointDetailView({ id }: { id: string }) {
  const router = useRouter();
  const { loaded, error, endpoints, stats, openIncidents, refresh, subscribe } = useData();
  const now = useNow(1000);
  const endpoint = endpoints[id];
  const stat = stats[id];

  const [liveChecks, setLiveChecks] = useState<CheckResult[]>([]);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showAllChecks, setShowAllChecks] = useState(false);

  const fetchChecks = useCallback(() => api.recentChecks(id, MAX_CHECKS), [id]);
  const fetchIncidents = useCallback(() => api.listIncidents({ endpointId: id, limit: 20 }), [id]);
  const { data: fetchedChecks } = useResource(id, fetchChecks);
  const { data: incidents, reload: reloadIncidents } = useResource(id, fetchIncidents);
  // What came from the API, plus anything that arrived live since.
  const checks = fetchedChecks === null ? null : mergeChecks(fetchedChecks, liveChecks);

  // New checks and incident changes for this endpoint appear without a refresh.
  useEffect(() => {
    return subscribe((event: LiveEvent) => {
      if (event.type === 'check' && event.data.endpointId === id) {
        const d = event.data;
        setLiveChecks((prev) =>
          mergeChecks(prev, [
            {
              id: d.checkId,
              endpointId: d.endpointId,
              checkedAt: d.checkedAt,
              success: d.success,
              statusCode: d.statusCode,
              responseTimeMs: d.responseTimeMs,
              failureReason: d.failureReason,
              errorMessage: d.errorMessage,
            },
          ]),
        );
      } else if (
        (event.type === 'incident.opened' || event.type === 'incident.resolved') &&
        event.data.endpointId === id
      ) {
        reloadIncidents();
      }
    });
  }, [subscribe, id, reloadIncidents]);

  async function run(action: () => Promise<unknown>, success?: (r: never) => string) {
    setBusy(true);
    setActionError(null);
    setActionMessage(null);
    try {
      const result = await action();
      if (success) setActionMessage(success(result as never));
    } catch (err) {
      setActionError(
        err instanceof ApiError ? err.messages.join(' ') : 'Something went wrong. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) {
    return error ? (
      <ErrorState message={error} onRetry={() => void refresh()} />
    ) : (
      <Skeleton className="h-12 w-96 max-w-full" />
    );
  }
  if (!endpoint || !stat) {
    return (
      <EmptyState
        title="That endpoint doesn't exist"
        action={
          <Link href="/" className="btn">
            Back to endpoints
          </Link>
        }
      >
        It may have been deleted.
      </EmptyState>
    );
  }

  const status = endpoint.currentStatus;
  const openIncident = Object.values(openIncidents).find((i) => i.endpointId === id);
  const statusLine =
    status === 'DOWN' && openIncident
      ? `Down for ${formatDuration(now - new Date(openIncident.startedAt).getTime())}`
      : STATUS_LABEL[status];

  return (
    <>
      <Link href="/">All endpoints</Link>

      <div className="mt-3 flex flex-wrap items-start justify-between gap-x-8 gap-y-5">
        <div className="min-w-0">
          <h1 className="display text-5xl break-words">{endpoint.name}</h1>
          <p className="mt-1 break-all text-muted">
            {endpoint.method} {endpoint.url}
          </p>
          <p
            className={`mt-4 flex items-center gap-3 text-lg font-semibold ${status === 'DOWN' ? 'text-down' : ''}`}
          >
            <StatusLamp status={status} />
            {statusLine}
            <span className="text-base font-normal text-muted">
              Last checked {timeAgo(endpoint.lastCheckedAt, now)}
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() =>
              void run(
                () => api.checkNow(id),
                (r: CheckResult) =>
                  r.success
                    ? `Healthy: ${r.statusCode} in ${formatMs(r.responseTimeMs)}.`
                    : `Failed: ${r.errorMessage ?? reasonLabel(r.failureReason)}.`,
              )
            }
          >
            Check now
          </button>
          {endpoint.isActive ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.pauseEndpoint(id),
                  () => 'Monitoring paused.',
                )
              }
            >
              Pause monitoring
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.resumeEndpoint(id),
                  () => 'Monitoring resumed.',
                )
              }
            >
              Resume monitoring
            </button>
          )}
          <Link href={`/endpoints/${id}/edit`} className="btn">
            Edit
          </Link>
          {confirmDelete ? (
            <span className="flex items-center gap-2" role="group" aria-label="Confirm deletion">
              <span className="text-sm">Delete this endpoint and its history?</span>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api.deleteEndpoint(id);
                    router.push('/');
                  })
                }
              >
                Delete
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setConfirmDelete(false)}
              >
                Keep it
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-quiet" onClick={() => setConfirmDelete(true)}>
              Delete…
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 min-h-6" aria-live="polite">
        {actionMessage && <p className="text-muted">{actionMessage}</p>}
        {actionError && (
          <p role="alert" className="text-down">
            {actionError}
          </p>
        )}
      </div>

      <dl className="mt-8 grid grid-cols-2 gap-x-10 gap-y-6 border-y border-rule py-6 md:grid-cols-4">
        <Fact label="Uptime, last 24 hours">{formatPercent(stat.uptime24h)}</Fact>
        <Fact label="Typical response">{formatMs(stat.recentAvgResponseMs)}</Fact>
        <Fact label="Checks in 24 hours">{stat.checks24h}</Fact>
        <Fact label="Check interval">
          {endpoint.isActive ? intervalShort(endpoint.intervalSeconds) : 'Paused'}
        </Fact>
      </dl>

      <div className="mt-8">
        <Heartbeat recent={stat.recent} large />
      </div>

      <section className="mt-14" aria-labelledby="checks-h">
        <h2 id="checks-h" className="display text-3xl">
          Recent checks
        </h2>
        {checks === null ? (
          <Skeleton className="mt-4 h-40 w-full" />
        ) : checks.length === 0 ? (
          <p className="mt-3 text-muted">
            No checks yet. The first one runs within moments of starting.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-sm text-muted">
                  <th className="py-2 pr-4 font-normal">Time</th>
                  <th className="py-2 pr-4 font-normal">Result</th>
                  <th className="py-2 pr-4 font-normal">Status</th>
                  <th className="py-2 text-right font-normal">Response</th>
                </tr>
              </thead>
              <tbody>
                {(showAllChecks ? checks : checks.slice(0, SHOWN_CHECKS)).map((c) => (
                  <tr key={c.id} className="border-t border-rule">
                    <td className="py-2 pr-4 tnum whitespace-nowrap">{formatTime(c.checkedAt)}</td>
                    <td className={`py-2 pr-4 ${c.success ? '' : 'text-down font-semibold'}`}>
                      {c.success ? 'Healthy' : (c.errorMessage ?? reasonLabel(c.failureReason))}
                    </td>
                    <td className="py-2 pr-4 tnum">{c.statusCode ?? '—'}</td>
                    <td className="py-2 text-right tnum">{formatMs(c.responseTimeMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {checks.length > SHOWN_CHECKS && (
              <button
                type="button"
                className="btn mt-4"
                onClick={() => setShowAllChecks((v) => !v)}
              >
                {showAllChecks ? 'Show fewer' : `Show all ${checks.length} recent checks`}
              </button>
            )}
          </div>
        )}
      </section>

      <section className="mt-14" aria-labelledby="incidents-h">
        <h2 id="incidents-h" className="display text-3xl">
          Incidents
        </h2>
        {incidents === null ? (
          <Skeleton className="mt-4 h-20 w-full" />
        ) : incidents.length === 0 ? (
          <p className="mt-3 text-muted">
            No incidents. Nothing has gone wrong with this endpoint.
          </p>
        ) : (
          <ul className="mt-4 border-b border-rule">
            {incidents.map((i) => (
              <li
                key={i.id}
                className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-rule py-3"
              >
                <StatusLamp status={i.status === 'OPEN' ? 'DOWN' : 'UP'} />
                <Link href={`/incidents/${i.id}`} className="font-semibold">
                  {i.status === 'OPEN' ? 'Ongoing' : 'Resolved'}: {reasonLabel(i.reason)}
                </Link>
                <span className="text-muted">{formatDateTime(i.startedAt)}</span>
                <span className="ml-auto tnum">
                  {formatDuration(
                    i.status === 'OPEN' ? now - new Date(i.startedAt).getTime() : i.durationMs,
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-14" aria-labelledby="alerts-h">
        <h2 id="alerts-h" className="display text-3xl">
          Alerts
        </h2>
        <p className="mb-4 mt-1 text-muted">
          Who gets told when this endpoint goes down and when it recovers.
        </p>
        <ChannelsPanel endpointId={id} />
      </section>

      <section className="mt-14" aria-labelledby="config-h">
        <h2 id="config-h" className="display text-3xl">
          Settings
        </h2>
        <dl className="mt-4 grid max-w-3xl gap-x-10 gap-y-3 sm:grid-cols-[14rem_minmax(0,1fr)]">
          <dt className="text-muted">Frequency</dt>
          <dd>{intervalLabel(endpoint.intervalSeconds)}</dd>
          <dt className="text-muted">Timeout</dt>
          <dd>{plural(endpoint.timeoutMs / 1000, 'second')}</dd>
          <dt className="text-muted">Expected status</dt>
          <dd>{endpoint.expectedStatus}</dd>
          <dt className="text-muted">Response must contain</dt>
          <dd>{endpoint.expectedBodyContains ?? 'Anything'}</dd>
          <dt className="text-muted">Incident after</dt>
          <dd>{plural(endpoint.failureThreshold, 'failed check')} in a row</dd>
          <dt className="text-muted">Request headers</dt>
          <dd>
            {endpoint.headers && Object.keys(endpoint.headers).length
              ? Object.keys(endpoint.headers).join(', ')
              : 'None'}
          </dd>
        </dl>
      </section>
    </>
  );
}
