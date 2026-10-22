import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Worker } from 'bullmq';
import { CheckRunnerService } from '../checker/check-runner.service.js';
import { bullConnection } from '../redis/redis-connection.js';
import { CHECKS_QUEUE } from './scheduler.service.js';

/**
 * Pulls check jobs off the queue and runs them, up to CHECK_CONCURRENCY at a time.
 * RUN_WORKER=false turns every worker off; RUN_CHECK_WORKER=false turns off just this one.
 * Use them to run the API and the workers as separate processes.
 */
@Injectable()
export class CheckWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CheckWorker.name);
  private worker?: Worker;

  constructor(
    private readonly config: ConfigService,
    private readonly runner: CheckRunnerService,
  ) {}

  onModuleInit() {
    const on = (name: string) => this.config.get(name, 'true') !== 'false';
    const enabled =
      on('SCHEDULER_ENABLED') && on('RUN_WORKER') && on('RUN_CHECK_WORKER');
    if (!enabled) return;

    this.worker = new Worker(
      CHECKS_QUEUE,
      async (job) => {
        // A failing endpoint is a recorded result, not a failed job. Only infrastructure
        // problems (database down, ...) throw here.
        const res = await this.runner.run(job.data.endpointId);
        return res.status === 'done'
          ? { success: res.outcome.success }
          : { skipped: res.reason };
      },
      {
        connection: bullConnection(
          this.config.get('REDIS_URL', 'redis://localhost:6379'),
        ),
        prefix: this.config.get('QUEUE_PREFIX', 'apiwatch'),
        concurrency: Number(this.config.get('CHECK_CONCURRENCY', 20)),
      },
    );
    this.worker.on('error', (err) =>
      this.log.warn(`Worker error: ${err.message}`),
    );
    this.worker.on('failed', (job, err) =>
      this.log.error(`Check job ${job?.id} failed: ${err.message}`),
    );
    this.log.log(
      `Check worker started (concurrency ${this.worker.opts.concurrency})`,
    );
  }

  /** Graceful shutdown: waits for in-flight checks to finish before closing. */
  async onModuleDestroy() {
    await this.worker?.close();
  }
}
