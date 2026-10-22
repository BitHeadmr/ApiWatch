import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CheckResult } from '../database/schemas/check-result.schema.js';
import { Endpoint } from '../database/schemas/endpoint.schema.js';

export const WINDOW_HOURS = 24;
export const RECENT_CHECKS = 30;

export interface RecentCheck {
  ok: boolean;
  /** Response time in ms, or null when no response arrived. */
  ms: number | null;
  at: string;
}

export interface EndpointStats {
  /** Checks in the last 24 hours. */
  checks24h: number;
  /** Percentage of those that succeeded, or null if there were none. */
  uptime24h: number | null;
  /** The last 30 checks, oldest first. Drives the heartbeat strip. */
  recent: RecentCheck[];
  /** Average response time of the successful checks among `recent`. */
  recentAvgResponseMs: number | null;
}

@Injectable()
export class StatsService {
  constructor(
    @InjectModel(Endpoint.name) private readonly endpoints: Model<Endpoint>,
    @InjectModel(CheckResult.name) private readonly checks: Model<CheckResult>,
  ) {}

  /**
   * Everything the overview needs, for every endpoint of a team, in one round trip.
   *
   * Uptime comes from one grouped count over the last 24 hours. The recent checks come from one
   * small indexed query per endpoint, run in parallel. (Both stick to features that every
   * MongoDB-compatible server supports; full time-bucketed statistics arrive in Phase 6.)
   */
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

  private async recentFor(endpointId: Types.ObjectId): Promise<RecentCheck[]> {
    const rows = await this.checks
      .find({ endpointId })
      .sort({ checkedAt: -1 })
      .limit(RECENT_CHECKS)
      .select({ success: 1, responseTimeMs: 1, checkedAt: 1 })
      .lean();
    return rows
      .reverse()
      .map((r) => ({
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
