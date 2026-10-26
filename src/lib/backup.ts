import type { Borehole, Reading, Settings } from './types';
import { isStatus } from './csv';

export const BACKUP_FORMAT = 'water-level-log-backup';
export const BACKUP_VERSION = 1;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  app: string;
  settings: Settings;
  boreholes: Borehole[];
  readings: Reading[];
}

export function makeBackup(boreholes: Borehole[], readings: Reading[], settings: Settings, app: string): Backup {
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), app, settings, boreholes, readings };
}

const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const optNum = (v: unknown) => v === undefined || v === null || isNum(v);
const optStr = (v: unknown) => v === undefined || v === null || typeof v === 'string';
const DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Validate a parsed backup. Returns the cleaned backup or throws with a readable message. */
export function validateBackup(x: unknown): Backup {
  const fail = (m: string): never => { throw new Error(m); };
  if (!x || typeof x !== 'object') fail('Not a backup file');
  const o = x as Record<string, unknown>;
  if (o.format !== BACKUP_FORMAT) fail('Not a Water Level Log backup');
  if (typeof o.version !== 'number' || o.version > BACKUP_VERSION) fail(`Backup version ${String(o.version)} is newer than this app supports`);
  if (!Array.isArray(o.boreholes) || !Array.isArray(o.readings)) fail('Backup is missing boreholes or readings');
  const ids = new Set<string>();
  (o.boreholes as unknown[]).forEach((b, i) => {
    const r = b as Record<string, unknown>;
    if (!r || typeof r.id !== 'string' || !r.id) fail(`Borehole ${i + 1}: missing id`);
    if (ids.has(r.id as string)) fail(`Borehole ${String(r.id)}: duplicate id`);
    if (!isNum(r.refElevationFt)) fail(`Borehole ${String(r.id)}: bad reference elevation`);
    if (!optNum(r.totalDepthFt) || !optNum(r.lat) || !optNum(r.lon)) fail(`Borehole ${String(r.id)}: bad number`);
    if (typeof r.name !== 'string' || typeof r.referencePoint !== 'string' || !optStr(r.location) || !optStr(r.notes)) fail(`Borehole ${String(r.id)}: bad text field`);
    ids.add(r.id as string);
  });
  const uids = new Set<string>();
  (o.readings as unknown[]).forEach((x2, i) => {
    const r = x2 as Record<string, unknown>;
    const at = `Reading ${i + 1}`;
    if (!r || typeof r.uid !== 'string' || uids.has(r.uid)) fail(`${at}: missing or duplicate uid`);
    if (typeof r.boreholeId !== 'string' || !ids.has(r.boreholeId)) fail(`${at}: unknown borehole ${String(r.boreholeId)}`);
    if (typeof r.datetime !== 'string' || !DT.test(r.datetime)) fail(`${at}: bad date/time`);
    if (!isStatus(r.status)) fail(`${at}: bad status`);
    if (r.status === 'ok' && (!isNum(r.depthFt) || (r.depthFt as number) < 0)) fail(`${at}: bad depth`);
    if (!isNum(r.refElevationFt)) fail(`${at}: bad reference elevation`);
    if (!optStr(r.reader) || !optStr(r.notes) || !optStr(r.referencePoint)) fail(`${at}: bad text field`);
    uids.add(r.uid as string);
  });
  const s = (o.settings ?? {}) as Partial<Settings>;
  const now = new Date().toISOString();
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: String(o.exportedAt ?? ''), app: String(o.app ?? ''),
    settings: { unit: s.unit === 'm' ? 'm' : 'ft', theme: s.theme === 'light' || s.theme === 'dark' ? s.theme : 'auto' },
    boreholes: (o.boreholes as Borehole[]).map((b) => ({ ...b, createdAt: b.createdAt ?? now, updatedAt: b.updatedAt ?? now })),
    readings: (o.readings as Reading[]).map((r) => ({
      ...r, referencePoint: r.referencePoint ?? '', depthFt: r.status === 'ok' ? r.depthFt : undefined,
      createdAt: r.createdAt ?? now, updatedAt: r.updatedAt ?? now
    }))
  };
}
