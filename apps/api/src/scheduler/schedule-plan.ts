export interface DesiredSchedule {
  id: string;
  intervalSeconds: number;
}
export interface ExistingSchedule {
  id: string;
  everyMs: number | undefined;
}

/** What to change in the queue so it matches the database. Pure, so it's easy to test. */
export function planReconcile(desired: DesiredSchedule[], existing: ExistingSchedule[]) {
  const existingById = new Map(existing.map((s) => [s.id, s]));
  const desiredIds = new Set(desired.map((d) => d.id));

  const upsert = desired.filter((d) => existingById.get(d.id)?.everyMs !== d.intervalSeconds * 1000);
  const remove = existing.filter((s) => !desiredIds.has(s.id)).map((s) => s.id);
  return { upsert, remove };
}

/**
 * A stable per-endpoint offset (0 to 10s, capped below the interval) so that hundreds of
 * monitors on the same interval don't all fire in the same millisecond. Derived from the
 * id so it doesn't change when an endpoint is rescheduled.
 */
export function jitterOffsetMs(id: string, intervalMs: number): number {
  let hash = 2166136261; // FNV-1a
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const window = Math.min(10_000, Math.max(1, Math.floor(intervalMs / 2)));
  return hash % window;
}
