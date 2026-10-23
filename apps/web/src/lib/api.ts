import { API_URL } from './config';
import { getToken, notifyUnauthorized } from './token';
import type {
  AlertChannel,
  CheckResult,
  Endpoint,
  EndpointInput,
  EndpointStats,
  Incident,
  IncidentDetail,
  EndpointHistory,
  User,
} from './types';

/** An error from the API, with the server's messages in a form that is safe to show. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly messages: string[],
  ) {
    super(messages[0] ?? `Request failed (${status})`);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** Skip the global "session expired" handling (used by the login form itself). */
  anonymous?: boolean;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = opts.anonymous ? null : getToken();
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, [`Can't reach the API at ${API_URL}. Is it running?`]);
  }

  if (res.status === 204) return undefined as T;
  const payload = await res.json().catch(() => null);

  if (!res.ok) {
    if (res.status === 401 && !opts.anonymous) notifyUnauthorized();
    const message = payload?.message;
    const messages = Array.isArray(message) ? message : message ? [String(message)] : [];
    throw new ApiError(res.status, messages.length ? messages : [`Request failed (${res.status})`]);
  }
  return payload as T;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

export interface AuthResult {
  accessToken: string;
  user: User;
}

export const api = {
  register: (body: { email: string; password: string; teamName: string }) =>
    request<AuthResult>('/auth/register', { method: 'POST', body, anonymous: true }),
  login: (body: { email: string; password: string }) =>
    request<AuthResult>('/auth/login', { method: 'POST', body, anonymous: true }),
  me: (signal?: AbortSignal) => request<User>('/auth/me', { signal }),

  listEndpoints: (signal?: AbortSignal) => request<Endpoint[]>('/endpoints', { signal }),
  getEndpoint: (id: string) => request<Endpoint>(`/endpoints/${id}`),
  createEndpoint: (body: EndpointInput) =>
    request<Endpoint>('/endpoints', { method: 'POST', body }),
  updateEndpoint: (id: string, body: EndpointInput) =>
    request<Endpoint>(`/endpoints/${id}`, { method: 'PATCH', body }),
  deleteEndpoint: (id: string) => request<void>(`/endpoints/${id}`, { method: 'DELETE' }),
  pauseEndpoint: (id: string) => request<Endpoint>(`/endpoints/${id}/pause`, { method: 'POST' }),
  resumeEndpoint: (id: string) => request<Endpoint>(`/endpoints/${id}/resume`, { method: 'POST' }),
  checkNow: (id: string) =>
    request<CheckResult & { transition: string | null; incident: string | null }>(
      `/endpoints/${id}/check-now`,
      { method: 'POST' },
    ),
  recentChecks: (id: string, limit = 50, signal?: AbortSignal) =>
    request<CheckResult[]>(`/endpoints/${id}/checks${qs({ limit })}`, { signal }),

  endpointHistory: (id: string, range: '24h' | '7d', signal?: AbortSignal) =>
    request<EndpointHistory>(`/stats/endpoints/${encodeURIComponent(id)}/history${qs({ range })}`, { signal }),

  overview: (signal?: AbortSignal) =>
    request<{ windowHours: number; endpoints: Record<string, EndpointStats> }>('/stats/overview', {
      signal,
    }),

  listIncidents: (
    params: { status?: 'open' | 'resolved'; endpointId?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) => request<Incident[]>(`/incidents${qs(params)}`, { signal }),
  getIncident: (id: string, signal?: AbortSignal) =>
    request<IncidentDetail>(`/incidents/${id}`, { signal }),

  listChannels: (endpointId: string, signal?: AbortSignal) =>
    request<AlertChannel[]>(`/endpoints/${endpointId}/channels`, { signal }),
  createChannel: (endpointId: string, body: { type: 'EMAIL' | 'WEBHOOK'; target: string }) =>
    request<AlertChannel>(`/endpoints/${endpointId}/channels`, { method: 'POST', body }),
  deleteChannel: (id: string) => request<void>(`/channels/${id}`, { method: 'DELETE' }),
  testChannel: (id: string) =>
    request<{ success: boolean; error?: string }>(`/channels/${id}/test`, { method: 'POST' }),
};
