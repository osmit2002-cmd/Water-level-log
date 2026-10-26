import type { Borehole, Reading, Settings } from './types';
import { normalizeSettings } from './types';
import { migrateV1, type V1Borehole, type V1Reading } from './migrate';

export const BACKUP_FORMAT = 'water-level-log-backup' as const;
export const BACKUP_VERSION = 2;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: 2;
  exportedAt: string;
  app: string;
  settings: Settings;
  nextReadingId: number;
  boreholes: Borehole[];
  readings: Reading[];
}
export interface RestoreResult {
  backup: Backup;
  fromVersion: number;
  /** v1 Dry/No-reading entries that were dropped by the migration. */
  skipped: number;
}

export function makeBackup(boreholes: Borehole[], readings: Reading[], settings: Settings, nextReadingId: number, app: string): Backup {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), app, settings, nextReadingId, boreholes, readings };
}

const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const optNum = (v: unknown) => v === undefined || v === null || isNum(v);
const optStr = (v: unknown) => v === undefined || v === null || typeof v === 'string';
const DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const fail = (m: string): never => { throw new Error(m); };
const rec = (x: unknown) => (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;

function validateV1(o: Record<string, unknown>): { boreholes: V1Borehole[]; readings: V1Reading[] } {
  const ids = new Set<string>();
  (o.boreholes as unknown[]).forEach((x, i) => {
    const r = rec(x);
    if (typeof r.id !== 'string' || !r.id) fail(`Borehole ${i + 1}: missing id`);
    if (ids.has(r.id as string)) fail(`Borehole ${String(r.id)}: duplicate id`);
    if (!isNum(r.refElevationFt)) fail(`Borehole ${String(r.id)}: bad reference elevation`);
    if (!optStr(r.name) || !optStr(r.referencePoint)) fail(`Borehole ${String(r.id)}: bad text field`);
    ids.add(r.id as string);
  });
  const uids = new Set<string>();
  (o.readings as unknown[]).forEach((x, i) => {
    const r = rec(x);
    const at = `Reading ${i + 1}`;
    if (typeof r.uid !== 'string' || uids.has(r.uid)) fail(`${at}: missing or duplicate uid`);
    if (typeof r.boreholeId !== 'string' || !ids.has(r.boreholeId)) fail(`${at}: unknown borehole ${String(r.boreholeId)}`);
    if (typeof r.datetime !== 'string' || !DT.test(r.datetime)) fail(`${at}: bad date/time`);
    if (!isNum(r.refElevationFt) || !optNum(r.depthFt) || (isNum(r.depthFt) && (r.depthFt as number) < 0)) fail(`${at}: bad number`);
    if (!optStr(r.notes) || !optStr(r.referencePoint)) fail(`${at}: bad text field`);
    uids.add(r.uid as string);
  });
  return { boreholes: o.boreholes as V1Borehole[], readings: o.readings as V1Reading[] };
}

/** Validate a parsed backup (v1 is migrated to v2). Returns the cleaned v2 backup or throws with a readable message. */
export function validateBackup(x: unknown): RestoreResult {
  if (!x || typeof x !== 'object') fail('Not a backup file');
  const o = x as Record<string, unknown>;
  if (o.format !== BACKUP_FORMAT) fail('Not a Water Level Log backup');
  if (o.version !== 1 && o.version !== 2) fail(typeof o.version === 'number' && o.version > BACKUP_VERSION ? `Backup version ${o.version} is newer than this app supports` : 'Unknown backup version');
  if (!Array.isArray(o.boreholes) || !Array.isArray(o.readings)) fail('Backup is missing boreholes or readings');
  const now = new Date().toISOString();
  const head = { format: BACKUP_FORMAT, version: 2 as const, exportedAt: String(o.exportedAt ?? ''), app: String(o.app ?? ''), settings: normalizeSettings(o.settings) };

  if (o.version === 1) {
    const v1 = validateV1(o);
    const m = migrateV1(v1.boreholes, v1.readings, now);
    return { backup: { ...head, nextReadingId: m.nextReadingId, boreholes: m.boreholes, readings: m.readings }, fromVersion: 1, skipped: m.skipped.length };
  }

  const names = new Set<string>();
  const boreholes: Borehole[] = (o.boreholes as unknown[]).map((x, i) => {
    const r = rec(x);
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    if (!name) fail(`Borehole ${i + 1}: missing name`);
    if (names.has(name.toLowerCase())) fail(`Borehole ${name}: duplicate name`);
    if (!isNum(r.refElevationFt)) fail(`Borehole ${name}: bad reference elevation`);
    if (!optStr(r.referencePoint)) fail(`Borehole ${name}: bad reference point`);
    names.add(name.toLowerCase());
    return { name, referencePoint: (r.referencePoint as string | undefined)?.trim() || 'top of casing', refElevationFt: r.refElevationFt as number,
      createdAt: String(r.createdAt ?? now), updatedAt: String(r.updatedAt ?? now) };
  });
  const exact = new Set(boreholes.map((b) => b.name));
  const ids = new Set<number>();
  const readings: Reading[] = (o.readings as unknown[]).map((x, i) => {
    const r = rec(x);
    const at = `Reading ${i + 1}`;
    if (!Number.isSafeInteger(r.id) || (r.id as number) < 1 || ids.has(r.id as number)) fail(`${at}: missing or duplicate Reading ID`);
    if (typeof r.borehole !== 'string' || !exact.has(r.borehole.trim())) fail(`${at}: unknown borehole ${String(r.borehole)}`);
    if (typeof r.datetime !== 'string' || !DT.test(r.datetime)) fail(`${at}: bad date/time`);
    if (!isNum(r.depthFt) || (r.depthFt as number) < 0) fail(`${at}: bad depth`);
    if (!isNum(r.refElevationFt)) fail(`${at}: bad reference elevation`);
    if (!optStr(r.notes) || !optStr(r.referencePoint)) fail(`${at}: bad text field`);
    ids.add(r.id as number);
    return { id: r.id as number, borehole: (r.borehole as string).trim(), datetime: (r.datetime as string).slice(0, 16), referencePoint: String(r.referencePoint ?? ''),
      refElevationFt: r.refElevationFt as number, depthFt: r.depthFt as number, notes: (r.notes as string | undefined)?.trim() || undefined,
      createdAt: String(r.createdAt ?? now), updatedAt: String(r.updatedAt ?? now) };
  });
  const maxId = Math.max(0, ...ids);
  const next = Number.isSafeInteger(o.nextReadingId) ? Math.max(o.nextReadingId as number, maxId + 1) : maxId + 1;
  return { backup: { ...head, nextReadingId: next, boreholes, readings }, fromVersion: 2, skipped: 0 };
}
