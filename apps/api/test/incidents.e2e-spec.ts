import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { type Connection, Types } from 'mongoose';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { IncidentsService } from '../src/incidents/incidents.service.js';
import { RedisService } from '../src/redis/redis.service.js';
import { mongoIsUp, throwawayMongoUri } from './mongo.js';

process.env.JWT_SECRET = 'test-secret';
process.env.SCHEDULER_ENABLED = 'false'; // checks are driven by hand via check-now
process.env.MONGODB_URI = throwawayMongoUri('incidents');

const hasMongo = await mongoIsUp();
if (!hasMongo)
  console.warn('\n[incidents e2e] MongoDB not reachable; skipping.\n');

const fakeRedis = {
  ping: async () => true,
  acquireLock: async () => 'token',
  releaseLock: async () => undefined,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasMongo)('incidents (real MongoDB)', () => {
  let app: INestApplication;
  let api: ReturnType<typeof request>;
  let db: Connection;
  let service: IncidentsService;
  let target: http.Server;
  let targetUrl: string;
  let mode: 'up' | 'down' | 'slow-down' = 'up';
  let token: string;
  let teamId: string;
  let counter = 0;

  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    target = http.createServer((_req, res) => {
      if (mode === 'up') return void res.writeHead(200).end('ok');
      if (mode === 'down') return void res.writeHead(503).end('down');
      setTimeout(() => res.writeHead(503).end('down'), 500); // slow-down
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}/`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisService)
      .useValue(fakeRedis)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    api = request(app.getHttpServer());
    db = app.get<Connection>(getConnectionToken());
    service = app.get(IncidentsService);

    const reg = await api
      .post('/api/v1/auth/register')
      .send({
        email: 'inc@example.com',
        password: 'password123',
        teamName: 'Incidents',
      });
    token = reg.body.accessToken;
    teamId = reg.body.user.teamId;
  });

  afterAll(async () => {
    await db.dropDatabase();
    await app.close();
    target.closeAllConnections();
    target.close();
  });

  beforeEach(() => {
    mode = 'up';
  });

  const create = async (over: Record<string, unknown> = {}) => {
    const res = await api
      .post('/api/v1/endpoints')
      .set(auth())
      .send({
        name: `EP ${++counter}`,
        url: targetUrl,
        failureThreshold: 3,
        ...over,
      });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  const check = async (id: string) => {
    const res = await api.post(`/api/v1/endpoints/${id}/check-now`).set(auth());
    expect(res.status).toBe(200);
    return res.body as {
      success: boolean;
      transition: string | null;
      incident: string | null;
    };
  };
  const checks = async (n: number, id: string, m: typeof mode) => {
    mode = m;
    const out = [];
    for (let i = 0; i < n; i++) out.push(await check(id));
    return out;
  };
  const list = async (query = '', t = token) =>
    (await api.get(`/api/v1/incidents${query}`).set(auth(t))).body as Array<
      Record<string, any>
    >;
  const forEndpoint = (id: string, status?: string) =>
    list(`?endpointId=${id}${status ? `&status=${status}` : ''}`);

  it('does not open an incident before the threshold, and opens exactly one at it', async () => {
    const id = await create({ failureThreshold: 3 });
    const first = await checks(2, id, 'down');
    expect(first.map((c) => c.incident)).toEqual([null, null]);
    expect(await forEndpoint(id)).toEqual([]);

    const third = await check(id);
    expect(third).toMatchObject({
      success: false,
      transition: 'WENT_DOWN',
      incident: 'opened',
    });

    const open = await forEndpoint(id, 'open');
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      status: 'OPEN',
      reason: 'BAD_STATUS',
      consecutiveFailures: 3,
      resolvedAt: null,
      resolution: null,
    });
    expect(open[0].endpointName).toMatch(/^EP /);
    expect(open[0]).not.toHaveProperty('openFor');
    expect(open[0]).not.toHaveProperty('_id');
    expect(open[0].durationMs).toBeGreaterThanOrEqual(0);

    // the outage began at the FIRST failure, and was detected at the third
    const history = (
      await api.get(`/api/v1/endpoints/${id}/checks`).set(auth())
    ).body as Array<{ checkedAt: string }>;
    expect(new Date(open[0].startedAt).getTime()).toBe(
      new Date(history[2].checkedAt).getTime(),
    );
    expect(new Date(open[0].detectedAt).getTime()).toBe(
      new Date(history[0].checkedAt).getTime(),
    );
    expect(new Date(open[0].startedAt).getTime()).toBeLessThan(
      new Date(open[0].detectedAt).getTime(),
    );
  });

  it('keeps one incident while the endpoint stays down, then closes it on recovery', async () => {
    const id = await create({ failureThreshold: 2 });
    await checks(2, id, 'down');
    const [opened] = await forEndpoint(id, 'open');
    expect(opened).toBeDefined();

    const more = await checks(3, id, 'down');
    expect(
      more.every((c) => c.incident === null && c.transition === null),
    ).toBe(true);
    expect(await forEndpoint(id)).toHaveLength(1);
    expect((await forEndpoint(id))[0].id).toBe(opened.id);

    await sleep(40);
    const recovered = (await checks(1, id, 'up'))[0];
    expect(recovered).toMatchObject({
      success: true,
      transition: 'RECOVERED',
      incident: 'resolved',
    });

    expect(await forEndpoint(id, 'open')).toEqual([]);
    const [resolved] = await forEndpoint(id, 'resolved');
    expect(resolved).toMatchObject({
      id: opened.id,
      status: 'RESOLVED',
      resolution: 'RECOVERED',
    });
    expect(new Date(resolved.resolvedAt).getTime()).toBeGreaterThan(
      new Date(resolved.startedAt).getTime(),
    );
    expect(resolved.durationMs).toBeGreaterThan(0);

    // further healthy checks change nothing
    expect((await checks(2, id, 'up')).every((c) => c.incident === null)).toBe(
      true,
    );
    expect(await forEndpoint(id)).toHaveLength(1);
  });

  it('stores incident ids as real ObjectIds and keeps the open marker only while open', async () => {
    const id = await create({ failureThreshold: 1 });
    await checks(1, id, 'down');
    const col = db.collection('incidents');
    const open = await col.findOne({ endpointId: new Types.ObjectId(id) });
    expect(open?.teamId).toBeInstanceOf(Types.ObjectId);
    expect(open?.endpointId).toBeInstanceOf(Types.ObjectId);
    expect(open?.openFor).toBeInstanceOf(Types.ObjectId);

    await checks(1, id, 'up');
    const closed = await col.findOne({ endpointId: new Types.ObjectId(id) });
    expect(closed).not.toHaveProperty('openFor'); // removed on resolve, which frees the unique slot
    expect(closed?.status).toBe('RESOLVED');
  });

  it('a second outage is a new incident and the first one is kept', async () => {
    const id = await create({ failureThreshold: 2 });
    await checks(2, id, 'down');
    await checks(1, id, 'up');
    await checks(2, id, 'down');
    const all = await forEndpoint(id);
    expect(all).toHaveLength(2);
    expect(new Set(all.map((i) => i.id)).size).toBe(2);
    expect(all.map((i) => i.status).sort()).toEqual(['OPEN', 'RESOLVED']);
    expect(all[0].status).toBe('OPEN'); // newest first
  });

  it('scattered blips below the threshold never open an incident', async () => {
    const id = await create({ failureThreshold: 3 });
    for (const m of ['down', 'down', 'up', 'down', 'down', 'up'] as const)
      await checks(1, id, m);
    expect(await forEndpoint(id)).toEqual([]);
  });

  it('racing workers create exactly one incident', async () => {
    const id = await create({ failureThreshold: 1 });
    const input = {
      teamId,
      endpointId: id,
      endpointName: 'Racy',
      outcome: {
        success: false,
        statusCode: 500,
        responseTimeMs: 5,
        failureReason: 'BAD_STATUS',
        errorMessage: 'x',
      } as const,
      consecutiveFailures: 3,
      detectedAt: new Date(),
      lookUpStreakStart: false,
    };
    const results = await Promise.all(
      Array.from({ length: 15 }, () => service.ensureOpen(input)),
    );
    expect(results.filter(Boolean)).toHaveLength(1); // exactly one caller "created" it, so only one alert later
    expect(
      await db
        .collection('incidents')
        .countDocuments({ endpointId: new Types.ObjectId(id) }),
    ).toBe(1);
  });

  it('resolving is idempotent: only the first call closes it', async () => {
    const id = await create({ failureThreshold: 1 });
    await checks(1, id, 'down');
    const first = await service.resolve(id, new Date(), 'RECOVERED');
    const second = await service.resolve(id, new Date(), 'RECOVERED');
    expect(first?.status).toBe('RESOLVED'); // the first call closes it and gets the incident back
    expect(second).toBeNull(); // the second finds nothing open
    const [inc] = await forEndpoint(id);
    expect(inc.status).toBe('RESOLVED');
  });

  it('heals itself: a DOWN endpoint whose incident went missing gets one on the next failing check', async () => {
    const id = await create({ failureThreshold: 1 });
    await checks(1, id, 'down');
    await db
      .collection('incidents')
      .deleteMany({ endpointId: new Types.ObjectId(id) });
    expect(await forEndpoint(id)).toEqual([]);

    const again = (await checks(1, id, 'down'))[0];
    expect(again.incident).toBe('opened');
    expect(await forEndpoint(id, 'open')).toHaveLength(1);
  });

  it('pausing ends an open incident as PAUSED, and a fresh one opens if it still fails after resume', async () => {
    const id = await create({ failureThreshold: 2 });
    await checks(2, id, 'down');
    expect(await forEndpoint(id, 'open')).toHaveLength(1);

    await api.post(`/api/v1/endpoints/${id}/pause`).set(auth());
    expect(await forEndpoint(id, 'open')).toEqual([]);
    const [paused] = await forEndpoint(id, 'resolved');
    expect(paused).toMatchObject({ status: 'RESOLVED', resolution: 'PAUSED' });

    await api.post(`/api/v1/endpoints/${id}/resume`).set(auth());
    await checks(2, id, 'down');
    const all = await forEndpoint(id);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ status: 'OPEN' });
    expect(all[0].id).not.toBe(paused.id);
  });

  it('pausing through PATCH also ends the incident', async () => {
    const id = await create({ failureThreshold: 1 });
    await checks(1, id, 'down');
    await api
      .patch(`/api/v1/endpoints/${id}`)
      .set(auth())
      .send({ isActive: false });
    expect(await forEndpoint(id, 'open')).toEqual([]);
    expect((await forEndpoint(id, 'resolved'))[0].resolution).toBe('PAUSED');
  });

  it('pausing while a check is in flight leaves no open incident behind', async () => {
    const id = await create({ failureThreshold: 1, timeoutMs: 3000 });
    mode = 'slow-down';
    const inFlight = api
      .post(`/api/v1/endpoints/${id}/check-now`)
      .set(auth())
      .then((r) => r);
    await sleep(150);
    await api.post(`/api/v1/endpoints/${id}/pause`).set(auth());
    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(res.body.incident).toBeNull();
    expect(await forEndpoint(id, 'open')).toEqual([]);
    const ep = (await api.get(`/api/v1/endpoints/${id}`).set(auth())).body;
    expect(ep).toMatchObject({ isActive: false, currentStatus: 'PAUSED' });
  });

  it('a manual check of a paused endpoint is recorded but never opens an incident', async () => {
    const id = await create({ failureThreshold: 1, isActive: false });
    mode = 'down';
    const res = await check(id);
    expect(res).toMatchObject({
      success: false,
      transition: null,
      incident: null,
    });
    expect(await forEndpoint(id)).toEqual([]);
    expect(
      (await api.get(`/api/v1/endpoints/${id}`).set(auth())).body.currentStatus,
    ).toBe('PAUSED');
    expect(
      (await api.get(`/api/v1/endpoints/${id}/checks`).set(auth())).body,
    ).toHaveLength(1);
  });

  it('deleting an endpoint deletes its incidents too', async () => {
    const id = await create({ failureThreshold: 1 });
    await checks(1, id, 'down');
    expect(await forEndpoint(id)).toHaveLength(1);
    await api.delete(`/api/v1/endpoints/${id}`).set(auth());
    expect(
      await db
        .collection('incidents')
        .countDocuments({ endpointId: new Types.ObjectId(id) }),
    ).toBe(0);
  });

  describe('incident API', () => {
    it('requires authentication', async () => {
      expect((await api.get('/api/v1/incidents')).status).toBe(401);
    });

    it('returns detail with the failing checks from during the incident as evidence', async () => {
      const id = await create({ failureThreshold: 3 });
      await checks(4, id, 'down');
      await checks(1, id, 'up');
      const [inc] = await forEndpoint(id);
      const res = await api.get(`/api/v1/incidents/${inc.id}`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(inc.id);
      expect(res.body.failedChecks).toHaveLength(4); // the 3 that tripped it plus 1 more; not the recovery
      expect(
        res.body.failedChecks.every((c: { success: boolean }) => !c.success),
      ).toBe(true);
      expect(res.body.failedChecks[0].failureReason).toBe('BAD_STATUS');
    });

    it('keeps teams apart', async () => {
      const id = await create({ failureThreshold: 1 });
      await checks(1, id, 'down');
      const [inc] = await forEndpoint(id);

      const other = (
        await api
          .post('/api/v1/auth/register')
          .send({
            email: 'other-inc@example.com',
            password: 'password123',
            teamName: 'Other',
          })
      ).body.accessToken as string;
      expect(await list('', other)).toEqual([]);
      expect(
        (await api.get(`/api/v1/incidents/${inc.id}`).set(auth(other))).status,
      ).toBe(404);
      expect(await list(`?endpointId=${id}`, other)).toEqual([]);
    });

    it('filters by status and endpoint, honours limit, and rejects bad input', async () => {
      const id = await create({ failureThreshold: 1 });
      await checks(1, id, 'down');
      await checks(1, id, 'up');
      await checks(1, id, 'down');
      expect(await forEndpoint(id)).toHaveLength(2);
      expect(await forEndpoint(id, 'open')).toHaveLength(1);
      expect(await forEndpoint(id, 'resolved')).toHaveLength(1);
      expect(await list(`?endpointId=${id}&limit=1`)).toHaveLength(1);
      expect(await list(`?endpointId=${id}&status=OPEN`)).toHaveLength(1); // case-insensitive

      expect(
        (await api.get('/api/v1/incidents?status=banana').set(auth())).status,
      ).toBe(400);
      expect(
        (await api.get('/api/v1/incidents?endpointId=nope').set(auth())).status,
      ).toBe(400);
      expect(
        (await api.get('/api/v1/incidents?limit=0').set(auth())).status,
      ).toBe(400);
      expect(
        (await api.get('/api/v1/incidents?limit=9999').set(auth())).status,
      ).toBe(400);
      expect(
        (await api.get('/api/v1/incidents/not-an-id').set(auth())).status,
      ).toBe(400);
      expect(
        (await api.get(`/api/v1/incidents/${new Types.ObjectId()}`).set(auth()))
          .status,
      ).toBe(404);
    });
  });
});
