import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhooks are signed so a receiver can tell they really came from APIWatch:
 *   X-APIWatch-Timestamp: <unix seconds>
 *   X-APIWatch-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with your secret>
 * Including the timestamp in the signed text stops an old captured request being replayed.
 */
export function signWebhook(secret: string, timestamp: number | string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export function verifyWebhook(opts: {
  secret: string;
  timestamp: string;
  body: string;
  signature: string;
  /** Reject requests older (or newer) than this. Default 5 minutes. */
  toleranceSeconds?: number;
  nowSeconds?: number;
}): boolean {
  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ts = Number(opts.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > tolerance) return false;

  const expected = Buffer.from(signWebhook(opts.secret, opts.timestamp, opts.body));
  const given = Buffer.from(opts.signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
