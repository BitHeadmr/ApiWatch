import { signWebhook, verifyWebhook } from './webhook-signature.js';

const secret = 'whsec_test_secret_value';
const body = '{"event":"incident.opened"}';
const ts = 1_800_000_000;

describe('webhook signatures', () => {
  it('signs deterministically in the documented format', () => {
    const sig = signWebhook(secret, ts, body);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signWebhook(secret, ts, body)).toBe(sig);
  });

  it('verifies a genuine signature', () => {
    const signature = signWebhook(secret, ts, body);
    expect(verifyWebhook({ secret, timestamp: String(ts), body, signature, nowSeconds: ts })).toBe(true);
  });

  it('rejects a tampered body, a wrong secret and a tampered timestamp', () => {
    const signature = signWebhook(secret, ts, body);
    const base = { timestamp: String(ts), signature, nowSeconds: ts };
    expect(verifyWebhook({ ...base, secret, body: body + ' ' })).toBe(false);
    expect(verifyWebhook({ ...base, secret: 'whsec_other_secret_val', body })).toBe(false);
    expect(verifyWebhook({ ...base, secret, body, timestamp: String(ts + 1) })).toBe(false);
  });

  it('rejects replays outside the tolerance window, in either direction', () => {
    const signature = signWebhook(secret, ts, body);
    const opts = { secret, timestamp: String(ts), body, signature };
    expect(verifyWebhook({ ...opts, nowSeconds: ts + 299 })).toBe(true);
    expect(verifyWebhook({ ...opts, nowSeconds: ts + 301 })).toBe(false);
    expect(verifyWebhook({ ...opts, nowSeconds: ts - 301 })).toBe(false);
    expect(verifyWebhook({ ...opts, nowSeconds: ts + 3000, toleranceSeconds: 5000 })).toBe(true);
  });

  it('rejects garbage without throwing', () => {
    expect(verifyWebhook({ secret, timestamp: 'abc', body, signature: 'x' })).toBe(false);
    expect(verifyWebhook({ secret, timestamp: String(ts), body, signature: 'short', nowSeconds: ts })).toBe(false);
  });
});
