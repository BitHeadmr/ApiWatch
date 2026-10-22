import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { isObjectId } from '../common/object-id.js';
import { CheckResult } from '../database/schemas/check-result.schema.js';
import { Endpoint } from '../database/schemas/endpoint.schema.js';
import { AlertsService } from '../alerts/alerts.service.js';

import type { IncidentDocument } from '../database/schemas/incident.schema.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { RedisService } from '../redis/redis.service.js';
import { performCheck } from './http-check.js';
import { applyOutcome, type Transition } from './status.js';
import type { CheckOutcome } from './types.js';
import { AlertEventName } from '../database/schemas/alert-log.schema.js';
import { EventsService } from '../events/events.service.js';

export type RunResult =
  | { status: 'skipped'; reason: 'not_found' | 'inactive' | 'already_running' }
  | {
      status: 'done';
      outcome: CheckOutcome;
      transition: Transition;
      /** 'opened' / 'resolved' only for the check that actually caused the incident change. */
      incident: 'opened' | 'resolved' | null;
      checkId: string;
    };

@Injectable()
export class CheckRunnerService {
  private readonly log = new Logger(CheckRunnerService.name);

  constructor(
    @InjectModel(Endpoint.name) private readonly endpoints: Model<Endpoint>,
    @InjectModel(CheckResult.name) private readonly checks: Model<CheckResult>,
    private readonly events: EventsService,
    private readonly incidents: IncidentsService,
    private readonly alerts: AlertsService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Runs one check for an endpoint and records it.
   * `force` is for manual "check now" requests, which also work on paused endpoints.
   */
  async run(
    endpointId: string,
    opts: { force?: boolean } = {},
  ): Promise<RunResult> {
    // A stale job can carry an id that was never valid; treat it as "gone", not an error.
    const endpoint = isObjectId(endpointId)
      ? await this.endpoints.findById(endpointId).lean()
      : null;
    if (!endpoint) return { status: 'skipped', reason: 'not_found' };
    const id = String(endpoint._id);
    if (!endpoint.isActive && !opts.force)
      return { status: 'skipped', reason: 'inactive' };

    // One check per endpoint at a time, across all worker processes. The TTL outlives the
    // request timeout, so a crashed worker can't block an endpoint for long.
    const lockKey = `lock:check:${id}`;
    let token: string | null = null;
    try {
      token = await this.redis.acquireLock(lockKey, endpoint.timeoutMs + 5_000);
      if (!token) return { status: 'skipped', reason: 'already_running' };
    } catch (err) {
      // Fail open: a Redis hiccup shouldn't stop monitoring.
      this.log.warn(
        `Could not take check lock for ${id}: ${(err as Error).message}`,
      );
    }

    try {
      const outcome = await performCheck({
        url: endpoint.url,
        method: endpoint.method,
        headers: endpoint.headers,
        body: endpoint.body,
        timeoutMs: endpoint.timeoutMs,
        expectedStatus: endpoint.expectedStatus,
        expectedBodyContains: endpoint.expectedBodyContains,
      });

      const checkedAt = new Date();
      const check = await this.checks.create({
        endpointId: endpoint._id,
        checkedAt,
        ...outcome,
      });

      // A manual check of a paused endpoint is recorded but changes nothing else.
      if (!endpoint.isActive) {
        this.publishCheck(endpoint, check, outcome, null);
        return {
          status: 'done',
          outcome,
          transition: null,
          incident: null,
          checkId: check.id,
        };
      }

      const { state, transition } = applyOutcome(
        {
          currentStatus: endpoint.currentStatus,
          consecutiveFailures: endpoint.consecutiveFailures,
        },
        outcome.success,
        endpoint.failureThreshold,
      );

      // MongoDB has no cross-collection transaction here (that needs a replica set), so the
      // writes are ordered so that a crash between any two of them is repaired by the next
      // check. The incident goes BEFORE the status update: if we die in between, the status is
      // still the old one, the next check computes the same transition again, and the
      // incident calls below are idempotent, so nothing is lost or duplicated.
      let incident: 'opened' | 'resolved' | null = null;
      let toAlert: { doc: IncidentDocument; event: AlertEventName } | null =
        null;
      if (state.currentStatus === 'DOWN') {
        // Called on every failing check while DOWN, not just the first, so a missing incident
        // heals itself. It's one cheap upsert that does nothing when the incident exists.
        const opened = await this.incidents.ensureOpen({
          teamId: String(endpoint.teamId),
          endpointId: id,
          endpointName: endpoint.name,
          outcome,
          consecutiveFailures: state.consecutiveFailures,
          detectedAt: checkedAt,
          lookUpStreakStart: transition === 'WENT_DOWN',
        });
        if (opened) {
          incident = 'opened';
          toAlert = { doc: opened, event: 'incident.opened' };
        }
      } else if (transition === 'RECOVERED') {
        const resolved = await this.incidents.resolve(
          id,
          checkedAt,
          'RECOVERED',
        );
        if (resolved) {
          incident = 'resolved';
          toAlert = { doc: resolved, event: 'incident.resolved' };
        }
      }

      // `isActive: true` in the filter stops a check that finished just after the endpoint
      // was paused from overwriting its PAUSED status.
      const update = await this.endpoints.updateOne(
        { _id: endpoint._id, isActive: true },
        { $set: { ...state, lastCheckedAt: checkedAt } },
      );
      if (update.matchedCount === 0) {
        await this.cleanUpAfterVanish(endpoint._id, id);
        incident = null;
        toAlert = null; // the endpoint was paused or deleted mid-check: nobody wants that alert
        this.publishCheck(endpoint, check, outcome, null);
      } else {
        this.publishCheck(endpoint, check, outcome, {
          ...state,
          lastCheckedAt: checkedAt,
        });
      }

      // Alerts go out only after everything above is settled. If this is skipped by a crash,
      // the periodic alert sweep notices the incident and sends it.
      if (toAlert) await this.alert(toAlert.doc, toAlert.event);

      if (transition) this.log.log(`${endpoint.name} (${id}): ${transition}`);
      return {
        status: 'done',
        outcome,
        transition,
        incident,
        checkId: check.id,
      };
    } finally {
      if (token) {
        await this.redis.releaseLock(lockKey, token).catch(() => undefined);
      }
    }
  }

  /**
   * The endpoint was paused or deleted while its check was in flight. Don't leave an incident
   * open for something that is no longer being monitored, or results for something that's gone.
   */
  private async cleanUpAfterVanish(endpointOid: Types.ObjectId, id: string) {
    if (await this.endpoints.exists({ _id: endpointOid })) {
      await this.incidents.resolve(id, new Date(), 'PAUSED');
    } else {
      await this.checks.deleteMany({ endpointId: endpointOid });
      await this.incidents.deleteForEndpoint(id);
    }
  }

  /** Queueing an alert must never fail the check itself. */
  private async alert(incident: IncidentDocument, event: AlertEventName) {
    try {
      await this.alerts.dispatch(incident, event);
    } catch (err) {
      this.log.error(
        `Could not dispatch ${event} alerts for incident ${incident.id}: ${(err as Error).message}`,
      );
    }
  }
  /**
   * Tells connected dashboards about a finished check. The status fields are included only when
   * the check actually changed the endpoint's state, so a browser never applies a stale one.
   */
  private publishCheck(
    endpoint: { _id: Types.ObjectId; teamId: Types.ObjectId },
    check: { id: string; checkedAt: Date },
    outcome: CheckOutcome,
    applied: {
      currentStatus: string;
      consecutiveFailures: number;
      lastCheckedAt: Date;
    } | null,
  ) {
    this.events.publish(String(endpoint.teamId), 'check', {
      endpointId: String(endpoint._id),
      checkId: check.id,
      checkedAt: check.checkedAt,
      success: outcome.success,
      statusCode: outcome.statusCode,
      responseTimeMs: outcome.responseTimeMs,
      failureReason: outcome.failureReason,
      errorMessage: outcome.errorMessage,
      ...(applied ?? {}),
    });
  }
}
