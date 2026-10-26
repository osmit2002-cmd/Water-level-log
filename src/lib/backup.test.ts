import { describe, expect, it } from 'vitest';
import { makeBackup, validateBackup } from './backup';
import { migrateV1 } from './migrate';
import { ALL_COLUMNS, DEFAULT_SETTINGS, normalizeSettings, normalizeUserCode, userCodeError } from './types';

const b = { name: 'MW-1', referencePoint: 'collar', refElevationFt: 10, createdAt: 'x', updatedAt: 'x' };
const r = { id: 1, borehole: 'MW-1', datetime: '2026-01-01T08:00', depthFt: 2, refElevationFt: 10, referencePoint: 'collar', userCode: 'OD-1', createdAt: 'x', updatedAt: 'x' };

describe('backup v3', () => {
  it('round-trips with settings and the ID counter', () => {
    const bk = JSON.parse(JSON.stringify(makeBackup([b], [r], { ...DEFAULT_SETTINGS, unit: 'm', columns: { ...ALL_COLUMNS, notes: false } }, 7, 't')));
    const v = validateBackup(bk);
    expect(v.fromVersion).toBe(3);
    expect(v.backup.version).toBe(3);
    expect(v.backup.readings).toEqual([r]);
    expect(v.backup.settings.unit).toBe('m');
    expect(v.backup.settings.columns.notes).toBe(false);
    expect(v.backup.nextReadingId).toBe(7);
  });
  it('never lets the counter fall behind the highest ID', () => {
    expect(validateBackup({ ...makeBackup([b], [{ ...r, id: 9 }], DEFAULT_SETTINGS, 2, 't') }).backup.nextReadingId).toBe(10);
  });
  it('rejects bad files', () => {
    expect(() => validateBackup({})).toThrow(/Not a Water Level Log/);
    const ok = makeBackup([b], [r], DEFAULT_SETTINGS, 2, 't');
    expect(() => validateBackup({ ...ok, version: 99 })).toThrow(/newer/);
    expect(() => validateBackup({ ...ok, readings: [{ ...r, borehole: 'Z' }] })).toThrow(/unknown borehole/);
    expect(() => validateBackup({ ...ok, readings: [{ ...r, depthFt: -1 }] })).toThrow(/bad depth/);
    expect(() => validateBackup({ ...ok, readings: [{ ...r, depthFt: undefined }] })).toThrow(/bad depth/);
    expect(() => validateBackup({ ...ok, readings: [r, r] })).toThrow(/duplicate/);
    expect(() => validateBackup({ ...ok, readings: [{ ...r, id: 1.5 }] })).toThrow(/Reading ID/);
    expect(() => validateBackup({ ...ok, boreholes: [b, { ...b, name: 'mw-1' }] })).toThrow(/duplicate name/);
  });
});

const v1 = {
  format: 'water-level-log-backup', version: 1, exportedAt: '2026-10-20T00:00:00Z', app: 'Water Level Log 0.1.0',
  settings: { unit: 'ft', theme: 'dark' },
  boreholes: [
    { id: 'MW-1', name: 'North pad', referencePoint: 'top of casing', refElevationFt: 1050.5, totalDepthFt: 80, lat: 1, lon: 2, notes: 'n' },
    { id: 'MW-2', name: 'North pad', referencePoint: '', refElevationFt: 987.25 }, // same name -> falls back to ID
    { id: 'MW-3', name: '', referencePoint: 'collar', refElevationFt: 5 }
  ],
  readings: [
    { uid: 'c', boreholeId: 'MW-1', datetime: '2026-10-15T08:30', status: 'ok', depthFt: 20.15, refElevationFt: 1050.5, referencePoint: 'top of casing', reader: 'Odin', createdAt: '3' },
    { uid: 'a', boreholeId: 'MW-1', datetime: '2026-09-20T07:45', status: 'ok', depthFt: 25, refElevationFt: 1050.5, referencePoint: 'top of casing', notes: ' hi ', createdAt: '9' },
    { uid: 'd', boreholeId: 'MW-1', datetime: '2026-10-20T09:00', status: 'dry', refElevationFt: 1050.5, createdAt: '4' },
    { uid: 'b', boreholeId: 'MW-2', datetime: '2026-10-01T08:00', status: 'ok', depthFt: 5, refElevationFt: 987.25, createdAt: '1' }
  ]
};

describe('v1 migration', () => {
  it('restores a v1 backup: names, IDs by date/time, removed fields dropped', () => {
    const { backup: m, fromVersion, skipped } = validateBackup(JSON.parse(JSON.stringify(v1)));
    expect(fromVersion).toBe(1);
    expect(skipped).toBe(1);
    expect(m.boreholes.map((x) => x.name)).toEqual(['North pad', 'MW-2', 'MW-3']);
    expect(m.boreholes[0]).toEqual({ name: 'North pad', referencePoint: 'top of casing', refElevationFt: 1050.5, createdAt: expect.any(String), updatedAt: expect.any(String) });
    expect(m.boreholes[1].referencePoint).toBe('top of casing');
    expect(m.readings.map((x) => [x.id, x.borehole, x.datetime])).toEqual([[1, 'North pad', '2026-09-20T07:45'], [2, 'MW-2', '2026-10-01T08:00'], [3, 'North pad', '2026-10-15T08:30']]);
    expect(m.readings[0].notes).toBe('hi');
    expect(Object.keys(m.readings[2]).sort()).toEqual(['borehole', 'createdAt', 'datetime', 'depthFt', 'id', 'notes', 'refElevationFt', 'referencePoint', 'updatedAt', 'userCode']);
    expect(m.readings.every((x) => x.userCode === '')).toBe(true);
    expect(m.nextReadingId).toBe(4);
    expect(m.settings.theme).toBe('dark');
    expect(m.settings.columns).toEqual(ALL_COLUMNS);
  });
  it('keeps names unique even when a name equals another borehole’s ID', () => {
    const m = migrateV1([{ id: 'A', name: 'B', refElevationFt: 1 }, { id: 'B', name: '', refElevationFt: 2 }, { id: 'C', name: 'b', refElevationFt: 3 }], []);
    const names = m.boreholes.map((x) => x.name);
    expect(names[0]).toBe('B');
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(3);
  });
  it('rejects invalid v1 data', () => {
    expect(() => validateBackup({ ...v1, readings: [{ ...v1.readings[0], boreholeId: 'ZZ' }] })).toThrow(/unknown borehole/);
  });
});

describe('settings', () => {
  it('defaults all columns on and never allows all off', () => {
    expect(normalizeSettings({}).columns).toEqual(ALL_COLUMNS);
    const off = Object.fromEntries(Object.keys(ALL_COLUMNS).map((k) => [k, false]));
    expect(normalizeSettings({ columns: off }).columns).toEqual(ALL_COLUMNS);
    expect(normalizeSettings({ unit: 'yd', theme: 'x', columns: { notes: false, bogus: true } })).toEqual({ unit: 'ft', theme: 'auto', columns: { ...ALL_COLUMNS, notes: false }, userCode: '' });
  });
});

describe('User Code', () => {
  it('normalizes and validates the phone code', () => {
    expect(normalizeUserCode('  od-1 ')).toBe('OD-1');
    expect(normalizeUserCode('jane doe')).toBe('JANE-DOE');
    expect(userCodeError('OD_1')).toBe('');
    expect(userCodeError('')).toMatch(/Enter/);
    expect(userCodeError('A'.repeat(21))).toMatch(/20/);
    expect(userCodeError('A.B')).toMatch(/letters/);
    expect(normalizeSettings({ userCode: ' od-1' }).userCode).toBe('OD-1');
    expect(normalizeSettings({ userCode: '=bad!' }).userCode).toBe('');
  });
  it('restores v2 backups with a blank User Code on every reading', () => {
    const { userCode: _u, ...r2 } = r;
    const v2 = { ...makeBackup([b], [r2 as typeof r], DEFAULT_SETTINGS, 2, 't'), version: 2 };
    const v = validateBackup(JSON.parse(JSON.stringify(v2)));
    expect(v.fromVersion).toBe(2);
    expect(v.backup.version).toBe(3);
    expect(v.backup.readings[0].userCode).toBe('');
  });
  it('normalizes v3 reading codes and rejects invalid ones', () => {
    const ok = validateBackup(JSON.parse(JSON.stringify(makeBackup([b], [{ ...r, userCode: ' jd ' }], DEFAULT_SETTINGS, 2, 't'))));
    expect(ok.backup.readings[0].userCode).toBe('JD');
    expect(() => validateBackup(JSON.parse(JSON.stringify(makeBackup([b], [{ ...r, userCode: 'a.b' }], DEFAULT_SETTINGS, 2, 't'))))).toThrow(/bad User Code/);
    expect(() => validateBackup(JSON.parse(JSON.stringify(makeBackup([b], [{ ...r, userCode: 'X'.repeat(21) }], DEFAULT_SETTINGS, 2, 't'))))).toThrow(/bad User Code/);
  });
  it('rejects a non-text User Code', () => {
    expect(() => validateBackup({ ...makeBackup([b], [{ ...r, userCode: 5 as unknown as string }], DEFAULT_SETTINGS, 2, 't') })).toThrow(/bad text/);
  });
});

describe('migrateV1 robustness', () => {
  it('skips malformed v1 records instead of throwing, and fills a missing reading reference point', async () => {
    const { migrateV1 } = await import('./migrate');
    const m = migrateV1(
      [{ id: 7 as unknown as string, name: 12 as unknown as string, referencePoint: 'collar', refElevationFt: 100 }],
      [
        { uid: 'a', boreholeId: '7', datetime: undefined as unknown as string, depthFt: 1, refElevationFt: 100 },
        { uid: 'b', boreholeId: '7', datetime: '2026-01-02T03:04:05', depthFt: 2, refElevationFt: 100 }
      ], 'now');
    expect(m.boreholes[0].name).toBe('12');
    expect(m.readings).toHaveLength(1);
    expect(m.readings[0]).toMatchObject({ id: 1, borehole: '12', datetime: '2026-01-02T03:04', referencePoint: 'collar' });
    expect(m.skipped.map((r) => r.uid)).toEqual(['a']);
  });
});
