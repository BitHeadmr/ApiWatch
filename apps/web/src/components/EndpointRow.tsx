'use client';

import Link from 'next/link';
import { useState } from 'react';
import { formatDuration, formatMs, formatPercent, timeAgo } from '@/lib/format';
import type { Endpoint, EndpointStats, Incident } from '@/lib/types';
import { Heartbeat, StatusLamp } from './ui';

/** Column layout shared by the header and every row. */
export const LEDGER_COLUMNS = 'md:grid-cols-[1rem_minmax(0,1fr)_12.25rem_5.5rem_5rem_5rem]';

export function EndpointRow({
  endpoint,
  stats,
  incident,
  now,
}: {
  endpoint: Endpoint;
  stats: EndpointStats;
  incident?: Incident;
  now: number;
}) {
  const status = endpoint.currentStatus;
  const last = stats.recent.at(-1);

  // A row that just changed state flashes once. (Derived during render, no effect needed.)
  const [seen, setSeen] = useState(status);
  const [flashing, setFlashing] = useState(false);
  if (seen !== status) {
    setSeen(status);
    setFlashing(true);
  }

  let statusText: string | null = null;
  if (status === 'DOWN') {
    statusText = incident
      ? `Down for ${formatDuration(now - new Date(incident.startedAt).getTime())}`
      : 'Down';
  } else if (status === 'PAUSED') statusText = 'Paused';
  else if (status === 'UNKNOWN') statusText = 'Waiting for first check';

  const down = status === 'DOWN';
  const textColor = down ? 'text-down' : status === 'UNKNOWN' ? 'text-unknown' : 'text-muted';

  return (
    <li
      className={`grid grid-cols-[1rem_minmax(0,1fr)] ${LEDGER_COLUMNS} items-center gap-x-4 gap-y-2 border-t border-rule px-3 py-3.5 ${
        flashing ? 'row-flash' : ''
      }`}
      style={
        down
          ? { background: 'var(--down-wash)', boxShadow: 'inset 3px 0 0 var(--down)' }
          : undefined
      }
      onAnimationEnd={() => setFlashing(false)}
    >
      <StatusLamp status={status} />

      <div className="min-w-0">
        <Link
          href={`/endpoints/${endpoint.id}`}
          className="font-semibold text-ink no-underline hover:underline"
        >
          {endpoint.name}
        </Link>
        <div className="flex min-w-0 gap-x-3 text-sm">
          {statusText && (
            <span className={`font-semibold whitespace-nowrap ${textColor}`}>{statusText}</span>
          )}
          <span className="truncate text-muted">{endpoint.url}</span>
        </div>
      </div>

      <div className="col-start-2 md:col-start-auto">
        <Heartbeat recent={stats.recent} />
      </div>

      {/* Phones: one compact line. Wider screens: separate columns. */}
      <p className="col-start-2 text-sm text-muted tnum md:hidden">
        {last
          ? `${formatPercent(stats.uptime24h)} uptime, ${formatMs(last.ms)}, checked ${timeAgo(endpoint.lastCheckedAt, now)}`
          : 'No checks yet'}
      </p>
      <span className="hidden md:block text-right tnum">{formatPercent(stats.uptime24h)}</span>
      <span className="hidden md:block text-right tnum">{formatMs(last?.ms)}</span>
      <span className="hidden md:block text-right text-muted text-sm tnum">
        {timeAgo(endpoint.lastCheckedAt, now)}
      </span>
    </li>
  );
}

export function LedgerHeader() {
  return (
    <div className={`hidden md:grid ${LEDGER_COLUMNS} gap-x-4 px-3 pb-2 text-sm text-muted`}>
      <span />
      <span>Endpoint</span>
      <span>Last 30 checks</span>
      <span className="text-right">Uptime, 24h</span>
      <span className="text-right">Response</span>
      <span className="text-right">Checked</span>
    </div>
  );
}
