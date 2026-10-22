import type { EndpointStatus, FailureReason } from './types';

/** 45s, 5m 3s, 2h 5m, 1d 3h. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export function timeAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(iso));
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s` : `${Math.round(ms)} ms`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Number.isInteger(value) ? value : value.toFixed(2).replace(/0$/, '')}%`;
}

export function intervalLabel(seconds: number): string {
  if (seconds < 60) return `every ${seconds} seconds`;
  if (seconds === 60) return 'every minute';
  if (seconds < 3600) return `every ${Math.round(seconds / 60)} minutes`;
  if (seconds === 3600) return 'every hour';
  return `every ${Math.round(seconds / 3600)} hours`;
}

/** "30 seconds", "1 minute", "5 minutes", "1 hour": the interval as a bare quantity. */
export function intervalShort(seconds: number): string {
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (seconds < 60) return unit(seconds, 'second');
  if (seconds < 3600) return unit(Math.round(seconds / 60), 'minute');
  return unit(Math.round(seconds / 3600), 'hour');
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export const STATUS_LABEL: Record<EndpointStatus, string> = {
  UP: 'Up',
  DOWN: 'Down',
  PAUSED: 'Paused',
  UNKNOWN: 'Waiting for first check',
};

const REASONS: Record<FailureReason, string> = {
  TIMEOUT: 'The request timed out',
  DNS: "The hostname couldn't be resolved",
  CONN_REFUSED: 'The connection was refused or dropped',
  TLS: 'A TLS or certificate error occurred',
  BAD_STATUS: 'The response had an unexpected status code',
  BAD_BODY: "The response body didn't contain the expected text",
  UNKNOWN: 'The request failed',
};

export function reasonLabel(reason: FailureReason | null): string {
  return reason ? REASONS[reason] : 'Unknown';
}
