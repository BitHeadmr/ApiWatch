import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AlertPayload } from '../alert-payload.js';
import { signWebhook } from '../webhook-signature.js';

@Injectable()
export class WebhookService {
  constructor(private readonly config: ConfigService) {}

  /** POSTs the signed payload. Anything but a 2xx response, or no response, is a failure. */
  async send(target: string, secret: string | null, payload: AlertPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'APIWatch-Webhook/0.1',
      'x-apiwatch-event': payload.event,
      'x-apiwatch-delivery': payload.deliveryId,
      'x-apiwatch-timestamp': String(timestamp),
    };
    if (secret) headers['x-apiwatch-signature'] = signWebhook(secret, timestamp, body);

    let res: Response;
    try {
      res = await fetch(target, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual', // a redirect is not a delivery
        signal: AbortSignal.timeout(Number(this.config.get('ALERT_TIMEOUT_MS', 10_000))),
      });
    } catch (err) {
      const e = err as { name?: string; message?: string; cause?: { message?: string } };
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error('Webhook timed out');
      throw new Error(`Webhook request failed: ${e.cause?.message ?? e.message ?? 'unknown error'}`);
    }
    await res.body?.cancel().catch(() => undefined);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Webhook responded with HTTP ${res.status}`);
    }
  }
}
