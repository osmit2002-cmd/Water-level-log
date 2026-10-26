import type { Borehole, Reading } from './types';

/** Shapes of version 1 data (backup format v1 and IndexedDB schema v1). */
export interface V1Borehole {
  id: string; name?: string; referencePoint?: string; refElevationFt: number;
  totalDepthFt?: number; location?: string; notes?: string; lat?: number; lon?: number; createdAt?: string; updatedAt?: string;
}
export interface V1Reading {
  uid: string; boreholeId: string; datetime: string; status?: 'ok' | 'dry' | 'no_reading'; depthFt?: number;
  refElevationFt: number; referencePoint?: string; reader?: string; notes?: string; createdAt?: string; updatedAt?: string;
}
export interface Migrated {
  boreholes: Borehole[];
  readings: Reading[];
  nextReadingId: number;
  /** v1 entries that cannot exist in v2 (Dry / No reading: no depth). */
  skipped: V1Reading[];
}

/**
 * v1 -> v2. Borehole name = old name, or the old ID when the name is blank or already taken
 * (names must be unique); last resort "name (ID)". Readings get IDs 1..n in date/time order.
 * Total depth, location, lat/long, borehole notes, status, reader and change are dropped.
 */
export function migrateV1(rawB: V1Borehole[], rawR: V1Reading[], now = new Date().toISOString()): Migrated {
  // Defensive: old records may be malformed; coerce instead of throwing (a throw mid-upgrade must never lose data).
  const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
  const oldB = rawB.filter((b) => b && str(b.id)).map((b) => ({ ...b, id: String(b.id), name: str(b.name), referencePoint: str(b.referencePoint) }));
  const oldR = rawR.filter(Boolean).map((r) => ({ ...r, uid: String(r.uid ?? ''), boreholeId: String(r.boreholeId ?? ''), datetime: str(r.datetime) ?? '', referencePoint: str(r.referencePoint), notes: str(r.notes) }));
  const taken = new Set<string>();
  const nameOf = new Map<string, string>();
  const free = (n: string) => !!n && !taken.has(n.toLowerCase());
  for (const b of oldB) {
    const nm = (b.name ?? '').trim();
    let name = free(nm) ? nm : free(b.id) ? b.id : `${nm || b.id} (${b.id})`;
    for (let k = 2; !free(name); k++) name = `${b.id} (${k})`;
    taken.add(name.toLowerCase());
    nameOf.set(b.id, name);
  }
  const boreholes: Borehole[] = oldB.map((b) => ({
    name: nameOf.get(b.id)!, referencePoint: (b.referencePoint ?? '').trim() || 'top of casing', refElevationFt: b.refElevationFt,
    createdAt: b.createdAt ?? now, updatedAt: b.updatedAt ?? now
  }));
  const rpOf = new Map(oldB.map((b, i) => [b.id, boreholes[i].referencePoint]));
  const ok = (r: V1Reading) => (r.status ?? 'ok') === 'ok' && typeof r.depthFt === 'number' && Number.isFinite(r.depthFt) &&
    typeof r.refElevationFt === 'number' && Number.isFinite(r.refElevationFt) && nameOf.has(r.boreholeId) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(r.datetime);
  const order = [...oldR].sort((a, b) =>
    a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : (a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : (a.createdAt ?? '') > (b.createdAt ?? '') ? 1 : a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0);
  const readings: Reading[] = [];
  const skipped: V1Reading[] = [];
  for (const r of order) {
    if (!ok(r)) { skipped.push(r); continue; }
    readings.push({
      id: readings.length + 1, borehole: nameOf.get(r.boreholeId)!, datetime: r.datetime.slice(0, 16),
      referencePoint: r.referencePoint?.trim() || rpOf.get(r.boreholeId)!, refElevationFt: r.refElevationFt, depthFt: r.depthFt!,
      notes: r.notes?.trim() || undefined, createdAt: r.createdAt ?? now, updatedAt: r.updatedAt ?? now
    });
  }
  return { boreholes, readings, nextReadingId: readings.length + 1, skipped };
}
