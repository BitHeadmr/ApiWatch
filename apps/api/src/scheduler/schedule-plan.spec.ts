import { jitterOffsetMs, planReconcile } from './schedule-plan.js';

describe('planReconcile', () => {
  it('schedules active endpoints that have no job', () => {
    const plan = planReconcile([{ id: 'a', intervalSeconds: 60 }], []);
    expect(plan).toEqual({ upsert: [{ id: 'a', intervalSeconds: 60 }], remove: [] });
  });

  it('leaves correctly scheduled endpoints alone', () => {
    const plan = planReconcile([{ id: 'a', intervalSeconds: 60 }], [{ id: 'a', everyMs: 60_000 }]);
    expect(plan).toEqual({ upsert: [], remove: [] });
  });

  it('reschedules when the interval differs', () => {
    const plan = planReconcile([{ id: 'a', intervalSeconds: 30 }], [{ id: 'a', everyMs: 60_000 }]);
    expect(plan.upsert).toHaveLength(1);
  });

  it('reschedules a job with no interval recorded', () => {
    const plan = planReconcile([{ id: 'a', intervalSeconds: 30 }], [{ id: 'a', everyMs: undefined }]);
    expect(plan.upsert).toHaveLength(1);
  });

  it('removes jobs for endpoints that are paused, deleted or unknown', () => {
    const plan = planReconcile([], [{ id: 'gone', everyMs: 60_000 }]);
    expect(plan).toEqual({ upsert: [], remove: ['gone'] });
  });

  it('handles a mix', () => {
    const plan = planReconcile(
      [
        { id: 'keep', intervalSeconds: 60 },
        { id: 'new', intervalSeconds: 120 },
      ],
      [
        { id: 'keep', everyMs: 60_000 },
        { id: 'stale', everyMs: 5_000 },
      ],
    );
    expect(plan.upsert.map((e) => e.id)).toEqual(['new']);
    expect(plan.remove).toEqual(['stale']);
  });
});

describe('jitterOffsetMs', () => {
  it('is stable for the same id', () => {
    expect(jitterOffsetMs('abc', 60_000)).toBe(jitterOffsetMs('abc', 60_000));
  });

  it('stays within 10s and below half the interval', () => {
    for (let i = 0; i < 500; i++) {
      const off = jitterOffsetMs(`id-${i}`, 60_000);
      expect(off).toBeGreaterThanOrEqual(0);
      expect(off).toBeLessThan(10_000);
    }
    for (let i = 0; i < 100; i++) expect(jitterOffsetMs(`id-${i}`, 2_000)).toBeLessThan(1_000);
  });

  it('spreads endpoints out', () => {
    const offsets = new Set(Array.from({ length: 200 }, (_, i) => jitterOffsetMs(`id-${i}`, 60_000)));
    expect(offsets.size).toBeGreaterThan(150);
  });
});
