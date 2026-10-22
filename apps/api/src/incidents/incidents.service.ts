import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AlertLog } from '../database/schemas/alert-log.schema.js';
import { isObjectId } from '../common/object-id.js';
import type { CheckOutcome } from '../checker/types.js';
import { CheckResult } from '../database/schemas/check-result.schema.js';
import {
  Incident,
  type IncidentDocument,
  type IncidentResolution,
} from '../database/schemas/incident.schema.js';
import type { ListIncidentsDto } from './dto/list-incidents.dto.js';
import { EventsService } from '../events/events.service.js';

const DUPLICATE_KEY = 11000;
const EVIDENCE_LIMIT = 100;

/** Webhook URLs sometimes carry a secret token in the query string, so never echo that back. */
function maskTarget(type: string, target: string): string {
  if (type !== 'WEBHOOK') return target;
  try {
    const u = new URL(target);
    return `${u.origin}${u.pathname}`;
  } catch {
    return target;
  }
}

export interface OpenIncidentInput {
  teamId: string;
  endpointId: string;
  endpointName: string;
  outcome: CheckOutcome;
  consecutiveFailures: number;
  detectedAt: Date;
  /** True only on the check that crossed the threshold; lets us look up when the streak began. */
  lookUpStreakStart: boolean;
}

@Injectable()
export class IncidentsService {
  private readonly log = new Logger(IncidentsService.name);

  constructor(
    @InjectModel(Incident.name) private readonly incidents: Model<Incident>,
    @InjectModel(CheckResult.name) private readonly checks: Model<CheckResult>,
    @InjectModel(AlertLog.name) private readonly alertLogs: Model<AlertLog>,
    private readonly events: EventsService,
  ) {}

  /**
   * Makes sure the endpoint has an open incident. Safe to call any number of times, from any
   * number of workers: the single atomic upsert plus the unique index on `openFor` means
   * exactly one incident is ever created. Returns the new incident only to the call that
   * created it (that call is the one that sends alerts), and null to everyone else.
   */
  async ensureOpen(input: OpenIncidentInput): Promise<IncidentDocument | null> {
    const endpointOid = new Types.ObjectId(input.endpointId);
    const startedAt = input.lookUpStreakStart
      ? await this.streakStart(
          endpointOid,
          input.consecutiveFailures,
          input.detectedAt,
        )
      : input.detectedAt;

    try {
      const res = await this.incidents.updateOne(
        { openFor: endpointOid },
        {
          $setOnInsert: {
            teamId: new Types.ObjectId(input.teamId),
            endpointId: endpointOid,
            endpointName: input.endpointName,
            status: 'OPEN',
            reason: input.outcome.failureReason,
            errorMessage: input.outcome.errorMessage,
            consecutiveFailures: input.consecutiveFailures,
            startedAt,
            detectedAt: input.detectedAt,
            resolvedAt: null,
            resolution: null,
          },
        },
        { upsert: true },
      );
      if (res.upsertedCount === 0) return null;
      this.log.warn(
        `Incident opened for ${input.endpointName} (${input.endpointId})`,
      );
      const incident = await this.incidents.findById(res.upsertedId);
      if (incident)
        this.events.publish(input.teamId, 'incident.opened', incident.toJSON());
      return incident;
    } catch (err) {
      // Two workers raced to open the same incident and the other one won. That's fine.
      if ((err as { code?: number }).code === DUPLICATE_KEY) return null;
      throw err;
    }
  }

  /** Closes the endpoint's open incident, if any, and returns it. Null if there was none. */
  async resolve(
    endpointId: string,
    resolvedAt: Date,
    resolution: IncidentResolution,
  ): Promise<IncidentDocument | null> {
    const closed = await this.incidents.findOneAndUpdate(
      { openFor: new Types.ObjectId(endpointId) },
      {
        $set: { status: 'RESOLVED', resolvedAt, resolution },
        $unset: { openFor: '' },
      },
      { returnDocument: 'after' },
    );
    if (closed) {
      this.log.log(
        `Incident resolved (${resolution}) for endpoint ${endpointId}`,
      );
      this.events.publish(
        String(closed.teamId),
        'incident.resolved',
        closed.toJSON(),
      );
    }
    return closed;
  }

  /** Incidents have no meaning without their endpoint, so they go when it goes. */
  async deleteForEndpoint(endpointId: string) {
    await this.incidents.deleteMany({
      endpointId: new Types.ObjectId(endpointId),
    });
  }

  list(teamId: string, q: ListIncidentsDto) {
    const filter: Record<string, unknown> = { teamId };
    if (q.status) filter.status = q.status.toUpperCase();
    if (q.endpointId) filter.endpointId = q.endpointId;
    return this.incidents
      .find(filter)
      .sort({ startedAt: -1 })
      .limit(q.limit ?? 50);
  }

  async get(teamId: string, id: string) {
    const incident = isObjectId(id)
      ? await this.incidents.findOne({ _id: id, teamId })
      : null;
    if (!incident) throw new NotFoundException('Incident not found');
    return incident;
  }

  /** The incident plus the failing checks that happened during it. */
  async getWithEvidence(teamId: string, id: string) {
    const incident = await this.get(teamId, id);
    const until = incident.resolvedAt ?? new Date();
    const failedChecks = await this.checks
      .find({
        endpointId: incident.endpointId,
        success: false,
        checkedAt: { $gte: incident.startedAt, $lte: until },
      })
      .sort({ checkedAt: 1 })
      .limit(EVIDENCE_LIMIT);
    const alerts = await this.alertLogs
      .find({ incidentId: incident._id })
      .sort({ createdAt: 1 });
    return {
      ...incident.toJSON(),
      failedChecks: failedChecks.map((c) => c.toJSON()),
      alerts: alerts.map((a) => ({
        id: a.id,
        event: a.event,
        channelType: a.channelType,
        target: maskTarget(a.channelType, a.target),
        status: a.status,
        attempts: a.attempts,
        lastError: a.lastError,
        createdAt: a.createdAt,
        sentAt: a.sentAt,
      })),
    };
  }

  /** Time of the oldest failure in the current streak (the newest N checks, N = failures in a row). */
  private async streakStart(
    endpointId: Types.ObjectId,
    failures: number,
    fallback: Date,
  ) {
    const streak = await this.checks
      .find({ endpointId })
      .sort({ checkedAt: -1 })
      .limit(Math.max(1, failures))
      .select({ checkedAt: 1 })
      .lean();
    const oldest = streak.at(-1)?.checkedAt;
    return oldest && oldest <= fallback ? oldest : fallback;
  }
}
