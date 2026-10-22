import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EmailContent } from '../alert-payload.js';

type Transporter = { sendMail(message: Record<string, unknown>): Promise<unknown> };

/**
 * Sends email through the provider named by EMAIL_PROVIDER:
 *   log     (default) prints the email to the console. Zero setup, good for development.
 *   smtp    any SMTP server (Gmail app password, Mailtrap, SES, ...) via nodemailer.
 *   resend  the Resend HTTP API.
 */
@Injectable()
export class EmailService {
  private readonly log = new Logger(EmailService.name);
  private transporter?: Promise<Transporter>;

  constructor(private readonly config: ConfigService) {}

  get provider(): string {
    return this.config.get<string>('EMAIL_PROVIDER', 'log');
  }

  async send(to: string, content: EmailContent): Promise<void> {
    const from = this.config.get<string>('EMAIL_FROM', 'APIWatch <alerts@localhost>');
    switch (this.provider) {
      case 'smtp':
        await (await this.smtp()).sendMail({ from, to, ...content });
        return;
      case 'resend':
        await this.resend(from, to, content);
        return;
      case 'log':
        this.log.log(`[email:log] to=${to}\nsubject: ${content.subject}\n${content.text}`);
        return;
      default:
        throw new Error(`Unknown EMAIL_PROVIDER "${this.provider}" (use log, smtp or resend)`);
    }
  }

  private smtp(): Promise<Transporter> {
    // Loaded lazily so the app starts even if nodemailer isn't installed and SMTP isn't used.
    this.transporter ??= import('nodemailer').then(({ default: nodemailer }) => {
      const host = this.config.get<string>('SMTP_HOST');
      if (!host) throw new Error('EMAIL_PROVIDER=smtp needs SMTP_HOST');
      const user = this.config.get<string>('SMTP_USER');
      return nodemailer.createTransport({
        host,
        port: Number(this.config.get('SMTP_PORT', 587)),
        secure: this.config.get('SMTP_SECURE', 'false') === 'true', // true for port 465
        ignoreTLS: this.config.get('SMTP_INSECURE', 'false') === 'true', // local test servers only
        auth: user ? { user, pass: this.config.get<string>('SMTP_PASS') } : undefined,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });
    });
    return this.transporter;
  }

  private async resend(from: string, to: string, content: EmailContent) {
    const key = this.config.get<string>('RESEND_API_KEY');
    if (!key) throw new Error('EMAIL_PROVIDER=resend needs RESEND_API_KEY');
    const url = this.config.get<string>('RESEND_API_URL', 'https://api.resend.com/emails');
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], ...content }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Resend responded with HTTP ${res.status} ${detail}`.trim());
    }
  }
}
