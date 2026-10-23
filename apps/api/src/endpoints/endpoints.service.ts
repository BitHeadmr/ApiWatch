import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CheckRunnerService } from '../checker/check-runner.service.js';
import { isObjectId } from '../common/object-id.js';
import { AlertChannel } from '../database/schemas/alert-channel.schema.js';
import { AlertLog } from '../database/schemas/alert-log.schema.js';
import { CheckResult } from '../database/schemas/check-result.schema.js';
import { Endpoint } from '../database/schemas/endpoint.schema.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { SchedulerService } from '../scheduler/scheduler.service.js';
import type { CreateEndpointDto } from './dto/create-endpoint.dto.js';
import type { UpdateEndpointDto } from './dto/update-endpoint.dto.js';
import { EventsService } from '../events/events.service.js';
import { assertTargetUrlAllowed, UnsafeTargetError } from '../checker/ssrf.js';

const MAX_HEADERS = 20;

@Injectable()
export class EndpointsService {
  private readonly log = new Logger(EndpointsService.name);
  private readonly minInterval: number;

  constructor(
    @InjectModel(Endpoint.name) private readonly endpoints: Model<Endpoint>,
    @InjectModel(CheckResult.name) private readonly checks: Model<CheckResult>,
    @InjectModel(AlertChannel.name)
    private readonly channels: Model<AlertChannel>,
    @InjectModel(AlertLog.name) private readonly alertLogs: Model<AlertLog>,
    private readonly scheduler: SchedulerService,
    private readonly runner: CheckRunnerService,
    private readonly incidents: IncidentsService,
    private readonly events: EventsService,
    config: ConfigService,
  ) {
    this.minInterval = Number(config.get('MIN_INTERVAL_SECONDS', 30));
  }

  list(teamId: string) {
    return this.endpoints.find({ teamId }).sort({ createdAt: -1 });
  }

  async get(teamId: string, id: string) {
    // Scoping by teamId means another team's endpoint looks exactly like a missing one.
    const endpoint = isObjectId(id)
      ? await this.endpoints.findOne({ _id: id, teamId })
      : null;
    if (!endpoint) throw new NotFoundException('Endpoint not found');
    return endpoint;
  }

  async create(teamId: string, dto: CreateEndpointDto) {
    this.validateTargetUrl(dto.url);
    this.validateRules(
      dto.intervalSeconds ?? 300,
      dto.timeoutMs ?? 10_000,
      dto.headers,
    );
    const { isActive = true, ...rest } = dto;
    const endpoint = await this.endpoints.create({
      ...rest,
      teamId,
      isActive,
      currentStatus: isActive ? 'UNKNOWN' : 'PAUSED',
    });
    if (endpoint.isActive)
      await this.syncSchedule(endpoint, { checkNow: true });
    this.broadcast(teamId, endpoint);
    return endpoint;
  }

  async update(teamId: string, id: string, dto: UpdateEndpointDto) {
    const current = await this.get(teamId, id);
    if (dto.url !== undefined) this.validateTargetUrl(dto.url);
    this.validateRules(
      dto.intervalSeconds ?? current.intervalSeconds,
      dto.timeoutMs ?? current.timeoutMs,
      dto.headers,
    );

    const { isActive, ...rest } = dto;
    const changes: Record<string, unknown> = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    if (isActive !== undefined && isActive !== current.isActive) {
      Object.assign(changes, this.activeState(isActive));
    }
    const updated = await this.endpoints.findByIdAndUpdate(
      current._id,
      { $set: changes },
      { returnDocument: 'after' },
    );
    if (!updated) throw new NotFoundException('Endpoint not found');
    if (current.isActive && !updated.isActive)
      await this.endMonitoringIncident(updated.id);
    // Picks up interval changes, and pause/resume done through PATCH.
    await this.syncSchedule(updated, {
      checkNow: updated.isActive && !current.isActive,
    });
    this.broadcast(teamId, updated);
    return updated;
  }

  async remove(teamId: string, id: string) {
    const current = await this.get(teamId, id);
    await this.endpoints.deleteOne({ _id: current._id });
    // MongoDB has no foreign-key cascades, so clean up the endpoint's history by hand.
    await this.checks.deleteMany({ endpointId: current._id });
    await this.incidents.deleteForEndpoint(current.id);
    await this.channels.deleteMany({ endpointId: current._id });
    await this.alertLogs.deleteMany({ endpointId: current._id });
    await this.guarded(() => this.scheduler.unschedule(current.id), current.id);
    this.events.publish(teamId, 'endpoint.deleted', { id: current.id });
  }

  async pause(teamId: string, id: string) {
    return this.setActive(teamId, id, false);
  }

  async resume(teamId: string, id: string) {
    return this.setActive(teamId, id, true);
  }

  /** Runs a check immediately and returns what it found. */
  async checkNow(teamId: string, id: string) {
    const current = await this.get(teamId, id);
    const res = await this.runner.run(current.id, { force: true });
    if (res.status === 'skipped') {
      throw new ConflictException(
        'A check for this endpoint is already running',
      );
    }
    return {
      ...res.outcome,
      id: res.checkId,
      transition: res.transition,
      incident: res.incident,
    };
  }

  async recentChecks(teamId: string, id: string, limit: number) {
    const current = await this.get(teamId, id);
    return this.checks
      .find({ endpointId: current._id })
      .sort({ checkedAt: -1 })
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  private async setActive(teamId: string, id: string, isActive: boolean) {
    const current = await this.get(teamId, id);
    const updated = await this.endpoints.findByIdAndUpdate(
      current._id,
      { $set: this.activeState(isActive) },
      { returnDocument: 'after' },
    );
    if (!updated) throw new NotFoundException('Endpoint not found');
    if (!isActive) await this.endMonitoringIncident(updated.id);
    await this.syncSchedule(updated, { checkNow: isActive });
    this.broadcast(teamId, updated);
    return updated;
  }
  /** Lets other open dashboards (other tabs, teammates) see the change without a refresh. */
  private broadcast(teamId: string, endpoint: { toJSON(): unknown }) {
    this.events.publish(teamId, 'endpoint.upserted', endpoint.toJSON());
  }
  /**
   * Pausing ends an open incident: nothing is being watched any more, so it can't recover or
   * continue. (If the endpoint is still failing when it's resumed, a new incident opens once
   * the threshold is crossed again.)
   */
  private async endMonitoringIncident(endpointId: string) {
    await this.incidents.resolve(endpointId, new Date(), 'PAUSED');
  }

  /** Status bookkeeping when an endpoint is paused or resumed. */
  private activeState(isActive: boolean) {
    return isActive
      ? {
          isActive: true,
          currentStatus: 'UNKNOWN' as const,
          consecutiveFailures: 0,
        }
      : {
          isActive: false,
          currentStatus: 'PAUSED' as const,
          consecutiveFailures: 0,
        };
  }

  /**
   * Keeps the queue in step with the database. A Redis problem must not fail the API
   * request (the row is already saved); the periodic reconciliation repairs any drift.
   */
  private async syncSchedule(
    endpoint: { id: string; isActive: boolean; intervalSeconds: number },
    opts: { checkNow?: boolean } = {},
  ) {
    await this.guarded(async () => {
      if (!endpoint.isActive) return this.scheduler.unschedule(endpoint.id);
      await this.scheduler.schedule(endpoint);
      if (opts.checkNow) await this.scheduler.checkSoon(endpoint.id);
    }, endpoint.id);
  }

  private async guarded(fn: () => Promise<unknown>, endpointId: string) {
    try {
      await fn();
    } catch (err) {
      this.log.warn(
        `Scheduling update for ${endpointId} failed: ${(err as Error).message}`,
      );
    }
  }

  private validateTargetUrl(input: string) {
    try {
      assertTargetUrlAllowed(input);
    } catch (err) {
      if (err instanceof UnsafeTargetError) throw new BadRequestException(err.message);
      throw new BadRequestException('Invalid target URL');
    }
  }

  private validateRules(
    intervalSeconds: number,
    timeoutMs: number,
    headers?: unknown,
  ) {
    if (intervalSeconds < this.minInterval) {
      throw new BadRequestException(
        `intervalSeconds must be at least ${this.minInterval}`,
      );
    }
    if (timeoutMs >= intervalSeconds * 1000) {
      throw new BadRequestException(
        'timeoutMs must be shorter than the check interval',
      );
    }
    if (headers !== undefined) {
      const entries = Object.entries(headers as Record<string, unknown>);
      if (entries.length > MAX_HEADERS) {
        throw new BadRequestException(
          `At most ${MAX_HEADERS} headers are allowed`,
        );
      }
      for (const [name, value] of entries) {
        // Header names are restricted to [A-Za-z0-9-], which also keeps them safe as Mongo keys.
        if (
          !/^[A-Za-z0-9-]+$/.test(name) ||
          typeof value !== 'string' ||
          value.length > 2000
        ) {
          throw new BadRequestException(`Invalid header "${name}"`);
        }
      }
    }
  }
}
