import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { type Connection, Types } from 'mongoose';
import http2 from 'node:http';
import net from 'node:net';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { RedisService } from '../src/redis/redis.service.js';
import { mongoIsUp, throwawayMongoUri } from './mongo.js';

process.env.JWT_SECRET = 'test-secret';
process.env.SCHEDULER_ENABLED = 'false'; // no Redis needed for these API-level tests
process.env.MONGODB_URI = throwawayMongoUri('api');

const hasMongo = await mongoIsUp();
if (!hasMongo)
  console.warn(
    '\n[api e2e] MongoDB not reachable; skipping API tests. Start one (see README) or set TEST_MONGODB_URI.\n',
  );

const fakeRedis = {
  ping: async () => true,
  acquireLock: async () => 'token',
  releaseLock: async () => undefined,
};

describe.skipIf(!hasMongo)('APIWatch API (real MongoDB)', () => {
  let app: INestApplication;
  let http: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisService)
      .useValue(fakeRedis)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    http = request(app.getHttpServer());
  });

  afterAll(async () => {
    await app?.get<Connection>(getConnectionToken()).dropDatabase();
    await app?.close();
  });

  const register = async (email: string, teamName = 'Acme') => {
    const res = await http
      .post('/api/v1/auth/register')
      .send({ email, password: 'password123', teamName });
    return res.body.accessToken as string;
  };
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const validEndpoint = {
    name: 'Payments',
    url: 'https://api.example.com/health',
  };

  describe('auth', () => {
    it('registers a user and returns a token', async () => {
      const res = await http
        .post('/api/v1/auth/register')
        .send({
          email: 'Alice@Example.com ',
          password: 'password123',
          teamName: 'Acme',
        });
      expect(res.status).toBe(201);
      expect(res.body.accessToken).toEqual(expect.any(String));
      expect(res.body.user.email).toBe('alice@example.com'); // normalised
      expect(res.body.user).not.toHaveProperty('password');
    });

    it('rejects duplicate email with 409', async () => {
      await register('dup@example.com');
      const res = await http
        .post('/api/v1/auth/register')
        .send({
          email: 'dup@example.com',
          password: 'password123',
          teamName: 'Other',
        });
      expect(res.status).toBe(409);
    });

    it('concurrent registrations of one email create exactly one account and no orphan teams', async () => {
      const db = app.get<Connection>(getConnectionToken());
      const email = 'race@example.com';
      const before = await db.collection('teams').countDocuments();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          http
            .post('/api/v1/auth/register')
            .send({ email, password: 'password123', teamName: `Race ${i}` }),
        ),
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(5);
      expect(await db.collection('users').countDocuments({ email })).toBe(1);
      expect((await db.collection('teams').countDocuments()) - before).toBe(1);
    });

    it('rejects short passwords and bad emails with 400', async () => {
      const short = await http
        .post('/api/v1/auth/register')
        .send({ email: 'a@b.co', password: 'short', teamName: 'Acme' });
      const badEmail = await http
        .post('/api/v1/auth/register')
        .send({ email: 'nope', password: 'password123', teamName: 'Acme' });
      expect(short.status).toBe(400);
      expect(badEmail.status).toBe(400);
    });

    it('logs in with correct credentials and rejects wrong ones identically', async () => {
      await register('login@example.com');
      const ok = await http
        .post('/api/v1/auth/login')
        .send({ email: 'login@example.com', password: 'password123' });
      const wrongPw = await http
        .post('/api/v1/auth/login')
        .send({ email: 'login@example.com', password: 'wrongpass1' });
      const noUser = await http
        .post('/api/v1/auth/login')
        .send({ email: 'ghost@example.com', password: 'password123' });
      expect(ok.status).toBe(200);
      expect(wrongPw.status).toBe(401);
      expect(noUser.status).toBe(401);
      expect(wrongPw.body.message).toBe(noUser.body.message);
    });

    it('GET /auth/me requires a valid token', async () => {
      const token = await register('me@example.com', 'Me Inc');
      expect((await http.get('/api/v1/auth/me')).status).toBe(401);
      expect(
        (await http.get('/api/v1/auth/me').set(auth('garbage'))).status,
      ).toBe(401);
      const res = await http.get('/api/v1/auth/me').set(auth(token));
      expect(res.status).toBe(200);
      expect(res.body.team.name).toBe('Me Inc');
    });
  });

  describe('endpoints', () => {
    it('stores every id as a real ObjectId, never a string', async () => {
      const token = await register('types@example.com');
      const target = http2.createServer((_req, res) =>
        res.writeHead(200).end('ok'),
      );
      await new Promise<void>((r) => target.listen(0, r));
      const url = `http://127.0.0.1:${(target.address() as { port: number }).port}/`;
      const db = app.get<Connection>(getConnectionToken());
      try {
        const { body } = await http
          .post('/api/v1/endpoints')
          .set(auth(token))
          .send({ name: 'Typed', url });
        await http
          .post(`/api/v1/endpoints/${body.id}/check-now`)
          .set(auth(token));

        const user = await db
          .collection('users')
          .findOne({ email: 'types@example.com' });
        const endpoint = await db
          .collection('endpoints')
          .findOne({ _id: new Types.ObjectId(body.id) });
        const check = await db
          .collection('check_results')
          .findOne({ endpointId: new Types.ObjectId(body.id) });
        expect(user?.teamId).toBeInstanceOf(Types.ObjectId);
        expect(endpoint?.teamId).toBeInstanceOf(Types.ObjectId);
        expect(check?.endpointId).toBeInstanceOf(Types.ObjectId);
        // and they agree with each other, so team scoping really works
        expect(String(endpoint?.teamId)).toBe(String(user?.teamId));
      } finally {
        target.close();
      }
    });

    it('deleting an endpoint also deletes its check history (no cascades in MongoDB)', async () => {
      const token = await register('cascade@example.com');
      const target = http2.createServer((_req, res) =>
        res.writeHead(200).end('ok'),
      );
      await new Promise<void>((r) => target.listen(0, r));
      const url = `http://127.0.0.1:${(target.address() as { port: number }).port}/`;
      const db = app.get<Connection>(getConnectionToken());
      try {
        const { body } = await http
          .post('/api/v1/endpoints')
          .set(auth(token))
          .send({ name: 'Doomed', url });
        await http
          .post(`/api/v1/endpoints/${body.id}/check-now`)
          .set(auth(token));
        await http
          .post(`/api/v1/endpoints/${body.id}/check-now`)
          .set(auth(token));
        const where = { endpointId: new Types.ObjectId(body.id) };
        expect(await db.collection('check_results').countDocuments(where)).toBe(
          2,
        );

        await http.delete(`/api/v1/endpoints/${body.id}`).set(auth(token));
        expect(await db.collection('check_results').countDocuments(where)).toBe(
          0,
        );
      } finally {
        target.close();
      }
    });

    it('requires authentication', async () => {
      expect((await http.get('/api/v1/endpoints')).status).toBe(401);
      expect(
        (await http.post('/api/v1/endpoints').send(validEndpoint)).status,
      ).toBe(401);
    });

    it('creates with sensible defaults and lists it', async () => {
      const token = await register('crud@example.com');
      const created = await http
        .post('/api/v1/endpoints')
        .set(auth(token))
        .send(validEndpoint);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        name: 'Payments',
        method: 'GET',
        intervalSeconds: 300,
        expectedStatus: '200',
        failureThreshold: 3,
        isActive: true,
        currentStatus: 'UNKNOWN',
      });
      const list = await http.get('/api/v1/endpoints').set(auth(token));
      expect(list.body).toHaveLength(1);
    });

    it.each([
      ['non-http url', { url: 'ftp://example.com' }],
      ['garbage url', { url: 'not a url' }],
      ['interval below minimum', { intervalSeconds: 5 }],
      ['timeout >= interval', { intervalSeconds: 30, timeoutMs: 30_000 }],
      ['bad expectedStatus', { expectedStatus: 'ok' }],
      ['bad method', { method: 'FETCH' }],
      ['threshold too high', { failureThreshold: 99 }],
      ['bad header name', { headers: { 'bad header': 'x' } }],
      ['non-string header value', { headers: { 'X-Num': 5 } }],
    ])('rejects %s with 400', async (_label, override) => {
      const token = await register(`bad-${Math.random()}@example.com`);
      const res = await http
        .post('/api/v1/endpoints')
        .set(auth(token))
        .send({ ...validEndpoint, ...override });
      expect(res.status).toBe(400);
    });

    it('refuses fields the client must not control (teamId, currentStatus)', async () => {
      const token = await register('mass@example.com');
      const res = await http
        .post('/api/v1/endpoints')
        .set(auth(token))
        .send({
          ...validEndpoint,
          teamId: 'someone-else',
          currentStatus: 'UP',
        });
      expect(res.status).toBe(400);
    });

    it('accepts "2xx" status classes and normalises case', async () => {
      const token = await register('status@example.com');
      const res = await http
        .post('/api/v1/endpoints')
        .set(auth(token))
        .send({ ...validEndpoint, expectedStatus: '2XX', method: 'post' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ expectedStatus: '2xx', method: 'POST' });
    });

    it('isolates teams: another team gets 404 and sees nothing', async () => {
      const a = await register('team-a@example.com', 'Team A');
      const b = await register('team-b@example.com', 'Team B');
      const { body } = await http
        .post('/api/v1/endpoints')
        .set(auth(a))
        .send(validEndpoint);

      expect((await http.get('/api/v1/endpoints').set(auth(b))).body).toEqual(
        [],
      );
      expect(
        (await http.get(`/api/v1/endpoints/${body.id}`).set(auth(b))).status,
      ).toBe(404);
      expect(
        (
          await http
            .patch(`/api/v1/endpoints/${body.id}`)
            .set(auth(b))
            .send({ name: 'x' })
        ).status,
      ).toBe(404);
      expect(
        (await http.delete(`/api/v1/endpoints/${body.id}`).set(auth(b))).status,
      ).toBe(404);
      expect(
        (await http.post(`/api/v1/endpoints/${body.id}/pause`).set(auth(b)))
          .status,
      ).toBe(404);
      // ...and it is untouched for the owner
      expect(
        (await http.get(`/api/v1/endpoints/${body.id}`).set(auth(a))).body.name,
      ).toBe('Payments');
    });

    it('rejects malformed ids with 400', async () => {
      const token = await register('uuid@example.com');
      expect(
        (await http.get('/api/v1/endpoints/not-a-uuid').set(auth(token)))
          .status,
      ).toBe(400);
    });

    it('updates fields, re-validating against the stored values', async () => {
      const token = await register('patch@example.com');
      const { body } = await http
        .post('/api/v1/endpoints')
        .set(auth(token))
        .send({ ...validEndpoint, intervalSeconds: 60, timeoutMs: 5000 });
      const ok = await http
        .patch(`/api/v1/endpoints/${body.id}`)
        .set(auth(token))
        .send({ name: 'Renamed' });
      expect(ok.body.name).toBe('Renamed');
      // shrinking the interval below the stored timeout must fail
      const bad = await http
        .patch(`/api/v1/endpoints/${body.id}`)
        .set(auth(token))
        .send({ intervalSeconds: 30, timeoutMs: 40_000 });
      expect(bad.status).toBe(400);
      const bad2 = await http
        .patch(`/api/v1/endpoints/${body.id}`)
        .set(auth(token))
        .send({ intervalSeconds: 5 });
      expect(bad2.status).toBe(400);
    });

    it('pauses and resumes, keeping status consistent', async () => {
      const token = await register('pause@example.com');
      const { body } = await http
        .post('/api/v1/endpoints')
        .set(auth(token))
        .send(validEndpoint);

      const paused = await http
        .post(`/api/v1/endpoints/${body.id}/pause`)
        .set(auth(token));
      expect(paused.body).toMatchObject({
        isActive: false,
        currentStatus: 'PAUSED',
      });

      const resumed = await http
        .post(`/api/v1/endpoints/${body.id}/resume`)
        .set(auth(token));
      expect(resumed.body).toMatchObject({
        isActive: true,
        currentStatus: 'UNKNOWN',
        consecutiveFailures: 0,
      });

      const viaPatch = await http
        .patch(`/api/v1/endpoints/${body.id}`)
        .set(auth(token))
        .send({ isActive: false });
      expect(viaPatch.body).toMatchObject({
        isActive: false,
        currentStatus: 'PAUSED',
      });
    });

    it('creates a paused endpoint when isActive is false', async () => {
      const token = await register('inactive@example.com');
      const res = await http
        .post('/api/v1/endpoints')
        .set(auth(token))
        .send({ ...validEndpoint, isActive: false });
      expect(res.body).toMatchObject({
        isActive: false,
        currentStatus: 'PAUSED',
      });
    });

    it('runs a check on demand and records it', async () => {
      const token = await register('checknow@example.com');
      const target = http2.createServer((_req, res) =>
        res.writeHead(200).end('ok'),
      );
      await new Promise<void>((r) => target.listen(0, r));
      const url = `http://127.0.0.1:${(target.address() as { port: number }).port}/`;
      try {
        const { body } = await http
          .post('/api/v1/endpoints')
          .set(auth(token))
          .send({ name: 'Local', url });
        const res = await http
          .post(`/api/v1/endpoints/${body.id}/check-now`)
          .set(auth(token));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
          success: true,
          statusCode: 200,
          failureReason: null,
        });

        const after = await http
          .get(`/api/v1/endpoints/${body.id}`)
          .set(auth(token));
        expect(after.body).toMatchObject({
          currentStatus: 'UP',
          consecutiveFailures: 0,
        });
        expect(after.body.lastCheckedAt).not.toBeNull();

        const history = await http
          .get(`/api/v1/endpoints/${body.id}/checks`)
          .set(auth(token));
        expect(history.body).toHaveLength(1);
      } finally {
        target.close();
      }
    });

    it('reports failed checks with a reason and counts consecutive failures', async () => {
      const token = await register('checkfail@example.com');
      // grab a port that was just free so the connection is genuinely refused
      const probe = net.createServer();
      await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
      const deadPort = (probe.address() as { port: number }).port;
      await new Promise((r) => probe.close(r));
      const { body } = await http
        .post('/api/v1/endpoints')
        .set(auth(token))
        .send({
          name: 'Dead',
          url: `http://127.0.0.1:${deadPort}/`,
          failureThreshold: 2,
        });
      const first = await http
        .post(`/api/v1/endpoints/${body.id}/check-now`)
        .set(auth(token));
      expect(first.body).toMatchObject({
        success: false,
        failureReason: 'CONN_REFUSED',
        transition: null,
      });
      const second = await http
        .post(`/api/v1/endpoints/${body.id}/check-now`)
        .set(auth(token));
      expect(second.body.transition).toBe('WENT_DOWN');
      const after = await http
        .get(`/api/v1/endpoints/${body.id}`)
        .set(auth(token));
      expect(after.body).toMatchObject({
        currentStatus: 'DOWN',
        consecutiveFailures: 2,
      });
    });

    it("won't check or read history of another team's endpoint", async () => {
      const a = await register('owner-chk@example.com', 'Owner Team');
      const b = await register('other-chk@example.com', 'Other Team');
      const { body } = await http
        .post('/api/v1/endpoints')
        .set(auth(a))
        .send(validEndpoint);
      expect(
        (await http.post(`/api/v1/endpoints/${body.id}/check-now`).set(auth(b)))
          .status,
      ).toBe(404);
      expect(
        (await http.get(`/api/v1/endpoints/${body.id}/checks`).set(auth(b)))
          .status,
      ).toBe(404);
    });

    it('deletes with 204, then 404', async () => {
      const token = await register('delete@example.com');
      const { body } = await http
        .post('/api/v1/endpoints')
        .set(auth(token))
        .send(validEndpoint);
      expect(
        (await http.delete(`/api/v1/endpoints/${body.id}`).set(auth(token)))
          .status,
      ).toBe(204);
      expect(
        (await http.get(`/api/v1/endpoints/${body.id}`).set(auth(token)))
          .status,
      ).toBe(404);
    });
  });
});
