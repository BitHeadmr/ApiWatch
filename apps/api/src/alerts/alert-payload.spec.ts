import { buildEmail, buildPayload, buildTestPayload, formatDuration } from './alert-payload.js';

const endpoint = { id: 'ep1', name: 'Payments API', url: 'https://api.example.com/health' };
const started = new Date('2026-10-01T10:00:00.000Z');
const incident = {
  id: 'inc1',
  status: 'OPEN' as const,
  reason: 'TIMEOUT',
  errorMessage: 'Request timed out',
  consecutiveFailures: 3,
  startedAt: started,
  detectedAt: new Date('2026-10-01T10:02:00.000Z'),
  resolvedAt: null as Date | null,
  resolution: null as string | null,
};

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [45_000, '45s'],
    [303_000, '5m 3s'],
    [3_900_000, '1h 5m'],
    [97_200_000, '1d 3h'],
    [-5, '0s'],
  ])('%d ms -> %s', (ms, text) => expect(formatDuration(ms)).toBe(text));
});

describe('buildPayload', () => {
  it('describes an open incident, with live duration', () => {
    const now = new Date('2026-10-01T10:05:00.000Z');
    const p = buildPayload({ event: 'incident.opened', deliveryId: 'd1', endpoint, incident, now });
    expect(p).toMatchObject({
      event: 'incident.opened',
      deliveryId: 'd1',
      endpoint,
      incident: { id: 'inc1', status: 'OPEN', reason: 'TIMEOUT', resolvedAt: null, durationMs: 300_000 },
    });
    expect(p.incident.startedAt).toBe('2026-10-01T10:00:00.000Z');
  });

  it('uses the real downtime for a resolved incident, not "now"', () => {
    const resolved = { ...incident, status: 'RESOLVED' as const, resolvedAt: new Date('2026-10-01T10:10:00.000Z'), resolution: 'RECOVERED' };
    const p = buildPayload({ event: 'incident.resolved', deliveryId: 'd2', endpoint, incident: resolved, now: new Date('2027-01-01') });
    expect(p.incident.durationMs).toBe(600_000);
    expect(p.incident.resolution).toBe('RECOVERED');
  });

  it('builds an obviously fake test payload', () => {
    const p = buildTestPayload(endpoint, 'd3');
    expect(p.event).toBe('alert.test');
    expect(p.incident.id).toBe('test');
    expect(p.incident.errorMessage).toMatch(/test alert/i);
  });
});

describe('buildEmail', () => {
  const opened = buildPayload({ event: 'incident.opened', deliveryId: 'd', endpoint, incident, now: new Date('2026-10-01T10:05:00Z') });

  it('says plainly that it is down, and what happened', () => {
    const e = buildEmail(opened, 'http://localhost:3000/');
    expect(e.subject).toBe('🔴 [APIWatch] Payments API is DOWN');
    expect(e.text).toContain('Down since: 2026-10-01T10:00:00.000Z');
    expect(e.text).toContain('3 checks in a row');
    expect(e.text).toContain('The request timed out');
    expect(e.text).toContain('http://localhost:3000/incidents/inc1'); // no double slash
  });

  it('reports downtime in the recovery email', () => {
    const resolved = buildPayload({
      event: 'incident.resolved',
      deliveryId: 'd',
      endpoint,
      incident: { ...incident, status: 'RESOLVED', resolvedAt: new Date('2026-10-01T10:10:03Z'), resolution: 'RECOVERED' },
    });
    const e = buildEmail(resolved, 'http://app');
    expect(e.subject).toBe('✅ [APIWatch] Payments API has recovered (down for 10m 3s)');
    expect(e.text).toContain('Total downtime: 10m 3s');
  });

  it('escapes HTML in names and messages', () => {
    const evil = buildPayload({
      event: 'incident.opened',
      deliveryId: 'd',
      endpoint: { ...endpoint, name: '<script>alert(1)</script>' },
      incident: { ...incident, errorMessage: 'a "quoted" <b>msg</b> & more' },
    });
    const { html } = buildEmail(evil, 'http://app');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; more');
  });

  it('labels a test alert and links to the app root', () => {
    const e = buildEmail(buildTestPayload(endpoint, 'd'), 'http://app');
    expect(e.subject).toBe('[APIWatch] Test alert for Payments API');
    expect(e.text).toContain('Incident: http://app');
    expect(e.text).not.toContain('/incidents/test');
  });
});
