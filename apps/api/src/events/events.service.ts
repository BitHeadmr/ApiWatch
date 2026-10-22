import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import {
  filter,
  interval,
  map,
  merge,
  Observable,
  startWith,
  Subject,
} from 'rxjs';

export type LiveEventType =
  | 'check'
  | 'incident.opened'
  | 'incident.resolved'
  | 'endpoint.upserted'
  | 'endpoint.deleted';

interface Envelope {
  teamId: string;
  type: LiveEventType;
  data: unknown;
}

/**
 * Real-time events for the dashboard.
 *
 * Workers (which may run in a different process from the API) publish events to a Redis
 * pub/sub channel; every API process subscribes and relays them to the browsers connected
 * to it over Server-Sent Events, filtered to each browser's own team.
 *
 * Publishing is fire-and-forget: a live-update hiccup must never fail a check, and the
 * dashboard re-syncs from the REST API whenever it reconnects.
 */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(EventsService.name);
  private pub?: Redis;
  private sub?: Redis;
  private readonly bus = new Subject<Envelope>();
  private readonly channel: string;
  readonly enabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.enabled = config.get('SCHEDULER_ENABLED', 'true') !== 'false';
    this.channel = `${config.get('QUEUE_PREFIX', 'apiwatch')}:events`;
  }

  onModuleInit() {
    if (!this.enabled) return;
    const url = this.config.get<string>('REDIS_URL', 'redis://localhost:6379');

    // Fail fast instead of buffering publishes while Redis is down.
    this.pub = new Redis(url, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    this.pub.on('error', () => undefined);

    this.sub = new Redis(url, { maxRetriesPerRequest: null });
    this.sub.on('error', (err) =>
      this.log.warn(`Event subscriber error: ${err.message}`),
    );
    this.sub.on('message', (_channel, raw) => {
      try {
        this.bus.next(JSON.parse(raw) as Envelope);
      } catch {
        /* ignore a malformed message */
      }
    });
    void this.sub
      .subscribe(this.channel)
      .catch((err) => this.log.warn(`Subscribe failed: ${err.message}`));
  }

  async onModuleDestroy() {
    this.bus.complete();
    this.pub?.disconnect();
    this.sub?.disconnect();
  }

  /** Tell every browser of this team that something changed. Never throws. */
  publish(teamId: string, type: LiveEventType, data: unknown): void {
    if (!this.pub) return;
    const envelope: Envelope = { teamId, type, data };
    this.pub
      .publish(this.channel, JSON.stringify(envelope))
      .catch(() => undefined);
  }

  /** The SSE stream for one team: a `ready` event, then live events, plus a heartbeat. */
  stream(teamId: string): Observable<MessageEvent> {
    const heartbeatMs = Number(this.config.get('SSE_HEARTBEAT_MS', 20_000));
    const events = this.bus.pipe(
      filter((e) => e.teamId === teamId),
      map((e): MessageEvent => ({ type: e.type, data: e.data as object })),
    );
    const heartbeat = interval(heartbeatMs).pipe(
      map((): MessageEvent => ({
        type: 'ping',
        data: { at: new Date().toISOString() },
      })),
    );
    return merge(events, heartbeat).pipe(
      // Sent immediately so the browser knows the stream is open (this also flushes the headers).
      startWith<MessageEvent>({
        type: 'ready',
        data: { at: new Date().toISOString() },
      }),
    );
  }
}
