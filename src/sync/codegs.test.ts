import { beforeEach, describe, expect, it } from 'vitest';
import { fakeEnv, loadCodeGs, type FakeEnv } from '../../sync/apps-script/fake-sheet.mjs';
import type { BoreholeRec, ReadingRec } from './types';

const gs = loadCodeGs();
let env: FakeEnv;
const call = (body: Record<string, unknown>, team = 'TEAM-123') => gs.handleRequest_(JSON.stringify({ team, ...body }), env);
const T1 = '2026-10-26T10:00:00.000Z', T2 = '2026-10-26T11:00:00.000Z', T3 = '2026-10-26T12:00:00.000Z';
const bh = (o: Partial<BoreholeRec> = {}): BoreholeRec => ({ uid: 'b1', name: 'MW-1', referencePoint: 'top of casing', refElevationFt: 100, flag: '',
  nameAt: T1, referencePointAt: T1, refElevationAt: T1, flagAt: T1, createdAt: T1, updatedAt: T1, ...o });
const rd = (o: Partial<ReadingRec> = {}): ReadingRec => ({ uid: 'r1', displayId: 'OD-0001', boreholeUid: 'b1', boreholeName: 'MW-1', datetime: '2026-10-26T09:15', userCode: 'OD',
  seq: 1, referencePoint: 'top of casing', refElevationFt: 100, depthFt: 10, notes: '', createdAt: T1, updatedAt: T1, ...o });
const push = (b: BoreholeRec[] = [], r: ReadingRec[] = [], t: unknown[] = []) => call({ op: 'push', boreholes: b, readings: r, tombstones: t });
const pull = (since = 0) => call({ op: 'pull', since });
const sheet = (n: string) => env.ss.getSheetByName(n)!;

beforeEach(() => { env = fakeEnv(); });

describe('Apps Script: access', () => {
  it('rejects a wrong or missing team code and an unset code', () => {
    expect(call({ op: 'ping' }, 'nope')).toEqual({ ok: false, error: 'Wrong team code' });
    expect(call({ op: 'ping' }, '')).toMatchObject({ ok: false });
    env = fakeEnv({ team: null });
    expect(call({ op: 'ping' }, 'CHANGE-ME')).toMatchObject({ ok: false, error: expect.stringMatching(/not been set/) });
  });
  it('Script Property TEAM_CODE overrides the constant; ping works', () => {
    env._store.set('TEAM_CODE', 'NEW-CODE');
    expect(call({ op: 'ping' })).toMatchObject({ ok: false });
    expect(call({ op: 'ping' }, 'NEW-CODE')).toMatchObject({ ok: true });
  });
  it('bad JSON and unknown ops are refused; the lock is always released', () => {
    expect(gs.handleRequest_('{oops', env)).toEqual({ ok: false, error: 'Bad request' });
    expect(call({ op: 'drop' })).toMatchObject({ ok: false });
    expect(push([{ ...bh(), refElevationFt: 'x' as unknown as number }])).toMatchObject({ ok: true, acked: [] });
    expect(env.isLocked()).toBe(false);
  });
});

describe('Apps Script: sheets', () => {
  it('creates human-readable sheets with the app column names', () => {
    push([bh()], [rd({ notes: '=HYPERLINK("x")' })]);
    const R = sheet('Readings');
    expect(R.data[0].slice(0, 10)).toEqual(['Reading ID', 'Borehole Name', 'Date', 'Time', 'User Code', 'Reference Point', 'Reference Elevation (ft)', 'Depth to Top of Water (ft)', 'Water Elevation (ft)', 'Notes']);
    expect(R.objects()[0]).toMatchObject({ 'Reading ID': 'OD-0001', 'Borehole Name': 'MW-1', Date: '2026-10-26', Time: '09:15', 'Water Elevation (ft)': 90, Notes: '=HYPERLINK("x")' });
    expect(R.quoted.has('=HYPERLINK("x")')).toBe(true); // written with a leading ' so Sheets keeps it as text
    expect(sheet('Boreholes').data[0].slice(0, 3)).toEqual(['Borehole Name', 'Reference Point', 'Reference Elevation (ft)']);
    expect(sheet('Tombstones').data[0]).toEqual(['Kind', 'UID', 'Deleted At', 'Merged Into', 'Rev']);
    expect(R.frozen).toBe(1);
    expect(pull().readings[0].notes).toBe('=HYPERLINK("x")'); // formula guard is invisible to the app
  });
  it('refuses to run if someone renamed a header', () => {
    push([bh()]);
    sheet('Boreholes').data[0][0] = 'Name';
    expect(pull()).toMatchObject({ ok: false, error: expect.stringMatching(/missing column Borehole Name/) });
  });
});

describe('Apps Script: push / pull', () => {
  it('acks, is idempotent, and pulls only changes after the cursor', () => {
    const a = push([bh()], [rd()]);
    expect(a.acked).toEqual(['b:b1', 'r:r1']);
    const p1 = pull();
    expect(p1.boreholes).toHaveLength(1);
    expect(p1.readings[0]).toMatchObject({ uid: 'r1', datetime: '2026-10-26T09:15', depthFt: 10 });
    push([bh()], [rd()]); // resend after a lost response
    expect(sheet('Readings').objects()).toHaveLength(1);
    expect(pull(p1.cursor)).toMatchObject({ boreholes: [], readings: [], tombstones: [] });
    push([], [rd({ depthFt: 11, updatedAt: T2 })]);
    const p2 = pull(p1.cursor);
    expect(p2.readings.map((r: ReadingRec) => r.depthFt)).toEqual([11]);
  });
  it('a reading whose borehole is not uploaded yet stays queued (not acked)', () => {
    expect(push([], [rd({ boreholeUid: 'missing' })]).acked).toEqual([]);
  });
  it('borehole fields merge newest-wins per field; renames update the Readings sheet', () => {
    push([bh()], [rd()]);
    push([bh({ name: 'MW-1A', nameAt: T2, updatedAt: T2 })]);
    push([bh({ refElevationFt: 105, refElevationAt: T3, updatedAt: T3 })]); // other phone, still has the old name
    const b = pull().boreholes[0];
    expect([b.name, b.refElevationFt]).toEqual(['MW-1A', 105]);
    expect(sheet('Readings').objects()[0]['Borehole Name']).toBe('MW-1A');
  });
  it('a reading keeps its snapshotted reference elevation and date/time; older edits lose', () => {
    push([bh()], [rd()]);
    push([bh({ refElevationFt: 200, refElevationAt: T2 })], [rd({ refElevationFt: 200, datetime: '2026-10-27T00:00', depthFt: 12, updatedAt: T3 })]);
    push([], [rd({ depthFt: 99, updatedAt: T2 })]);
    const r = pull().readings[0];
    expect([r.refElevationFt, r.datetime, r.depthFt]).toEqual([100, '2026-10-26T09:15', 12]);
    expect(sheet('Readings').objects()[0]['Water Elevation (ft)']).toBe(88);
  });
});

describe('Apps Script: same-name merge', () => {
  it('a second borehole with the same name (any case) merges into the first and is flagged; readings move', () => {
    push([bh({ uid: 'A', name: 'MW-9', refElevationFt: 50 })], [rd({ uid: 'ra', boreholeUid: 'A' })]);
    const res = push([bh({ uid: 'B', name: 'mw-9', refElevationFt: 51, refElevationAt: T2 })], [rd({ uid: 'rb', boreholeUid: 'B', boreholeName: 'mw-9' })]);
    expect(res.acked).toEqual(['b:B', 'r:rb']);
    const p = pull();
    expect(p.boreholes).toHaveLength(1);
    expect(p.boreholes[0]).toMatchObject({ uid: 'A', name: 'MW-9', refElevationFt: 51 });
    expect(p.boreholes[0].flag).toMatch(/two phones/);
    expect(p.tombstones).toEqual([expect.objectContaining({ uid: 'B', kind: 'borehole', mergedInto: 'A' })]);
    expect(p.readings.map((r: ReadingRec) => [r.uid, r.boreholeUid, r.boreholeName])).toEqual([['ra', 'A', 'MW-9'], ['rb', 'A', 'MW-9']]);
    // later pushes from the phone that still knows B land on A
    push([bh({ uid: 'B', name: 'mw-9', referencePoint: 'collar', referencePointAt: T3 })], [rd({ uid: 'rc', boreholeUid: 'B' })]);
    const p2 = pull();
    expect(p2.boreholes[0].referencePoint).toBe('collar');
    expect(p2.readings.find((r: ReadingRec) => r.uid === 'rc')!.boreholeUid).toBe('A');
  });
});

describe('Apps Script: tombstones', () => {
  it('deletes sync, cascade from boreholes and never resurrect', () => {
    push([bh(), bh({ uid: 'b2', name: 'MW-2' })], [rd(), rd({ uid: 'r2' }), rd({ uid: 'r3', boreholeUid: 'b2' })]);
    const c = pull().cursor;
    push([], [], [{ uid: 'r1', kind: 'reading', deletedAt: T2 }, { uid: 'b2', kind: 'borehole', deletedAt: T2 }]);
    const p = pull(c);
    expect(p.tombstones.map((t: { uid: string }) => t.uid).sort()).toEqual(['b2', 'r1', 'r3']);
    expect(sheet('Readings').objects().map((r) => r['Reading UID'])).toEqual(['r2']);
    // an offline phone re-sends the old records: acked but ignored
    const again = push([bh({ uid: 'b2', name: 'MW-2', nameAt: T3 })], [rd({ updatedAt: T3 }), rd({ uid: 'r4', boreholeUid: 'b2' })]);
    expect(again.acked).toEqual(['b:b2', 'r:r1', 'r:r4']);
    const after = pull();
    expect(after.boreholes.map((b: BoreholeRec) => b.uid)).toEqual(['b1']);
    expect(after.readings.map((r: ReadingRec) => r.uid)).toEqual(['r2']);
    expect(after.tombstones.map((t: { uid: string }) => t.uid)).toContain('r4');
    // a repeated tombstone is harmless
    push([], [], [{ uid: 'r1', kind: 'reading', deletedAt: T3 }]);
    expect(sheet('Tombstones').objects().filter((t) => t.UID === 'r1')).toHaveLength(1);
  });
});

describe('Apps Script: review fixes (0.4.0)', () => {
  it('grows the sheet past its first 1000 rows', () => {
    push([bh()]);
    for (let k = 0; k < 3; k++) {
      const rs = Array.from({ length: 450 }, (_, i) => rd({ uid: `r${k}-${i}`, seq: k * 450 + i + 1, displayId: `OD-${k * 450 + i + 1}` }));
      expect(push([], rs)).toMatchObject({ ok: true });
    }
    expect(sheet('Readings').objects().length).toBe(1350);
    expect(pull(0).readings.length).toBe(1350);
  });
  it('a value starting with an apostrophe or = round-trips unchanged and never becomes a formula', () => {
    push([bh()], [rd({ notes: "'quoted" }), rd({ uid: 'r2', notes: '=SUM(A1)' })]);
    const notes = pull(0).readings.map((r: ReadingRec) => r.notes).sort();
    expect(notes).toEqual(["'quoted", '=SUM(A1)']);
    expect(sheet('Readings').quoted.has('=SUM(A1)') && sheet('Readings').quoted.has("'quoted")).toBe(true);
  });
  it('the cursor never goes back if the REV property is lost (e.g. a copied sheet)', () => {
    push([bh()], [rd()]);
    const c = pull(0).cursor;
    env._store.delete('REV');
    expect(pull(0).cursor).toBe(c);
    push([], [rd({ uid: 'r9', seq: 9 })]);
    expect(pull(c).readings.map((r: ReadingRec) => r.uid)).toEqual(['r9']);
  });
});
