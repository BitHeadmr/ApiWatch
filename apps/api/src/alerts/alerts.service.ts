import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Model, Types } from 'mongoose';
import { AlertChannel } from '../database/schemas/alert-channel.schema.js';
import { AlertLog, type AlertEventName } from '../database/schemas/alert-log.schema.js';
import { Incident } from '../database/schemas/incident.schema.js';
import { bullConnection } from '../redis/redis-connection.js';

export const ALERTS_QUEUE = 'alerts';
const DUPLICATE_KEY = 11000;
const SWEEP_WINDOW_MS = 60 * 60_000; // incidents newer than this are checked for missing alerts
const STUCK_PENDING_MS = 2 * 60_000; // a PENDING alert older than this probably lost its job

export interface AlertableIncident {
  _id: Types.ObjectId;
  teamId: Types.ObjectId;
  endpointId: Types.ObjectId;
  detectedAt: Date;
  resolvedAt: Date | null;
}

/**
 * Turns "an incident opened/resolved" into one queued delivery per channel.
 *
 * Reliability model:
 *  - One AlertLog row per (incident, channel, event), enforced by a unique index, so asking to
 *    alert the same thing twice (a retry, a race, the sweeper) can never produce two alerts.
 *  - Delivery is a queued job with retries and exponential backoff.
 *  - A periodic sweep repairs the two gaps a crash can leave: an incident that was never
 *    dispatched, and an alert whose job was lost. Delivery is therefore at-least-once; each
 *    delivery carries a unique `deliveryId` so receivers can drop a repeat.
 */
@Injectable()
export class AlertsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AlertsService.name);
  private queue?: Queue;
  private timer?: NodeJS.Timeout;
  readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    @InjectModel(AlertChannel.name) private readonly channels: Model<AlertChannel>,
    @InjectModel(AlertLog.name) private readonly logs: Model<AlertLog>,
    @InjectModel(Incident.name) private readonly incidents: Model<Incident>,
  ) {
    this.enabled = config.get('SCHEDULER_ENABLED', 'true') !== 'false';
  }

  async onModuleInit() {
    if (!this.enabled) return;
    this.queue = new Queue(ALERTS_QUEUE, {
      connection: bullConnection(this.config.get('REDIS_URL', 'redis://localhost:6379')),
      prefix: this.config.get('QUEUE_PREFIX', 'apiwatch'),
    });
    this.queue.on('error', (err) => this.log.warn(`Alerts queue error: ${err.message}`));

    await this.sweep().catch((err) => this.log.error(`Startup alert sweep failed: ${err.message}`));
    const everyMs = Number(this.config.get('RECONCILE_INTERVAL_SECONDS', 300)) * 1000;
    this.timer = setInterval(() => {
      this.sweep().catch((err) => this.log.warn(`Alert sweep failed: ${err.message}`));
    }, everyMs);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.queue?.close();
  }

  /**
   * Queue an alert for the endpoint's channels. Idempotent.
   *  - "opened" goes to every channel that existed when the incident was detected, so a channel
   *    added later isn't alerted retroactively.
   *  - "resolved" goes only to channels that were told about the outage, so nobody gets a
   *    "recovered" message for something they never heard was down.
   */
  async dispatch(incident: AlertableIncident, event: AlertEventName): Promise<number> {
    if (!this.enabled) return 0;
    let channels;
    if (event === 'incident.opened') {
      channels = await this.channels
        .find({ endpointId: incident.endpointId, createdAt: { $lte: incident.detectedAt } })
        .lean();
    } else {
      const told = await this.logs.distinct('channelId', {
        incidentId: incident._id,
        event: 'incident.opened',
      });
      channels = await this.channels.find({ _id: { $in: told } }).lean();
    }

    let queued = 0;
    for (const channel of channels) {
      try {
        const res = await this.logs.updateOne(
          { incidentId: incident._id, channelId: channel._id, event },
          {
            $setOnInsert: {
              teamId: incident.teamId,
              endpointId: incident.endpointId,
              channelType: channel.type,
              target: channel.target,
              status: 'PENDING',
              attempts: 0,
              lastError: null,
              sentAt: null,
              createdAt: new Date(),
            },
          },
          { upsert: true },
        );
        if (res.upsertedCount > 0 && res.upsertedId) {
          await this.enqueue(String(res.upsertedId));
          queued++;
        }
      } catch (err) {
        if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err; // lost a race: fine
      }
    }
    return queued;
  }

  /** Put a delivery job on the queue. A failure here is not fatal: the sweep re-queues it. */
  async enqueue(alertLogId: string) {
    if (!this.queue) return;
    try {
      await this.queue.add(
        'deliver',
        { alertLogId },
        {
          jobId: `alert-${alertLogId}`, // one job per alert, even if enqueued twice
          attempts: Number(this.config.get('ALERT_ATTEMPTS', 5)),
          backoff: { type: 'exponential', delay: Number(this.config.get('ALERT_BACKOFF_MS', 5000)) },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 200 },
        },
      );
    } catch (err) {
      this.log.warn(`Could not queue alert ${alertLogId}: ${(err as Error).message}`);
    }
  }

  /** Repairs anything a crash or a Redis flush left behind. Safe to run at any time. */
  async sweep() {
    if (!this.enabled) return { dispatched: 0, requeued: 0 };
    const since = new Date(Date.now() - SWEEP_WINDOW_MS);
    let dispatched = 0;

    const recent = await this.incidents
      .find({ $or: [{ detectedAt: { $gte: since } }, { resolvedAt: { $gte: since } }] })
      .limit(200)
      .lean();
    for (const incident of recent) {
      dispatched += await this.dispatch(incident, 'incident.opened');
      // Only a real recovery is worth a "recovered" alert. Pausing isn't one.
      if (incident.status === 'RESOLVED' && incident.resolution === 'RECOVERED') {
        dispatched += await this.dispatch(incident, 'incident.resolved');
      }
    }

    const stuck = await this.logs
      .find({ status: 'PENDING', createdAt: { $lt: new Date(Date.now() - STUCK_PENDING_MS) } })
      .limit(200)
      .select({ _id: 1 })
      .lean();
    for (const row of stuck) await this.enqueue(String(row._id));

    if (dispatched || stuck.length) {
      this.log.log(`Alert sweep: ${dispatched} newly dispatched, ${stuck.length} re-queued`);
    }
    return { dispatched, requeued: stuck.length };
  }
}
