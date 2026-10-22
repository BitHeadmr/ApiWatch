import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { type Connection, Types } from 'mongoose';
import request from 'supertest';
import { mongoIsUp, throwawayMongoUri } from './mongo.js';

// ---- A tiny SMTP server, so the real nodemailer -> SMTP path is exercised ----------------
interface Mail { from: string; to: string[]; data: string }
function startSmtp() {
  const mails: Mail[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let cur: Mail = { from: '', to: [], data: '' };
    socket.write('220 test-smtp ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          cur.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          mails.push(cur);
          cur = { from: '', to: [], data: '' };
          socket.write('250 OK queued\r\n');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) socket.write('250 test-smtp\r\n');
        else if (cmd.startsWith('MAIL FROM')) { cur.from = line; socket.write('250 OK\r\n'); }
        else if (cmd.startsWith('RCPT TO')) { cur.to.push(line.replace(/^RCPT TO:\s*<?|>?$/gi, '')); socket.write('250 OK\r\n'); }
        else if (cmd === 'DATA') { inData = true; socket.write('354 go ahead\r\n'); }
        else if (cmd === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  return { server, mails };
}

/** Subject header, with folded lines joined and RFC 2047 encoded-words (=?UTF-8?B/Q?..?=) decoded. */
function subjectOf(mail: Mail): string {
  const head = mail.data.split('\r\n\r\n')[0].replace(/\r\n[ \t]+/g, ' ');
  const raw = /^Subject:\s*(.*)$/im.exec(head)?.[1] ?? '';
  return raw
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (_m, enc: string, text: string) =>
      enc.toUpperCase() === 'B'
        ? Buffer.from(text, 'base64').toString('utf8')
        : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_x, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'),
    );
}

// ---- Environment (set before the app is built) -------------------------------------------
const smtp = startSmtp();
await new Promise<void>((r) => smtp.server.listen(0, '127.0.0.1', r));
const PREFIX = `apiwatch-alerts-${Date.now()}`;
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
Object.assign(process.env, {
  JWT_SECRET: 'test-secret',
  SCHEDULER_ENABLED: 'true',
  RUN_CHECK_WORKER: 'false', // checks are driven by hand (check-now); only alerts run on their own
  QUEUE_PREFIX: PREFIX,
  RECONCILE_INTERVAL_SECONDS: '3600', // tests call sweep() themselves
  ALERT_ATTEMPTS: '4',
  ALERT_BACKOFF_MS: '80',
  ALERT_TIMEOUT_MS: '3000',
  EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: String((smtp.server.address() as AddressInfo).port),
  SMTP_INSECURE: 'true',
  EMAIL_FROM: 'APIWatch <alerts@apiwatch.test>',
  APP_URL: 'http://dash.test',
  MONGODB_URI: throwawayMongoUri('alerts'),
});

const { AppModule } = await import('../src/app.module.js');
const { configureApp } = await import('../src/app.setup.js');
const { AlertsService } = await import('../src/alerts/alerts.service.js');
const { IncidentsService } = await import('../src/incidents/incidents.service.js');
const { verifyWebhook } = await import('../src/alerts/webhook-signature.js');

async function redisIsUp() {
  const r = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  r.on('error', () => undefined);
  try { await r.connect(); return (await r.ping()) === 'PONG'; } catch { return false; } finally { r.disconnect(); }
}
const canRun = (await redisIsUp()) && (await mongoIsUp());
if (!canRun) console.warn('\n[alerts e2e] Needs MongoDB and Redis; one is unreachable, skipping.\n');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => Promise<T | false | undefined> | T | false | undefined, timeoutMs = 8_000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(60);
  }
}

describe.skipIf(!canRun)('alerts (real MongoDB, Redis, webhook receiver and SMTP)', () => {
  let app: INestApplication;
  let api: ReturnType<typeof request>;
  let db: Connection;
  let token: string;
  let checkTarget: http.Server;
  let checkUrl: string;
  let checkUp = true;
  let receiver: http.Server;
  let receiverUrl: string;
  const hits: Array<{ path: string; headers: http.IncomingHttpHeaders; body: string }> = [];
  const cleanup = new Redis(REDIS_URL);
  let n = 0;

  const auth = (t = token) => ({ Authorization: `Bearer ${t}` });
  const hitsFor = (path: string) => hits.filter((h) => h.path === path);
  const uniquePath = (name: string) => `/${name}-${++n}`;

  beforeAll(async () => {
    checkTarget = http.createServer((_q, res) => res.writeHead(checkUp ? 200 : 503).end('x'));
    await new Promise<void>((r) => checkTarget.listen(0, '127.0.0.1', r));
    checkUrl = `http://127.0.0.1:${(checkTarget.address() as AddressInfo).port}/`;

    receiver = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const path = new URL(req.url!, 'http://x').pathname;
        hits.push({ path, headers: req.headers, body: Buffer.concat(chunks).toString() });
        const attempt = hitsFor(path).length;
        if (path.startsWith('/dead')) return void res.writeHead(500).end('nope');
        if (path.startsWith('/flaky') && attempt <= 2) return void res.writeHead(500).end('try later');
        if (path.startsWith('/redirect')) return void res.writeHead(302, { location: '/elsewhere' }).end();
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    api = request(app.getHttpServer());
    db = app.get<Connection>(getConnectionToken());
    token = (await api.post('/api/v1/auth/register').send({ email: 'alerts@example.com', password: 'password123', teamName: 'Alerts' })).body.accessToken;
  });

  afterAll(async () => {
    await db.dropDatabase();
    await app.close();
    receiver.closeAllConnections(); receiver.close();
    checkTarget.closeAllConnections(); checkTarget.close();
    smtp.server.close();
    const keys = await cleanup.keys(`${PREFIX}:*`);
    if (keys.length) await cleanup.del(...keys);
    cleanup.disconnect();
  });

  beforeEach(() => { checkUp = true; });

  const createEndpoint = async (over: Record<string, unknown> = {}) =>
    (await api.post('/api/v1/endpoints').set(auth()).send({ name: `EP ${++n}`, url: checkUrl, failureThreshold: 1, ...over })).body as { id: string; name: string };
  const addChannel = async (endpointId: string, body: Record<string, unknown>, t = token) =>
    api.post(`/api/v1/endpoints/${endpointId}/channels`).set(auth(t)).send(body);
  const check = async (id: string, up: boolean) => {
    checkUp = up;
    const res = await api.post(`/api/v1/endpoints/${id}/check-now`).set(auth());
    expect(res.status).toBe(200);
    return res.body as { incident: string | null };
  };
  const logsFor = (endpointId: string) => db.collection('alert_logs').find({ endpointId: new Types.ObjectId(endpointId) }).toArray();
  const incidentOf = async (endpointId: string) => (await api.get(`/api/v1/incidents?endpointId=${endpointId}`).set(auth())).body[0] as { id: string };
  const parse = (h: { body: string }) => JSON.parse(h.body);

  describe('channels API', () => {
    it('creates an email and a webhook channel; the webhook secret is shown once only', async () => {
      const ep = await createEndpoint();
      const email = await addChannel(ep.id, { type: 'email', target: 'Ops@Example.com' });
      expect(email.status).toBe(201);
      expect(email.body).toMatchObject({ type: 'EMAIL', target: 'ops@example.com', endpointId: ep.id });
      expect(email.body).not.toHaveProperty('secret');

      const hook = await addChannel(ep.id, { type: 'WEBHOOK', target: `${receiverUrl}/x` });
      expect(hook.status).toBe(201);
      expect(hook.body.secret).toMatch(/^whsec_[0-9a-f]{48}$/);

      const list = await api.get(`/api/v1/endpoints/${ep.id}/channels`).set(auth());
      expect(list.body).toHaveLength(2);
      expect(JSON.stringify(list.body)).not.toContain('whsec_'); // never readable again
    });

    it('accepts a secret you choose', async () => {
      const ep = await createEndpoint();
      const res = await addChannel(ep.id, { type: 'WEBHOOK', target: `${receiverUrl}/y`, secret: 'my-own-secret-value-123' });
      expect(res.body.secret).toBe('my-own-secret-value-123');
    });

    it.each([
      ['bad email', { type: 'EMAIL', target: 'not-an-email' }],
      ['bad url', { type: 'WEBHOOK', target: 'ftp://example.com/x' }],
      ['non-url webhook', { type: 'WEBHOOK', target: 'hello there' }],
      ['unknown type', { type: 'SMS', target: '+911234567890' }],
      ['secret on an email channel', { type: 'EMAIL', target: 'a@b.co', secret: 'x'.repeat(20) }],
      ['too-short secret', { type: 'WEBHOOK', target: 'http://x.test/h', secret: 'short' }],
      ['unknown field', { type: 'EMAIL', target: 'a@b.co', teamId: 'x' }],
    ])('rejects %s with 400', async (_l, body) => {
      const ep = await createEndpoint();
      expect((await addChannel(ep.id, body)).status).toBe(400);
    });

    it('rejects a duplicate channel with 409 and caps channels per endpoint', async () => {
      const ep = await createEndpoint();
      expect((await addChannel(ep.id, { type: 'EMAIL', target: 'dup@example.com' })).status).toBe(201);
      expect((await addChannel(ep.id, { type: 'EMAIL', target: 'DUP@example.com' })).status).toBe(409);
      for (let i = 0; i < 9; i++) expect((await addChannel(ep.id, { type: 'EMAIL', target: `u${i}@example.com` })).status).toBe(201);
      expect((await addChannel(ep.id, { type: 'EMAIL', target: 'eleventh@example.com' })).status).toBe(400);
    });

    it("keeps teams apart: other teams can't list, add, test or delete", async () => {
      const ep = await createEndpoint();
      const ch = (await addChannel(ep.id, { type: 'EMAIL', target: 'mine@example.com' })).body;
      const other = (await api.post('/api/v1/auth/register').send({ email: 'other-alerts@example.com', password: 'password123', teamName: 'Other' })).body.accessToken as string;
      expect((await api.get(`/api/v1/endpoints/${ep.id}/channels`).set(auth(other))).status).toBe(404);
      expect((await addChannel(ep.id, { type: 'EMAIL', target: 'x@example.com' }, other)).status).toBe(404);
      expect((await api.post(`/api/v1/channels/${ch.id}/test`).set(auth(other))).status).toBe(404);
      expect((await api.delete(`/api/v1/channels/${ch.id}`).set(auth(other))).status).toBe(404);
      expect((await api.get(`/api/v1/endpoints/${ep.id}/channels`).set(auth())).body).toHaveLength(1);
    });

    it('deletes a channel (204), and requires authentication', async () => {
      const ep = await createEndpoint();
      const ch = (await addChannel(ep.id, { type: 'EMAIL', target: 'del@example.com' })).body;
      expect((await api.delete(`/api/v1/channels/${ch.id}`).set(auth())).status).toBe(204);
      expect((await api.get(`/api/v1/endpoints/${ep.id}/channels`).set(auth())).body).toEqual([]);
      expect((await api.get(`/api/v1/endpoints/${ep.id}/channels`)).status).toBe(401);
      expect((await api.delete('/api/v1/channels/not-an-id').set(auth())).status).toBe(400);
    });
  });

  describe('webhook delivery', () => {
    it('sends a signed alert when an incident opens and another when it recovers, once each', async () => {
      const path = uniquePath('hook');
      const ep = await createEndpoint();
      const ch = (await addChannel(ep.id, { type: 'WEBHOOK', target: `${receiverUrl}${path}?token=abc123` })).body;

      expect((await check(ep.id, false)).incident).toBe('opened');
      await waitFor(() => hitsFor(path).length >= 1, 8000, 'opened alert');

      const first = hitsFor(path)[0];
      const body = parse(first);
      expect(first.headers['x-apiwatch-event']).toBe('incident.opened');
      expect(first.headers['x-apiwatch-delivery']).toBe(body.deliveryId);
      expect(verifyWebhook({ secret: ch.secret, timestamp: String(first.headers['x-apiwatch-timestamp']), body: first.body, signature: String(first.headers['x-apiwatch-signature']) })).toBe(true);
      expect(verifyWebhook({ secret: 'wrong-secret-wrong-secret', timestamp: String(first.headers['x-apiwatch-timestamp']), body: first.body, signature: String(first.headers['x-apiwatch-signature']) })).toBe(false);
      expect(body).toMatchObject({
        event: 'incident.opened',
        endpoint: { id: ep.id, name: ep.name, url: checkUrl },
        incident: { status: 'OPEN', reason: 'BAD_STATUS', consecutiveFailures: 1, resolvedAt: null },
      });

      // still failing: no second alert
      await check(ep.id, false);
      await check(ep.id, false);
      await sleep(700);
      expect(hitsFor(path)).toHaveLength(1);

      await sleep(30);
      expect((await check(ep.id, true)).incident).toBe('resolved');
      await waitFor(() => hitsFor(path).length >= 2, 8000, 'recovery alert');
      const second = parse(hitsFor(path)[1]);
      expect(hitsFor(path)[1].headers['x-apiwatch-event']).toBe('incident.resolved');
      expect(second).toMatchObject({ event: 'incident.resolved', incident: { status: 'RESOLVED', resolution: 'RECOVERED' } });
      expect(second.incident.durationMs).toBeGreaterThan(0);
      expect(second.deliveryId).not.toBe(body.deliveryId);

      // the incident detail shows the alert history, with the secret query string stripped
      await waitFor(async () => (await logsFor(ep.id)).every((l) => l.status === 'SENT'), 5000, 'both SENT');
      const inc = await incidentOf(ep.id);
      const detail = (await api.get(`/api/v1/incidents/${inc.id}`).set(auth())).body;
      expect(detail.alerts.map((a: { event: string }) => a.event)).toEqual(['incident.opened', 'incident.resolved']);
      expect(detail.alerts.every((a: { status: string }) => a.status === 'SENT')).toBe(true);
      expect(detail.alerts[0].target).toBe(`${receiverUrl}${path}`);
      expect(JSON.stringify(detail)).not.toContain('abc123');
    });

    it('retries with backoff until it succeeds, reusing the same delivery id', async () => {
      const path = uniquePath('flaky'); // answers 500 twice, then 200
      const ep = await createEndpoint();
      await addChannel(ep.id, { type: 'WEBHOOK', target: `${receiverUrl}${path}` });
      await check(ep.id, false);

      await waitFor(async () => (await logsFor(ep.id))[0]?.status === 'SENT', 10_000, 'eventual delivery');
      expect(hitsFor(path)).toHaveLength(3);
      expect(new Set(hitsFor(path).map((h) => h.headers['x-apiwatch-delivery'])).size).toBe(1);
      expect((await logsFor(ep.id))[0]).toMatchObject({ status: 'SENT', attempts: 3, lastError: null });
    });

    it('gives up after the configured attempts and records why, without blocking other channels', async () => {
      const dead = uniquePath('dead');
      const good = uniquePath('good');
      const ep = await createEndpoint();
      await addChannel(ep.id, { type: 'WEBHOOK', target: `${receiverUrl}${dead}` });
      await addChannel(ep.id, { type: 'WEBHOOK', target: `${receiverUrl}${good}` });
      await check(ep.id, false);

      await waitFor(async () => (await logsFor(ep.id)).every((l) => l.status !== 'PENDING'), 10_000, 'both settled');
      const logs = await logsFor(ep.id);
      const failed = logs.find((l) => l.target.endsWith(dead))!;
      expect(failed).toMatchObject({ status: 'FAILED', attempts: 4 });
      expect(failed.lastError).toContain('HTTP 500');
      expect(hitsFor(dead)).toHaveLength(4);
      expect(logs.find((l) => l.target.endsWith(good))).toMatchObject({ status: 'SENT', attempts: 1 });

      const detail = (await api.get(`/api/v1/incidents/${(await incidentOf(ep.id)).id}`).set(auth())).body;
      expect(detail.alerts.find((a: { status: string }) => a.status === 'FAILED').lastError).toContain('HTTP 500');
    });

    it('does not follow redirects: a 3xx is a failed delivery', async () => {
      const ep = await createEndpoint();
      const ch = (await addChannel(ep.id, { type: 'WEBHOOK', target: `${receiverUrl}${uniquePath('redirect')}` })).body;
      const res = await api.post(`/api/v1/channels/${ch.id}/test`).set(auth());
      expect(res.body).toMatchObject({ success: false });
      expect(res.body.error).toContain('HTTP 302');
    });
  });

  describe('email delivery', () => {
    it('emails the down and recovery alerts through SMTP', async () => {
      const ep = await createEndpoint();
      await addChannel(ep.id, { type: 'EMAIL', target: 'ops@example.com' });
      const before = smtp.mails.length;

      await check(ep.id, false);
      const down = await waitFor(() => smtp.mails.length > before && smtp.mails[before], 8000, 'down email');
      expect(down.to.join()).toContain('ops@example.com');
      expect(down.from).toContain('alerts@apiwatch.test');
      expect(subjectOf(down)).toBe(`🔴 [APIWatch] ${ep.name} is DOWN`);

      await sleep(30);
      await check(ep.id, true);
      const up = await waitFor(() => smtp.mails.length > before + 1 && smtp.mails[before + 1], 8000, 'recovery email');
      expect(subjectOf(up)).toMatch(new RegExp(`^✅ \\[APIWatch\\] ${ep.name} has recovered \\(down for \\d+s\\)$`));
      await waitFor(async () => (await logsFor(ep.id)).every((l) => l.status === 'SENT'), 5000, 'logs SENT');
    });
  });

  describe('test alerts', () => {
    it('sends a signed test alert to a webhook and an email to an address, without needing an incident', async () => {
      const path = uniquePath('hook');
      const ep = await createEndpoint();
      const hook = (await addChannel(ep.id, { type: 'WEBHOOK', target: `${receiverUrl}${path}` })).body;
      const mail = (await addChannel(ep.id, { type: 'EMAIL', target: 'test@example.com' })).body;
      const before = smtp.mails.length;

      expect((await api.post(`/api/v1/channels/${hook.id}/test`).set(auth())).body).toEqual({ success: true });
      const h = hitsFor(path)[0];
      expect(h.headers['x-apiwatch-event']).toBe('alert.test');
      expect(verifyWebhook({ secret: hook.secret, timestamp: String(h.headers['x-apiwatch-timestamp']), body: h.body, signature: String(h.headers['x-apiwatch-signature']) })).toBe(true);

      expect((await api.post(`/api/v1/channels/${mail.id}/test`).set(auth())).body).toEqual({ success: true });
      expect(subjectOf(smtp.mails[before])).toBe(`[APIWatch] Test alert for ${ep.name}`);
      expect(await db.collection('alert_logs').countDocuments({ endpointId: new Types.ObjectId(ep.id) })).toBe(0); // not an incident alert
    });

    it('reports a failing destination instead of throwing', async () => {
      const ep = await createEndpoint();
      const dead = (await addChannel(ep.id, { type: 'WEBHOOK', target: `${receiverUrl}${uniquePath('dead')}` })).body;
      const res = await api.post(`/api/v1/channels/${dead.id}/test`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: false });
      expect(res.body.error).toContain('HTTP 500');
    });
  });

  describe('exactly-once and repair', () => {
    it('ten simultaneous dispatches for the same incident still produce one alert', async () => {
      const path = uniquePath('hook');
      const ep = await createEndpoint();
      await addChannel(ep.id, { type: 'WEBHOOK', target: `${receiverUrl}${path}` });
      await check(ep.id, false);
      await waitFor(() => hitsFor(path).length >= 1);

      const raw = await db.collection('incidents').findOne({ endpointId: new Types.ObjectId(ep.id) });
      const alerts = app.get(AlertsService);
      const input = { _id: raw!._id, teamId: raw!.teamId, endpointId: raw!.endpointId, detectedAt: raw!.detectedAt, resolvedAt: null };
      const queued = await Promise.all(Array.from({ length: 10 }, () => alerts.dispatch(input as never, 'incident.opened')));
      expect(queued.reduce((a, b) => a + b, 0)).toBe(0); // all of them: "already done"
      await sleep(500);
      expect(await logsFor(ep.id)).toHaveLength(1);
      expect(hitsFor(path)).toHaveLength(1);
    });

    it("alerts a channel added after the outage began? No. And it doesn't get a recovery either", async () => {
      const early = uniquePath('early');
      const late = uniquePath('late');
      const ep = await createEndpoint();
      await addChannel(ep.id, { type: 'WEBHOOK', target: `${receiverUrl}${early}` });
      await check(ep.id, false);
      await waitFor(() => hitsFor(early).length >= 1);

      await sleep(20);
      await addChannel(ep.id, { type: 'WEBHOOK', target: `${receiverUrl}${late}` });
      await app.get(AlertsService).sweep(); // even the repair sweep must not alert it retroactively
      await check(ep.id, true);
      await waitFor(() => hitsFor(early).length >= 2, 8000, 'early channel recovery');
      await sleep(500);
      expect(hitsFor(late)).toHaveLength(0);
    });

    it('the sweep repairs an incident whose alerts were never dispatched (a crash in between)', async () => {
      const path = uniquePath('hook');
      const ep = await createEndpoint();
      await addChannel(ep.id, { type: 'WEBHOOK', target: `${receiverUrl}${path}` });
      await sleep(20);

      // Open the incident behind the runner's back, as if the process died before dispatching.
      const teamId = (await db.collection('endpoints').findOne({ _id: new Types.ObjectId(ep.id) }))!.teamId.toString();
      const opened = await app.get(IncidentsService).ensureOpen({
        teamId, endpointId: ep.id, endpointName: ep.name,
        outcome: { success: false, statusCode: 503, responseTimeMs: 5, failureReason: 'BAD_STATUS', errorMessage: 'x' },
        consecutiveFailures: 1, detectedAt: new Date(), lookUpStreakStart: false,
      });
      expect(opened).not.toBeNull();
      await sleep(300);
      expect(hitsFor(path)).toHaveLength(0);

      const alerts = app.get(AlertsService);
      expect((await alerts.sweep()).dispatched).toBeGreaterThanOrEqual(1);
      await waitFor(() => hitsFor(path).length >= 1, 8000, 'repaired alert');
      await alerts.sweep();
      await sleep(400);
      expect(hitsFor(path)).toHaveLength(1); // a second sweep changes nothing
    });

    it('the sweep re-queues an alert whose job was lost', async () => {
      const path = uniquePath('hook');
      const ep = await createEndpoint();
      const ch = (await addChannel(ep.id, { type: 'WEBHOOK', target: `${receiverUrl}${path}` })).body;
      const teamId = (await db.collection('endpoints').findOne({ _id: new Types.ObjectId(ep.id) }))!.teamId;
      const incidentId = new Types.ObjectId();
      await db.collection('incidents').insertOne({
        _id: incidentId, teamId, endpointId: new Types.ObjectId(ep.id), endpointName: ep.name, status: 'RESOLVED',
        startedAt: new Date(0), detectedAt: new Date(0), resolvedAt: new Date(1), resolution: 'PAUSED',
      });
      // a PENDING alert from five minutes ago that never got a queue job
      await db.collection('alert_logs').insertOne({
        teamId, endpointId: new Types.ObjectId(ep.id), incidentId, channelId: new Types.ObjectId(ch.id),
        event: 'incident.opened', channelType: 'WEBHOOK', target: ch.target, status: 'PENDING', attempts: 0,
        lastError: null, sentAt: null, createdAt: new Date(Date.now() - 5 * 60_000),
      });

      expect((await app.get(AlertsService).sweep()).requeued).toBeGreaterThanOrEqual(1);
      await waitFor(() => hitsFor(path).length >= 1, 8000, 're-queued delivery');
      await waitFor(async () => (await db.collection('alert_logs').findOne({ incidentId }))?.status === 'SENT');
    });
  });

  describe('what must not alert', () => {
    it('pausing an endpoint with an open incident sends no "recovered" alert', async () => {
      const path = uniquePath('hook');
      const ep = await createEndpoint();
      await addChannel(ep.id, { type: 'WEBHOOK', target: `${receiverUrl}${path}` });
      await check(ep.id, false);
      await waitFor(() => hitsFor(path).length >= 1);
      await api.post(`/api/v1/endpoints/${ep.id}/pause`).set(auth());
      await app.get(AlertsService).sweep();
      await sleep(600);
      expect(hitsFor(path)).toHaveLength(1);
      expect(hitsFor(path)[0].headers['x-apiwatch-event']).toBe('incident.opened');
    });

    it('a deleted channel is not alerted', async () => {
      const path = uniquePath('hook');
      const ep = await createEndpoint();
      const ch = (await addChannel(ep.id, { type: 'WEBHOOK', target: `${receiverUrl}${path}` })).body;
      await api.delete(`/api/v1/channels/${ch.id}`).set(auth());
      await check(ep.id, false);
      await sleep(600);
      expect(hitsFor(path)).toHaveLength(0);
    });

    it('deleting an endpoint deletes its channels and alert history', async () => {
      const ep = await createEndpoint();
      await addChannel(ep.id, { type: 'WEBHOOK', target: `${receiverUrl}${uniquePath('hook')}` });
      await check(ep.id, false);
      await waitFor(async () => (await logsFor(ep.id)).length === 1);
      await api.delete(`/api/v1/endpoints/${ep.id}`).set(auth());
      const oid = new Types.ObjectId(ep.id);
      expect(await db.collection('alert_channels').countDocuments({ endpointId: oid })).toBe(0);
      expect(await db.collection('alert_logs').countDocuments({ endpointId: oid })).toBe(0);
    });
  });
});

