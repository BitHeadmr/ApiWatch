import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import mongoose from 'mongoose';
import request from 'supertest';

// Must be set before the app is built: ConfigService reads these when it starts.
const PREFIX = `apiwatch-test-${Date.now()}`;
Object.assign(process.env, {
  JWT_SECRET: 'test-secret',
  SCHEDULER_ENABLED: 'true',
  QUEUE_PREFIX: PREFIX,
  MIN_INTERVAL_SECONDS: '1',
  RECONCILE_INTERVAL_SECONDS: '3600', // tests call reconcile() themselves
  CHECK_CONCURRENCY: '5',
});
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const { mongoIsUp, throwawayMongoUri } = await import('./mongo.js');
const MONGO_URI = throwawayMongoUri('engine');
process.env.MONGODB_URI = MONGO_URI;

const { AppModule } = await import('../src/app.module.js');
const { configureApp } = await import('../src/app.setup.js');
const { SchedulerService } =
  await import('../src/scheduler/scheduler.service.js');
const { CheckRunnerService } =
  await import('../src/checker/check-runner.service.js');
const { bullConnection } = await import('../src/redis/redis-connection.js');

async function redisIsUp() {
  const r = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  r.on('error', () => undefined);
  try {
    await r.connect();
    return (await r.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    r.disconnect();
  }
}
const hasRedis = await redisIsUp();
const hasMongo = await mongoIsUp();
const canRun = hasRedis && hasMongo;
if (!canRun) {
  console.warn(
    `\n[engine e2e] Needs Redis (${REDIS_URL}) and MongoDB; one is unreachable, skipping.\n`,
  );
}

async function waitFor<T>(
  fn: () => Promise<T | false | undefined>,
  timeoutMs = 10_000,
  label = 'condition',
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!canRun)(
  'check engine (real Redis, real MongoDB, real HTTP target)',
  () => {
    // A second, independent connection used only to look inside the database.
    const verify = mongoose.createConnection(MONGO_URI);
    const countChecks = (endpointId: string) =>
      verify.collection('check_results').countDocuments({
        endpointId: new mongoose.Types.ObjectId(endpointId),
      });
    let app: INestApplication;
    let api: ReturnType<typeof request>;
    let token: string;
    let target: http.Server;
    let targetUrl: string;
    let targetUp = true;
    let hits = 0;
    const cleanup = new Redis(REDIS_URL);
    const inspector = new Queue('checks', {
      connection: bullConnection(REDIS_URL),
      prefix: PREFIX,
    });

    const auth = () => ({ Authorization: `Bearer ${token}` });

    async function startApp() {
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const a = moduleRef.createNestApplication();
      configureApp(a);
      await a.init();
      return a;
    }

    const create = async (over: Record<string, unknown> = {}) => {
      const res = await api
        .post('/api/v1/endpoints')
        .set(auth())
        .send({
          name: 'Target',
          url: `${targetUrl}/switch`,
          intervalSeconds: 2, // the API requires timeoutMs >= 1000 and timeoutMs < interval
          timeoutMs: 1000,
          failureThreshold: 2,
          ...over,
        });
      expect(res.status).toBe(201);
      return res.body as { id: string };
    };
    const checks = async (id: string) =>
      (await api.get(`/api/v1/endpoints/${id}/checks?limit=200`).set(auth()))
        .body as Array<{
        success: boolean;
        failureReason: string | null;
        checkedAt: string;
      }>;
    const incidentsFor = async (id: string, status?: string) =>
      (
        await api
          .get(
            `/api/v1/incidents?endpointId=${id}${status ? `&status=${status}` : ''}`,
          )
          .set(auth())
      ).body as Array<Record<string, any>>;
    const endpoint = async (id: string) =>
      (await api.get(`/api/v1/endpoints/${id}`).set(auth())).body;
    const schedulers = async () =>
      (await inspector.getJobSchedulers(0, -1)).map((s) => s.key);

    beforeAll(async () => {
      target = http.createServer((req, res) => {
        hits += 1;
        if (req.url?.startsWith('/slow'))
          return void setTimeout(() => res.writeHead(200).end('ok'), 500);
        res.writeHead(targetUp ? 200 : 503).end(targetUp ? 'ok' : 'down');
      });
      await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
      targetUrl = `http://127.0.0.1:${(target.address() as AddressInfo).port}`;

      app = await startApp();
      api = request(app.getHttpServer());
      const reg = await api.post('/api/v1/auth/register').send({
        email: 'engine@example.com',
        password: 'password123',
        teamName: 'Engine',
      });
      token = reg.body.accessToken;
    });

    afterAll(async () => {
      await app?.close();
      await inspector.close();
      target.closeAllConnections();
      target.close();
      await verify.dropDatabase().catch(() => undefined);
      await verify.close();
      const keys = await cleanup.keys(`${PREFIX}:*`);
      if (keys.length) await cleanup.del(...keys);
      cleanup.disconnect();
    });

    it('checks a new endpoint on its own, starting right away', async () => {
      const ep = await create();
      // first result comes from the immediate check, well before a full interval
      await waitFor(
        async () => (await checks(ep.id)).length >= 1,
        1_500,
        'first check',
      );
      // then it keeps going without anyone asking
      const list = await waitFor(
        async () => {
          const c = await checks(ep.id);
          return c.length >= 3 && c;
        },
        14_000,
        '3 automatic checks',
      );
      expect(list.every((c) => c.success)).toBe(true);
      expect(await endpoint(ep.id)).toMatchObject({
        currentStatus: 'UP',
        consecutiveFailures: 0,
      });
      expect((await endpoint(ep.id)).lastCheckedAt).not.toBeNull();
      expect(await schedulers()).toContain(ep.id);

      await api.delete(`/api/v1/endpoints/${ep.id}`).set(auth());
    }, 30_000);

    it('goes DOWN after the threshold when the target breaks, opens an incident by itself, and closes it when it heals', async () => {
      const ep = await create({ failureThreshold: 2 });
      await waitFor(
        async () => (await endpoint(ep.id)).currentStatus === 'UP',
        8_000,
        'UP',
      );

      targetUp = false;
      await waitFor(
        async () => (await endpoint(ep.id)).currentStatus === 'DOWN',
        14_000,
        'DOWN',
      );
      const down = await checks(ep.id);
      expect(down.find((c) => !c.success)).toMatchObject({
        failureReason: 'BAD_STATUS',
      });
      expect(
        (await endpoint(ep.id)).consecutiveFailures,
      ).toBeGreaterThanOrEqual(2);

      // nobody touched anything: the incident is already in the log
      const open = await incidentsFor(ep.id, 'open');
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ status: 'OPEN', reason: 'BAD_STATUS' });
      await sleep(2_500); // more failing checks must not create more incidents
      expect(await incidentsFor(ep.id)).toHaveLength(1);

      targetUp = true;
      await waitFor(
        async () => (await endpoint(ep.id)).currentStatus === 'UP',
        14_000,
        'recovery',
      );
      expect((await endpoint(ep.id)).consecutiveFailures).toBe(0);

      const closed = await waitFor(
        async () => (await incidentsFor(ep.id, 'resolved'))[0],
        5_000,
        'resolved incident',
      );
      expect(closed).toMatchObject({
        id: open[0].id,
        status: 'RESOLVED',
        resolution: 'RECOVERED',
      });
      expect(closed.durationMs).toBeGreaterThan(0);
      expect(await incidentsFor(ep.id, 'open')).toEqual([]);

      await api.delete(`/api/v1/endpoints/${ep.id}`).set(auth());
    }, 60_000);

    it('stops checking when paused and resumes when resumed', async () => {
      const ep = await create();
      await waitFor(
        async () => (await checks(ep.id)).length >= 2,
        10_000,
        'initial checks',
      );

      await api.post(`/api/v1/endpoints/${ep.id}/pause`).set(auth());
      expect(await schedulers()).not.toContain(ep.id);
      await sleep(1_500); // let any in-flight job drain
      const frozen = (await checks(ep.id)).length;
      await sleep(4_500);
      expect((await checks(ep.id)).length).toBe(frozen);
      expect(await endpoint(ep.id)).toMatchObject({
        isActive: false,
        currentStatus: 'PAUSED',
      });

      await api.post(`/api/v1/endpoints/${ep.id}/resume`).set(auth());
      await waitFor(
        async () => (await checks(ep.id)).length > frozen + 1,
        12_000,
        'checks after resume',
      );
      expect((await endpoint(ep.id)).currentStatus).toBe('UP');

      await api.delete(`/api/v1/endpoints/${ep.id}`).set(auth());
    }, 60_000);

    it('removes the schedule when an endpoint is deleted', async () => {
      const ep = await create();
      await waitFor(
        async () => (await schedulers()).includes(ep.id),
        3_000,
        'schedule',
      );
      await api.delete(`/api/v1/endpoints/${ep.id}`).set(auth());
      expect(await schedulers()).not.toContain(ep.id);
      const before = hits;
      await sleep(3_000);
      // other tests' endpoints are gone too, so no new traffic at all
      expect(hits - before).toBeLessThanOrEqual(1);
    }, 20_000);

    it('applies interval changes to the schedule', async () => {
      const ep = await create({ intervalSeconds: 2, timeoutMs: 1000 });
      const everyOf = async () =>
        (await inspector.getJobSchedulers(0, -1)).find((s) => s.key === ep.id)
          ?.every;
      await waitFor(
        async () => (await everyOf()) === 2000,
        3_000,
        'initial schedule',
      );
      await api
        .patch(`/api/v1/endpoints/${ep.id}`)
        .set(auth())
        .send({ intervalSeconds: 5 });
      expect(await everyOf()).toBe(5000);
      await api.delete(`/api/v1/endpoints/${ep.id}`).set(auth());
    }, 20_000);

    it('survives a restart: monitoring continues with no duplicate schedules', async () => {
      const ep = await create();
      await waitFor(
        async () => (await checks(ep.id)).length >= 2,
        10_000,
        'checks before restart',
      );

      await app.close(); // graceful: in-flight checks finish
      const afterClose = await countChecks(ep.id);
      app = await startApp();
      api = request(app.getHttpServer());

      expect((await schedulers()).filter((id) => id === ep.id)).toHaveLength(1);
      await waitFor(
        async () => (await countChecks(ep.id)) >= afterClose + 2,
        14_000,
        'checks after restart',
      );

      await api.delete(`/api/v1/endpoints/${ep.id}`).set(auth());
    }, 60_000);

    it('repairs drift: a lost schedule is restored by reconciliation, an orphan is removed', async () => {
      const ep = await create();
      await waitFor(
        async () => (await schedulers()).includes(ep.id),
        3_000,
        'schedule',
      );

      // Simulate a Redis flush wiping the schedule, and a leftover job for a deleted endpoint.
      await inspector.removeJobScheduler(ep.id);
      await inspector.upsertJobScheduler(
        'ghost-endpoint',
        { every: 60_000 },
        { name: 'check', data: { endpointId: 'ghost-endpoint' } },
      );
      expect(await schedulers()).not.toContain(ep.id);

      const result = await app.get(SchedulerService).reconcile();
      expect(result).toEqual({ upserted: 1, removed: 1 });
      const now = await schedulers();
      expect(now).toContain(ep.id);
      expect(now).not.toContain('ghost-endpoint');

      const before = (await checks(ep.id)).length;
      await waitFor(
        async () => (await checks(ep.id)).length > before,
        8_000,
        'checks after repair',
      );
      // idempotent: a second pass changes nothing
      expect(await app.get(SchedulerService).reconcile()).toEqual({
        upserted: 0,
        removed: 0,
      });

      await api.delete(`/api/v1/endpoints/${ep.id}`).set(auth());
    }, 30_000);

    it('never runs two checks for the same endpoint at once', async () => {
      const ep = await create({
        url: `${targetUrl}/slow`,
        intervalSeconds: 3600,
        timeoutMs: 2000,
      });
      const runner = app.get(CheckRunnerService);
      const [a, b] = await Promise.all([runner.run(ep.id), runner.run(ep.id)]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual(['done', 'skipped']);
      const skipped = [a, b].find((r) => r.status === 'skipped');
      expect(skipped).toMatchObject({ reason: 'already_running' });
      // and the lock is released afterwards
      expect((await runner.run(ep.id)).status).toBe('done');

      await api.delete(`/api/v1/endpoints/${ep.id}`).set(auth());
    }, 20_000);

    it('does not let a late result overwrite PAUSED', async () => {
      const ep = await create({
        url: `${targetUrl}/slow`,
        intervalSeconds: 3600,
        timeoutMs: 2000,
      });
      const runner = app.get(CheckRunnerService);
      const inFlight = runner.run(ep.id);
      await sleep(100);
      await api.post(`/api/v1/endpoints/${ep.id}/pause`).set(auth());
      await inFlight;
      expect(await endpoint(ep.id)).toMatchObject({
        isActive: false,
        currentStatus: 'PAUSED',
      });

      await api.delete(`/api/v1/endpoints/${ep.id}`).set(auth());
    }, 20_000);
  },
);
