import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { classifyError, performCheck, statusMatches } from './http-check.js';
import type { CheckTarget } from './types.js';

/** A port that was just free, so nothing is listening on it. */
async function closedPort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as AddressInfo;
  await new Promise((r) => srv.close(r));
  return port;
}

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    switch (url.pathname) {
      case '/ok':
        return void res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"healthy"}');
      case '/created':
        return void res.writeHead(201).end('made');
      case '/fail':
        return void res.writeHead(500).end('boom');
      case '/slow':
        return void setTimeout(() => res.writeHead(200).end('late'), 1500);
      case '/redirect':
        return void res.writeHead(302, { location: '/ok' }).end();
      case '/echo-ua':
        return void res.writeHead(200).end(String(req.headers['user-agent']));
      case '/echo-header':
        return void res.writeHead(200).end(String(req.headers['x-api-key']));
      case '/echo-body': {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        return void res.writeHead(200).end(`${req.method}:${Buffer.concat(chunks).toString()}`);
      }
      case '/huge': {
        res.writeHead(200);
        // 3 MB of filler, then the needle: beyond the read cap, so it must not be found
        const chunk = Buffer.alloc(1024 * 1024, 'a');
        res.write(chunk);
        res.write(chunk);
        res.write(chunk);
        return void res.end('NEEDLE');
      }
      default:
        return void res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

const target = (path: string, over: Partial<CheckTarget> = {}): CheckTarget => ({
  url: base + path,
  method: 'GET',
  timeoutMs: 2000,
  expectedStatus: '200',
  ...over,
});

describe('statusMatches', () => {
  it('matches exact codes and classes', () => {
    expect(statusMatches('200', 200)).toBe(true);
    expect(statusMatches('200', 201)).toBe(false);
    expect(statusMatches('2xx', 204)).toBe(true);
    expect(statusMatches('2XX', 301)).toBe(false);
    expect(statusMatches('5xx', 503)).toBe(true);
  });
});

describe('performCheck', () => {
  it('succeeds on the expected status and measures response time', async () => {
    const r = await performCheck(target('/ok'));
    expect(r).toMatchObject({ success: true, statusCode: 200, failureReason: null, errorMessage: null });
    expect(r.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('fails with BAD_STATUS on an unexpected code but keeps the response time', async () => {
    const r = await performCheck(target('/fail'));
    expect(r).toMatchObject({ success: false, statusCode: 500, failureReason: 'BAD_STATUS' });
    expect(r.responseTimeMs).not.toBeNull();
    expect(r.errorMessage).toContain('500');
  });

  it('accepts status classes', async () => {
    expect((await performCheck(target('/created', { expectedStatus: '2xx' }))).success).toBe(true);
    expect((await performCheck(target('/created', { expectedStatus: '200' }))).success).toBe(false);
  });

  it('checks the body for expected text', async () => {
    expect((await performCheck(target('/ok', { expectedBodyContains: 'healthy' }))).success).toBe(true);
    const r = await performCheck(target('/ok', { expectedBodyContains: 'nope' }));
    expect(r).toMatchObject({ success: false, statusCode: 200, failureReason: 'BAD_BODY' });
  });

  it('reports BAD_STATUS rather than BAD_BODY when both are wrong', async () => {
    const r = await performCheck(target('/fail', { expectedBodyContains: 'healthy' }));
    expect(r.failureReason).toBe('BAD_STATUS');
  });

  it('only reads a capped amount of the body', async () => {
    const r = await performCheck(target('/huge', { expectedBodyContains: 'NEEDLE', timeoutMs: 5000 }));
    expect(r.failureReason).toBe('BAD_BODY');
  });

  it('times out on a slow response', async () => {
    const started = Date.now();
    const r = await performCheck(target('/slow', { timeoutMs: 300 }));
    expect(r).toMatchObject({ success: false, failureReason: 'TIMEOUT', statusCode: null, responseTimeMs: null });
    expect(Date.now() - started).toBeLessThan(1200);
  });

  it('classifies a refused connection', async () => {
    const port = await closedPort();
    const r = await performCheck({ ...target('/'), url: `http://127.0.0.1:${port}/` });
    expect(r).toMatchObject({ success: false, failureReason: 'CONN_REFUSED', statusCode: null });
  });

  it('explains blocked ports instead of a bare "fetch failed"', async () => {
    const r = await performCheck({ ...target('/'), url: 'http://127.0.0.1:1/' });
    expect(r.success).toBe(false);
    expect(r.errorMessage).toContain('blocked');
  });

  it('classifies a DNS failure', async () => {
    const r = await performCheck({ ...target('/'), url: 'http://no-such-host.invalid/' });
    expect(r.success).toBe(false);
    expect(['DNS', 'CONN_REFUSED']).toContain(r.failureReason); // sandboxed resolvers vary
  });

  it('follows redirects', async () => {
    expect((await performCheck(target('/redirect'))).success).toBe(true);
  });

  it('identifies itself and sends custom headers', async () => {
    const ua = await performCheck(target('/echo-ua', { expectedBodyContains: 'APIWatch' }));
    expect(ua.success).toBe(true);
    const hdr = await performCheck(
      target('/echo-header', { headers: { 'X-Api-Key': 'secret-1' }, expectedBodyContains: 'secret-1' }),
    );
    expect(hdr.success).toBe(true);
  });

  it('sends a body for POST but not for GET', async () => {
    const post = await performCheck(
      target('/echo-body', { method: 'POST', body: 'hello', expectedBodyContains: 'POST:hello' }),
    );
    expect(post.success).toBe(true);
    const get = await performCheck(
      target('/echo-body', { method: 'GET', body: 'hello', expectedBodyContains: 'GET:' }),
    );
    expect(get.success).toBe(true);
  });

  it('never throws, even for a malformed URL', async () => {
    const r = await performCheck({ ...target('/'), url: 'http://' });
    expect(r.success).toBe(false);
    expect(r.failureReason).toBe('UNKNOWN');
  });
});

describe('classifyError', () => {
  it.each([
    [{ name: 'TimeoutError' }, 'TIMEOUT'],
    [{ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }, 'TIMEOUT'],
    [{ cause: { code: 'ENOTFOUND' } }, 'DNS'],
    [{ cause: { code: 'EAI_AGAIN' } }, 'DNS'],
    [{ cause: { code: 'ECONNREFUSED' } }, 'CONN_REFUSED'],
    [{ cause: { code: 'ECONNRESET' } }, 'CONN_REFUSED'],
    [{ cause: { code: 'CERT_HAS_EXPIRED' } }, 'TLS'],
    [{ cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } }, 'TLS'],
    [{ cause: { code: 'ERR_SSL_WRONG_VERSION_NUMBER' } }, 'TLS'],
    [new Error('???'), 'UNKNOWN'],
    [undefined, 'UNKNOWN'],
  ])('%j -> %s', (err, reason) => {
    expect(classifyError(err).reason).toBe(reason);
  });
});
