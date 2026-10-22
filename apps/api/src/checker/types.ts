export const FAILURE_REASONS = [
  'TIMEOUT',
  'DNS',
  'CONN_REFUSED',
  'TLS',
  'BAD_STATUS',
  'BAD_BODY',
  'UNKNOWN',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

export interface CheckTarget {
  url: string;
  method: string;
  headers?: Record<string, string> | null;
  body?: string | null;
  timeoutMs: number;
  /** "200" or a class such as "2xx". */
  expectedStatus: string;
  expectedBodyContains?: string | null;
}

export interface CheckOutcome {
  success: boolean;
  statusCode: number | null;
  /** Null when no response arrived (timeout, DNS failure, refused connection, ...). */
  responseTimeMs: number | null;
  failureReason: FailureReason | null;
  errorMessage: string | null;
}
