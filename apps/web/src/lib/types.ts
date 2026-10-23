export type EndpointStatus = 'UNKNOWN' | 'UP' | 'DOWN' | 'PAUSED';

export interface User {
  id: string;
  email: string;
  teamId: string;
  team?: { id: string; name: string } | null;
}

export interface Endpoint {
  id: string;
  teamId: string;
  name: string;
  url: string;
  method: string;
  headers: Record<string, string> | null;
  body: string | null;
  intervalSeconds: number;
  timeoutMs: number;
  expectedStatus: string;
  expectedBodyContains: string | null;
  failureThreshold: number;
  isActive: boolean;
  currentStatus: EndpointStatus;
  consecutiveFailures: number;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The fields the form can set. */
export type EndpointInput = Partial<
  Pick<
    Endpoint,
    | 'name'
    | 'url'
    | 'method'
    | 'headers'
    | 'body'
    | 'intervalSeconds'
    | 'timeoutMs'
    | 'expectedStatus'
    | 'expectedBodyContains'
    | 'failureThreshold'
    | 'isActive'
  >
>;

export interface RecentCheck {
  ok: boolean;
  ms: number | null;
  at: string;
}

export interface EndpointStats {
  checks24h: number;
  uptime24h: number | null;
  recent: RecentCheck[];
  recentAvgResponseMs: number | null;
}

export type FailureReason =
  'TIMEOUT' | 'DNS' | 'CONN_REFUSED' | 'TLS' | 'BAD_STATUS' | 'BAD_BODY' | 'UNKNOWN';

export interface CheckResult {
  id: string;
  endpointId: string;
  checkedAt: string;
  success: boolean;
  statusCode: number | null;
  responseTimeMs: number | null;
  failureReason: FailureReason | null;
  errorMessage: string | null;
}

export interface Incident {
  id: string;
  teamId: string;
  endpointId: string;
  endpointName: string;
  status: 'OPEN' | 'RESOLVED';
  reason: FailureReason | null;
  errorMessage: string | null;
  consecutiveFailures: number;
  startedAt: string;
  detectedAt: string;
  resolvedAt: string | null;
  resolution: 'RECOVERED' | 'PAUSED' | null;
  durationMs: number;
}

export interface AlertEntry {
  id: string;
  event: 'incident.opened' | 'incident.resolved';
  channelType: 'EMAIL' | 'WEBHOOK';
  target: string;
  status: 'PENDING' | 'SENT' | 'FAILED';
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface IncidentDetail extends Incident {
  failedChecks: CheckResult[];
  alerts: AlertEntry[];
}

export interface AlertChannel {
  id: string;
  endpointId: string;
  type: 'EMAIL' | 'WEBHOOK';
  target: string;
  createdAt: string;
  /** Present only in the response that creates a webhook channel. */
  secret?: string;
}

/** Payload of the live `check` event. Status fields are absent when the check changed nothing. */
export interface CheckEventData {
  endpointId: string;
  checkId: string;
  checkedAt: string;
  success: boolean;
  statusCode: number | null;
  responseTimeMs: number | null;
  failureReason: FailureReason | null;
  errorMessage: string | null;
  currentStatus?: EndpointStatus;
  consecutiveFailures?: number;
  lastCheckedAt?: string;
}

export type LiveEvent =
  | { type: 'check'; data: CheckEventData }
  | { type: 'incident.opened'; data: Incident }
  | { type: 'incident.resolved'; data: Incident }
  | { type: 'endpoint.upserted'; data: Endpoint }
  | { type: 'endpoint.deleted'; data: { id: string } };

export type ConnectionState = 'connecting' | 'live' | 'offline';

export interface HistoryPoint {
  at: string; checks: number; failures: number; uptime: number | null; avgResponseMs: number | null;
}
export interface EndpointHistory {
  range: '24h' | '7d'; from: string; to: string; bucketMinutes: number;
  summary: { checks: number; uptime: number | null; avgResponseMs: number | null; p95ResponseMs: number | null };
  points: HistoryPoint[];
}
