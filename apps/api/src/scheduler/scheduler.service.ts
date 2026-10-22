import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Queue } from 'bullmq';
import { Model } from 'mongoose';
import { Endpoint } from '../database/schemas/endpoint.schema.js';
import { bullConnection } from '../redis/redis-connection.js';
import { jitterOffsetMs, planReconcile } from './schedule-plan.js';

export const CHECKS_QUEUE = 'checks';
const REDIS_CALL_TIMEOUT_MS = 3_000;

export interface Schedulable {
  id: string;
  intervalSeconds: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Redis call timed out after ${ms}ms`)), ms).unref(),
    ),
  ]);
}

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SchedulerService.name);
  private queue?: Queue;
  private timer?: NodeJS.Timeout;
  readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    @InjectModel(Endpoint.name) private readonly endpoints: Model<Endpoint>,
  ) {
    this.enabled = config.get('SCHEDULER_ENABLED', 'true') !== 'false';
  }

  async onModuleInit() {
    if (!this.enabled) return;
    this.queue = new Queue(CHECKS_QUEUE, {
      connection: bullConnection(this.config.get('REDIS_URL', 'redis://localhost:6379')),
      prefix: this.config.get('QUEUE_PREFIX', 'apiwatch'),
    });
    this.queue.on('error', (err) => this.log.warn(`Queue error: ${err.message}`));

    await this.reconcile().catch((err) =>
      this.log.error(`Startup reconciliation failed: ${err.message}`),
    );

    // Safety net: repairs drift from a Redis flush or a failed schedule call.
    const everyMs = Number(this.config.get('RECONCILE_INTERVAL_SECONDS', 300)) * 1000;
    this.timer = setInterval(() => {
      this.reconcile().catch((err) => this.log.warn(`Reconciliation failed: ${err.message}`));
    }, everyMs);
    this.timer.unref();
  }

  async onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    await this.queue?.close();
  }

  /** Create or update the repeating job for an endpoint. Safe to call repeatedly. */
  async schedule(endpoint: Schedulable) {
    if (!this.queue) return;
    const everyMs = endpoint.intervalSeconds * 1000;
    await withTimeout(
      this.queue.upsertJobScheduler(
        endpoint.id,
        { every: everyMs, offset: jitterOffsetMs(endpoint.id, everyMs) },
        {
          name: 'check',
          data: { endpointId: endpoint.id },
          opts: { removeOnComplete: { count: 20 }, removeOnFail: { count: 100 }, attempts: 1 },
        },
      ),
      REDIS_CALL_TIMEOUT_MS,
    );
  }

  async unschedule(endpointId: string) {
    if (!this.queue) return;
    await withTimeout(this.queue.removeJobScheduler(endpointId), REDIS_CALL_TIMEOUT_MS);
  }

  /** Queue one check right away so a new endpoint shows a status without waiting a full interval. */
  async checkSoon(endpointId: string) {
    if (!this.queue) return;
    await withTimeout(
      this.queue.add(
        'check',
        { endpointId },
        { removeOnComplete: true, removeOnFail: { count: 100 }, attempts: 1 },
      ),
      REDIS_CALL_TIMEOUT_MS,
    );
  }

  /** Make the queue match the database: active endpoints scheduled, everything else removed. */
  async reconcile() {
    if (!this.queue) return { upserted: 0, removed: 0 };
    const [desired, schedulers] = await Promise.all([
      this.endpoints.find({ isActive: true }).select({ intervalSeconds: 1 }).lean(),
      this.queue.getJobSchedulers(0, -1),
    ]);
    const plan = planReconcile(
      desired.map((e) => ({ id: String(e._id), intervalSeconds: e.intervalSeconds })),
      schedulers.map((s) => ({ id: s.key, everyMs: s.every })),
    );
    for (const e of plan.upsert) await this.schedule(e);
    for (const id of plan.remove) await this.queue.removeJobScheduler(id);
    if (plan.upsert.length || plan.remove.length) {
      this.log.log(`Reconciled schedules: ${plan.upsert.length} upserted, ${plan.remove.length} removed`);
    }
    return { upserted: plan.upsert.length, removed: plan.remove.length };
  }
}
