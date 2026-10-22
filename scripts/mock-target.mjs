#!/usr/bin/env node
// A tiny API to point APIWatch at while developing. No dependencies.
//   node scripts/mock-target.mjs        (default port 5001, override with PORT)
//
//   GET  /ok                 200 {"status":"ok"}
//   GET  /fail               500
//   GET  /slow?ms=3000       200 after a delay
//   GET  /flaky              fails roughly every third request
//   GET  /body               200 with {"status":"healthy","version":"1.2.3"}
//   GET  /switch             200 while the switch is "up", 503 while "down"
//   POST /switch/down        flip the switch down  (use these to demo incidents)
//   POST /switch/up          flip it back up
//   GET  /redirect           302 to /ok
import http from 'node:http';

const port = Number(process.env.PORT ?? 5001);
let switchUp = true;
let flakyCount = 0;

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export function createMockTarget() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const route = `${req.method} ${url.pathname}`;
    console.log(new Date().toISOString(), route);

    switch (route) {
      case 'GET /ok':
      case 'HEAD /ok':
        return json(res, 200, { status: 'ok' });
      case 'GET /fail':
        return json(res, 500, { status: 'error' });
      case 'GET /slow': {
        const ms = Math.min(Number(url.searchParams.get('ms') ?? 3000), 60_000);
        return void setTimeout(() => json(res, 200, { status: 'ok', delayedMs: ms }), ms);
      }
      case 'GET /flaky':
        flakyCount += 1;
        return flakyCount % 3 === 0 ? json(res, 500, { status: 'flaky' }) : json(res, 200, { status: 'ok' });
      case 'GET /body':
        return json(res, 200, { status: 'healthy', version: '1.2.3' });
      case 'GET /switch':
        return switchUp ? json(res, 200, { status: 'ok' }) : json(res, 503, { status: 'down' });
      case 'POST /switch/down':
        switchUp = false;
        return json(res, 200, { switch: 'down' });
      case 'POST /switch/up':
        switchUp = true;
        return json(res, 200, { switch: 'up' });
      case 'GET /redirect':
        res.writeHead(302, { location: '/ok' });
        return res.end();
      default:
        return json(res, 404, { error: 'not found' });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createMockTarget().listen(port, () => {
    console.log(`Mock target listening on http://localhost:${port}`);
    console.log('Try: /ok /fail /slow?ms=3000 /flaky /body /switch  (POST /switch/down, /switch/up)');
  });
}
