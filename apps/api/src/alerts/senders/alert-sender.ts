import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildEmail, type AlertPayload } from '../alert-payload.js';
import { EmailService } from './email.service.js';
import { WebhookService } from './webhook.service.js';

/** Delivers one alert payload to one channel. Throws if it couldn't. */
@Injectable()
export class AlertSender {
  constructor(
    private readonly email: EmailService,
    private readonly webhook: WebhookService,
    private readonly config: ConfigService,
  ) {}

  async send(
    channel: { type: 'EMAIL' | 'WEBHOOK'; target: string; secret: string | null },
    payload: AlertPayload,
  ): Promise<void> {
    if (channel.type === 'EMAIL') {
      const appUrl = this.config.get<string>('APP_URL', 'http://localhost:3000');
      await this.email.send(channel.target, buildEmail(payload, appUrl));
    } else {
      await this.webhook.send(channel.target, channel.secret, payload);
    }
  }
}
