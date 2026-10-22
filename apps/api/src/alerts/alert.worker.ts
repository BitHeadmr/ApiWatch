import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Worker } from 'bullmq';
import { Model } from 'mongoose';
import { AlertChannel } from '../database/schemas/alert-channel.schema.js';
import { AlertLog } from '../database/schemas/alert-log.schema.js';
import { Endpoint } from '../database/schemas/endpoint.schema.js';
import { Incident } from '../database/schemas/incident.schema.js';
import { bullConnection } from '../redis/redis-connection.js';
import { buildPayload } from './alert-payload.js';
import { ALERTS_QUEUE } from './alerts.service.js';
import { AlertSender } from './senders/alert-sender.js';

/** Delivers queued alerts. Run it in its own process with RUN_ALERT_WORKER=true if you like. */
@Injectable()
export class AlertWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AlertWorker.name);
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly sender: AlertSender,
    @InjectModel(AlertLog.name) private readonly logs: Model<AlertLog>,
    @InjectModel(AlertChannel.name) private readonly channels: Model<AlertChannel>,
    @InjectModel(Incident.name) private readonly incidents: Model<Incident>,
    @InjectModel(Endpoint.name) private readonly endpoints: Model<Endpoint>,
  ) {}

  onModuleInit() {
    const on = (name: string) => this.config.get(name, 'true') !== 'false';
    if (!on('SCHEDULER_ENABLED') || !on('RUN_WORKER') || !on('RUN_ALERT_WORKER')) return;

    this.worker = new Worker(ALERTS_QUEUE, (job) => this.deliver(job.data.alertLogId), {
      connection: bullConnection(this.config.get('REDIS_URL', 'redis://localhost:6379')),
      prefix: this.config.get('QUEUE_PREFIX', 'apiwatch'),
      concurrency: Number(this.config.get('ALERT_CONCURRENCY', 5)),
    });
    this.worker.on('error', (err) => this.log.warn(`Alert worker error: ${err.message}`));
    this.worker.on('failed', (job, err) => {
      // BullMQ calls this after every failed attempt. Only the last one is final.
      const final = job && job.attemptsMade >= (job.opts.attempts ?? 1);
      if (job && final) {
        this.log.error(`Alert ${job.data.alertLogId} gave up after ${job.attemptsMade} attempts: ${err.message}`);
        void this.logs
          .updateOne({ _id: job.data.alertLogId, status: { $ne: 'SENT' } }, { $set: { status: 'FAILED', lastError: err.message } })
          .catch(() => undefined);
      }
    });
    this.log.log('Alert worker started');
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private async deliver(alertLogId: string) {
    const entry = await this.logs.findById(alertLogId);
    if (!entry || entry.status === 'SENT') return { skipped: true }; // already done: idempotent

    const channel = await this.channels.findById(entry.channelId).select('+secret');
    const incident = await this.incidents.findById(entry.incidentId);
    const endpoint = await this.endpoints.findById(entry.endpointId);
    if (!channel || !incident || !endpoint) {
      await this.logs.updateOne(
        { _id: entry._id },
        { $set: { status: 'FAILED', lastError: 'The channel, incident or endpoint no longer exists' } },
      );
      return { skipped: true };
    }

    await this.logs.updateOne({ _id: entry._id }, { $inc: { attempts: 1 } });
    try {
      await this.sender.send(
        { type: channel.type, target: channel.target, secret: channel.secret },
        buildPayload({
          event: entry.event,
          deliveryId: String(entry._id),
          endpoint: { id: endpoint.id, name: endpoint.name, url: endpoint.url },
          incident: {
            id: incident.id,
            status: incident.status,
            reason: incident.reason,
            errorMessage: incident.errorMessage,
            consecutiveFailures: incident.consecutiveFailures,
            startedAt: incident.startedAt,
            detectedAt: incident.detectedAt,
            resolvedAt: incident.resolvedAt,
            resolution: incident.resolution,
          },
        }),
      );
    } catch (err) {
      await this.logs.updateOne({ _id: entry._id }, { $set: { lastError: (err as Error).message } });
      throw err; // BullMQ retries with backoff
    }
    await this.logs.updateOne(
      { _id: entry._id },
      { $set: { status: 'SENT', sentAt: new Date(), lastError: null } },
    );
    return { sent: true };
  }
}
