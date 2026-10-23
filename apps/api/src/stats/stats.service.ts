import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CheckResult } from '../database/schemas/check-result.schema.js';
import { Endpoint } from '../database/schemas/endpoint.schema.js';
import { StatsRollup } from '../database/schemas/stats-rollup.schema.js';

export const WINDOW_HOURS = 24;
export const RECENT_CHECKS = 30;
const DAY_MS = 86_400_000;
const RETENTION_DAYS = 7;
const ROLLUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface RecentCheck {
  ok: boolean;
  ms: number | null;
  at: string;
}
export interface EndpointStats {
  checks24h: number;
  uptime24h: number | null;
  recent: RecentCheck[];
  recentAvgResponseMs: number | null;
}

@Injectable()
export class StatsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(StatsService.name);
  private retentionTimer?: NodeJS.Timeout;

  constructor(
    @InjectModel(Endpoint.name) private readonly endpoints: Model<Endpoint>,
    @InjectModel(CheckResult.name) private readonly checks: Model<CheckResult>,
    @InjectModel(StatsRollup.name) private readonly rollups: Model<StatsRollup>,
  ) {}

  onModuleInit() {
    // Run once at startup, then nightly. The operation is idempotent per endpoint/hour.
    void this.runRetention().catch((err: Error) =>
      this.log.error(`Initial retention failed: ${err.message}`),
    );
    this.retentionTimer = setInterval(() => {
      void this.runRetention().catch((err: Error) =>
        this.log.error(`Retention failed: ${err.message}`),
      );
    }, ROLLUP_INTERVAL_MS);
    this.retentionTimer.unref();
  }

  onModuleDestroy() {
    if (this.retentionTimer) clearInterval(this.retentionTimer);
  }

  async overview(teamId: string) {
    const ids = (
      await this.endpoints.find({ teamId }).select({ _id: 1 }).lean()
    ).map((e) => e._id);
    const since = new Date(Date.now() - WINDOW_HOURS * 3_600_000);
    const [counts, recents] = await Promise.all([
      ids.length
        ? this.checks.aggregate<{
            _id: { endpointId: Types.ObjectId; success: boolean };
            n: number;
          }>([
            {
              $match: { endpointId: { $in: ids }, checkedAt: { $gte: since } },
            },
            {
              $group: {
                _id: { endpointId: '$endpointId', success: '$success' },
                n: { $sum: 1 },
              },
            },
          ])
        : [],
      Promise.all(ids.map((id) => this.recentFor(id))),
    ]);
    const tally = new Map<string, { ok: number; failed: number }>();
    for (const row of counts) {
      const key = String(row._id.endpointId);
      const t = tally.get(key) ?? { ok: 0, failed: 0 };
      if (row._id.success) t.ok += row.n;
      else t.failed += row.n;
      tally.set(key, t);
    }
    const result: Record<string, EndpointStats> = {};
    ids.forEach((id, i) => {
      const t = tally.get(String(id)) ?? { ok: 0, failed: 0 };
      const total = t.ok + t.failed;
      const recent = recents[i];
      result[String(id)] = {
        checks24h: total,
        uptime24h: total ? Math.round((t.ok / total) * 10_000) / 100 : null,
        recent,
        recentAvgResponseMs: averageOf(recent),
      };
    });
    return { windowHours: WINDOW_HOURS, endpoints: result };
  }

  /** Historical summary and downsampled chart points for one endpoint. */
  async history(teamId: string, endpointId: string, range: '24h' | '7d') {
    if (!Types.ObjectId.isValid(endpointId))
      throw new NotFoundException('Endpoint not found');
    const endpoint = await this.endpoints
      .findOne({ _id: endpointId, teamId })
      .select({ _id: 1 })
      .lean();
    if (!endpoint) throw new NotFoundException('Endpoint not found');
    const now = Date.now();
    const duration = range === '24h' ? DAY_MS : 7 * DAY_MS;
    const bucketMs = range === '24h' ? 5 * 60_000 : 60 * 60_000;
    const since = new Date(now - duration);
    const id = new Types.ObjectId(endpointId);
    const rows = await this.checks.aggregate<{
      _id: Date;
      total: number;
      successes: number;
      avgMs: number | null;
      failures: number;
    }>([
      {
        $match: {
          endpointId: id,
          checkedAt: { $gte: since, $lte: new Date(now) },
        },
      },
      {
        $group: {
          _id: {
            $toDate: {
              $subtract: [
                { $toLong: '$checkedAt' },
                { $mod: [{ $toLong: '$checkedAt' }, bucketMs] },
              ],
            },
          },
          total: { $sum: 1 },
          successes: { $sum: { $cond: ['$success', 1, 0] } },
          failures: { $sum: { $cond: ['$success', 0, 1] } },
          avgMs: {
            $avg: {
              $cond: [
                { $and: ['$success', { $ne: ['$responseTimeMs', null] }] },
                '$responseTimeMs',
                null,
              ],
            },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]);
    const points = rows.map((r) => ({
      at: new Date(r._id).toISOString(),
      checks: r.total,
      failures: r.failures,
      uptime: r.total
        ? Math.round((r.successes / r.total) * 10_000) / 100
        : null,
      avgResponseMs: r.avgMs === null ? null : Math.round(r.avgMs),
    }));
    const summary = await this.checks.aggregate<{
      _id: null;
      checks: number;
      successes: number;
      avgMs: number | null;
    }>([
      {
        $match: {
          endpointId: id,
          checkedAt: { $gte: since, $lte: new Date(now) },
        },
      },
      {
        $group: {
          _id: null,
          checks: { $sum: 1 },
          successes: { $sum: { $cond: ['$success', 1, 0] } },
          avgMs: {
            $avg: {
              $cond: [
                { $and: ['$success', { $ne: ['$responseTimeMs', null] }] },
                '$responseTimeMs',
                null,
              ],
            },
          },
        },
      },
    ]);
    // Exact p95 over the selected window. Only numeric successful response times are included.

    const responseRows = await this.checks
      .find({
        endpointId: id,
        checkedAt: {
          $gte: since,
          $lte: new Date(now),
        },
        success: true,
      })
      .sort({ responseTimeMs: 1 })
      .lean();

    const values: number[] = responseRows
      .map((r) => r.responseTimeMs)
      .filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value),
      );

    const s = summary[0];
    return {
      range,
      from: since.toISOString(),
      to: new Date(now).toISOString(),
      bucketMinutes: bucketMs / 60_000,
      summary: {
        checks: s?.checks ?? 0,
        uptime: s?.checks
          ? Math.round((s.successes / s.checks) * 10_000) / 100
          : null,
        avgResponseMs: s?.avgMs == null ? null : Math.round(s.avgMs),
        p95ResponseMs: values.length
          ? values[
              Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)
            ]
          : null,
      },
      points,
    };
  }

  /** Aggregate raw results older than seven days into unique hourly rollups, then prune raw data. */
  async runRetention(now = new Date()) {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
    const eligible = await this.checks.aggregate<{
      _id: { endpointId: Types.ObjectId; hour: Date };
      total: number;
      successes: number;
      responseTotal: number;
      responseCount: number;
    }>([
      { $match: { checkedAt: { $lt: cutoff } } },
      {
        $group: {
          _id: {
            endpointId: '$endpointId',
            hour: {
              $toDate: {
                $subtract: [
                  { $toLong: '$checkedAt' },
                  { $mod: [{ $toLong: '$checkedAt' }, 3_600_000] },
                ],
              },
            },
          },
          total: { $sum: 1 },
          successes: { $sum: { $cond: ['$success', 1, 0] } },
          responseTotal: {
            $sum: {
              $cond: [
                { $and: ['$success', { $ne: ['$responseTimeMs', null] }] },
                '$responseTimeMs',
                0,
              ],
            },
          },
          responseCount: {
            $sum: {
              $cond: [
                { $and: ['$success', { $ne: ['$responseTimeMs', null] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]);
    if (eligible.length) {
      await this.rollups.bulkWrite(
        eligible.map((r) => ({
          updateOne: {
            filter: { endpointId: r._id.endpointId, bucketStart: r._id.hour },
            update: {
              $set: {
                totalChecks: r.total,
                successfulChecks: r.successes,
                responseTimeTotalMs: r.responseTotal,
                responseTimeCount: r.responseCount,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      await this.checks.deleteMany({ checkedAt: { $lt: cutoff } });
      this.log.log(
        `Rolled up ${eligible.length} endpoint-hour buckets and pruned raw checks before ${cutoff.toISOString()}`,
      );
    }
    return { buckets: eligible.length, cutoff };
  }

  private async recentFor(endpointId: Types.ObjectId): Promise<RecentCheck[]> {
    const rows = await this.checks
      .find({ endpointId })
      .sort({ checkedAt: -1 })
      .limit(RECENT_CHECKS)
      .select({ success: 1, responseTimeMs: 1, checkedAt: 1 })
      .lean();
    return rows.reverse().map((r) => ({
      ok: r.success,
      ms: r.responseTimeMs ?? null,
      at: r.checkedAt.toISOString(),
    }));
  }
}

function averageOf(recent: RecentCheck[]): number | null {
  const times = recent
    .filter((r) => r.ok && r.ms !== null)
    .map((r) => r.ms as number);
  return times.length
    ? Math.round(times.reduce((a, b) => a + b, 0) / times.length)
    : null;
}
