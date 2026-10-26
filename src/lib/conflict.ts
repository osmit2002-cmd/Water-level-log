import type { Borehole, Reading } from './types';

/** What happened to a record between opening a form and saving it (fix #6). */
export type Stale = { kind: 'deleted' } | { kind: 'changed'; fields: string[] } | null;

const changedFields = <T extends object>(a: T, b: T, keys: (keyof T)[]) => keys.filter((k) => (a[k] ?? '') !== (b[k] ?? '')).map(String);

/** Compare the version a form opened with against what is stored now (updatedAt is the version). */
export function staleReading(base: Reading, cur: Reading | undefined): Stale {
  if (!cur) return { kind: 'deleted' };
  if (cur.updatedAt === base.updatedAt) return null;
  const fields = changedFields(base, cur, ['depthFt', 'notes', 'borehole']);
  return { kind: 'changed', fields };
}
export function staleBorehole(base: Borehole, cur: Borehole | undefined): Stale {
  if (!cur) return { kind: 'deleted' };
  if (cur.updatedAt === base.updatedAt && JSON.stringify(cur.fieldTimes ?? {}) === JSON.stringify(base.fieldTimes ?? {})) return null;
  return { kind: 'changed', fields: changedFields(base, cur, ['name', 'referencePoint', 'refElevationFt', 'flag']) };
}
/** Only the fields the user actually changed in the form, applied on top of the current record (fields edited elsewhere survive). */
export function applyMine(base: Borehole, cur: Borehole, mine: Pick<Borehole, 'name' | 'referencePoint' | 'refElevationFt'>): Borehole {
  const out = { ...cur };
  for (const k of ['name', 'referencePoint', 'refElevationFt'] as const) if (mine[k] !== base[k]) (out as Record<string, unknown>)[k] = mine[k];
  return out;
}
