export type AlertEvent = 'incident.opened' | 'incident.resolved' | 'alert.test';

export interface AlertPayload {
  event: AlertEvent;
  /** Unique per delivery. Receivers can use it to ignore a repeated delivery. */
  deliveryId: string;
  sentAt: string;
  endpoint: { id: string; name: string; url: string };
  incident: {
    id: string;
    status: 'OPEN' | 'RESOLVED';
    reason: string | null;
    errorMessage: string | null;
    consecutiveFailures: number;
    startedAt: string;
    detectedAt: string;
    resolvedAt: string | null;
    resolution: string | null;
    durationMs: number;
  };
}

interface IncidentLike {
  id: string;
  status: 'OPEN' | 'RESOLVED';
  reason: string | null;
  errorMessage: string | null;
  consecutiveFailures: number;
  startedAt: Date;
  detectedAt: Date;
  resolvedAt: Date | null;
  resolution: string | null;
}

export function buildPayload(input: {
  event: AlertEvent;
  deliveryId: string;
  endpoint: { id: string; name: string; url: string };
  incident: IncidentLike;
  now?: Date;
}): AlertPayload {
  const now = input.now ?? new Date();
  const i = input.incident;
  const end = i.resolvedAt ?? now;
  return {
    event: input.event,
    deliveryId: input.deliveryId,
    sentAt: now.toISOString(),
    endpoint: input.endpoint,
    incident: {
      id: i.id,
      status: i.status,
      reason: i.reason,
      errorMessage: i.errorMessage,
      consecutiveFailures: i.consecutiveFailures,
      startedAt: i.startedAt.toISOString(),
      detectedAt: i.detectedAt.toISOString(),
      resolvedAt: i.resolvedAt ? i.resolvedAt.toISOString() : null,
      resolution: i.resolution,
      durationMs: Math.max(0, end.getTime() - i.startedAt.getTime()),
    },
  };
}

/** A made-up incident, for "send a test alert". */
export function buildTestPayload(
  endpoint: { id: string; name: string; url: string },
  deliveryId: string,
  now = new Date(),
): AlertPayload {
  return buildPayload({
    event: 'alert.test',
    deliveryId,
    endpoint,
    now,
    incident: {
      id: 'test',
      status: 'OPEN',
      reason: 'BAD_STATUS',
      errorMessage: 'This is a test alert. Nothing is wrong.',
      consecutiveFailures: 3,
      startedAt: new Date(now.getTime() - 3 * 60_000),
      detectedAt: now,
      resolvedAt: null,
      resolution: null,
    },
  });
}

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

const REASONS: Record<string, string> = {
  TIMEOUT: 'The request timed out',
  DNS: 'The hostname could not be resolved',
  CONN_REFUSED: 'The connection was refused or dropped',
  TLS: 'A TLS/certificate error occurred',
  BAD_STATUS: 'The response had an unexpected status code',
  BAD_BODY: 'The response body did not contain the expected text',
  UNKNOWN: 'The request failed',
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export function buildEmail(payload: AlertPayload, appUrl: string): EmailContent {
  const { endpoint, incident, event } = payload;
  const base = appUrl.replace(/\/+$/, '');
  const link = payload.incident.id === 'test' ? base : `${base}/incidents/${incident.id}`;
  const reason = incident.reason ? (REASONS[incident.reason] ?? incident.reason) : 'Unknown';
  const duration = formatDuration(incident.durationMs);

  let headline: string;
  let subject: string;
  if (event === 'incident.opened') {
    headline = `${endpoint.name} is DOWN`;
    subject = `🔴 [APIWatch] ${headline}`;
  } else if (event === 'incident.resolved') {
    headline = `${endpoint.name} has recovered`;
    subject = `✅ [APIWatch] ${headline} (down for ${duration})`;
  } else {
    headline = `Test alert for ${endpoint.name}`;
    subject = `[APIWatch] ${headline}`;
  }

  const rows: Array<[string, string]> = [
    ['Endpoint', `${endpoint.name} (${endpoint.url})`],
    ['Down since', incident.startedAt],
  ];
  if (event === 'incident.resolved') {
    rows.push(['Recovered at', incident.resolvedAt ?? '']);
    rows.push(['Total downtime', duration]);
  } else {
    rows.push(['Failing for', `${incident.consecutiveFailures} checks in a row`]);
  }
  rows.push(['What happened', reason]);
  if (incident.errorMessage) rows.push(['Details', incident.errorMessage]);
  rows.push(['Incident', link]);

  const text = `${headline}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n`;
  const html =
    `<div style="font-family:system-ui,sans-serif;max-width:560px">` +
    `<h2 style="margin:0 0 12px">${escapeHtml(headline)}</h2>` +
    `<table style="border-collapse:collapse">` +
    rows
      .map(
        ([k, v]) =>
          `<tr><td style="padding:4px 12px 4px 0;color:#666;vertical-align:top">${escapeHtml(k)}</td>` +
          `<td style="padding:4px 0">${escapeHtml(v)}</td></tr>`,
      )
      .join('') +
    `</table></div>`;
  return { subject, text, html };
}
