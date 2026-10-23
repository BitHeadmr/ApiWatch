import type { CheckOutcome, CheckTarget, FailureReason } from './types.js';
import { safeFetch } from './safe-fetch.js';

/** Only this much of a response body is read when checking for expected content. */
export const MAX_BODY_BYTES = 1024 * 1024;

const USER_AGENT = 'APIWatch/0.1 (+uptime monitor)';

const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_FAIL']);
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
]);
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** Does `actual` satisfy an expectation like "200" or "2xx"? */
export function statusMatches(expected: string, actual: number): boolean {
  const exp = expected.trim().toLowerCase();
  if (/^[1-5]xx$/.test(exp)) return Math.floor(actual / 100) === Number(exp[0]);
  return Number(exp) === actual;
}

type ErrLike = { name?: string; code?: string; message?: string; cause?: ErrLike };

/** Turn whatever fetch threw into a failure reason plus a short human-readable message. */
export function classifyError(err: unknown): { reason: FailureReason; message: string } {
  const e = (err ?? {}) as ErrLike;
  const code = e.cause?.code ?? e.code ?? '';
  const detail = (e.cause?.message ?? e.message ?? 'Unknown error').slice(0, 300);

  let reason: FailureReason = 'UNKNOWN';
  if (e.name === 'TimeoutError' || e.name === 'AbortError' || TIMEOUT_CODES.has(code)) {
    reason = 'TIMEOUT';
  } else if (DNS_CODES.has(code)) {
    reason = 'DNS';
  } else if (CONNECTION_CODES.has(code)) {
    reason = 'CONN_REFUSED';
  } else if (TLS_CODES.has(code) || code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL')) {
    reason = 'TLS';
  }
  if (reason === 'TIMEOUT') return { reason, message: 'Request timed out' };
  if (/bad port/i.test(detail)) {
    // Node's fetch refuses a fixed list of ports (1, 22, 25, 6000, ...) before connecting.
    return { reason, message: 'This port is blocked by the HTTP client (fetch "bad port" list)' };
  }
  return { reason, message: detail };
}

/** Read at most MAX_BODY_BYTES of the body as text, then stop downloading. */
async function readCappedBody(res: Response): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  try {
    while (received < MAX_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

/**
 * Performs one HTTP check. Never throws: every outcome, good or bad, is a CheckOutcome.
 *
 * The timeout covers the whole exchange (connect, headers and, when a body check is
 * configured, the body). Response time is measured to the end of that exchange.
 */
export async function performCheck(
  target: CheckTarget,
  fetchImpl: typeof fetch = safeFetch as unknown as typeof fetch,
): Promise<CheckOutcome> {
  const started = performance.now();
  const method = target.method.toUpperCase();
  const sendsBody = !['GET', 'HEAD'].includes(method) && !!target.body;
  const wantsBody = !!target.expectedBodyContains && method !== 'HEAD';

  try {
    const res = await fetchImpl(target.url, {
      method,
      headers: { 'user-agent': USER_AGENT, ...target.headers },
      body: sendsBody ? target.body! : undefined,
      signal: AbortSignal.timeout(target.timeoutMs),
      redirect: 'follow',
    });

    let bodyText = '';
    if (wantsBody && statusMatches(target.expectedStatus, res.status)) {
      bodyText = await readCappedBody(res);
    } else {
      await res.body?.cancel().catch(() => undefined);
    }
    const responseTimeMs = Math.round(performance.now() - started);

    if (!statusMatches(target.expectedStatus, res.status)) {
      return {
        success: false,
        statusCode: res.status,
        responseTimeMs,
        failureReason: 'BAD_STATUS',
        errorMessage: `Expected status ${target.expectedStatus}, got ${res.status}`,
      };
    }
    if (wantsBody && !bodyText.includes(target.expectedBodyContains!)) {
      return {
        success: false,
        statusCode: res.status,
        responseTimeMs,
        failureReason: 'BAD_BODY',
        errorMessage: 'Response body did not contain the expected text',
      };
    }
    return {
      success: true,
      statusCode: res.status,
      responseTimeMs,
      failureReason: null,
      errorMessage: null,
    };
  } catch (err) {
    const { reason, message } = classifyError(err);
    return {
      success: false,
      statusCode: null,
      responseTimeMs: null,
      failureReason: reason,
      errorMessage: message,
    };
  }
}
