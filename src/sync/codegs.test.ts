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
    expect(sheet('Tombstones').data[0]).toEqual(['Kind', 'UID', 'Deleted At', 'Merged Into', 'Rev', 'Restored At']);
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
  it('explicit deletes sync and older re-sends do not bring them back', () => {
    push([bh(), bh({ uid: 'b2', name: 'MW-2' })], [rd(), rd({ uid: 'r2' }), rd({ uid: 'r3', boreholeUid: 'b2' })]);
    const c = pull().cursor;
    // the deleting phone sends the readings it knew, then the borehole
    push([], [], [{ uid: 'r1', kind: 'reading', deletedAt: T2 }, { uid: 'b2', kind: 'borehole', deletedAt: T2 }, { uid: 'r3', kind: 'reading', deletedAt: T2 }]);
    const p = pull(c);
    expect(p.tombstones.map((t: { uid: string }) => t.uid).sort()).toEqual(['b2', 'r1', 'r3']);
    expect(sheet('Readings').objects().filter((r) => r['Reading UID']).map((r) => r['Reading UID'])).toEqual(['r2']);
    // an offline phone re-sends records last edited BEFORE the delete: acked, the delete wins
    const again = push([bh({ uid: 'b2', name: 'MW-2', updatedAt: T1 })], [rd({ updatedAt: T1 })]);
    expect(again.acked).toEqual(['b:b2', 'r:r1']);
    const after = pull();
    expect(after.boreholes.map((b: BoreholeRec) => b.uid)).toEqual(['b1']);
    expect(after.readings.map((r: ReadingRec) => r.uid)).toEqual(['r2']);
    push([], [], [{ uid: 'r1', kind: 'reading', deletedAt: T3 }]);
    expect(sheet('Tombstones').objects().filter((t) => t.UID === 'r1')).toHaveLength(1);
  });
});

describe('Apps Script: 0.4.1 hardening', () => {
  it('review: a held reading does not undo its own delete (stale copies stay deleted)', () => {
    push([bh()], [rd()]);
    push([], [], [{ uid: 'r1', kind: 'reading', deletedAt: T2 }, { uid: 'b1', kind: 'borehole', deletedAt: T2 }]);
    const res = push([], [rd({ depthFt: 11, updatedAt: T3 })]); // newer than the delete, but its borehole is gone
    expect(res.held?.map((h: { key: string }) => h.key)).toEqual(['r:r1']);
    expect(sheet('Tombstones').objects().find((t) => t.UID === 'r1')!['Restored At']).toBeFalsy();
    expect(push([], [rd({ updatedAt: T1 })]).acked).toEqual(['r:r1']); // an old pre-delete copy is still ignored
    expect(sheet('Readings').objects()).toEqual([]);
  });
  it('review: a reading delete cut off after its tombstone was written is finished by the retry', () => {
    push([bh()], [rd()]);
    env.ss.failAfter = 0; // tombstone row written... (Tombstones is written before Readings) ...then the Readings write times out
    const r = push([], [], [{ uid: 'r1', kind: 'reading', deletedAt: T2 }]);
    env.ss.failAfter = null;
    if (r.ok === false) expect(sheet('Readings').objects().length).toBeLessThanOrEqual(1);
    expect(push([], [], [{ uid: 'r1', kind: 'reading', deletedAt: T2 }]).acked).toEqual(['t:r1']);
    expect(sheet('Readings').objects().filter((r) => r['Reading UID'])).toEqual([]);
    expect(push([], [], [{ uid: 'b1', kind: 'borehole', deletedAt: T3 }]).acked).toEqual(['t:b1']);
    expect(sheet('Boreholes').objects().filter((b) => b['Borehole UID'])).toEqual([]); // not kept alive by a leftover row
  });
  it('review: boreholes are written before readings, so a cut-off write never leaves a reading without its borehole', () => {
    push([bh()]);
    env.ss.failAfter = 1; // the 2nd setValues of the next request throws
    expect(push([bh({ uid: 'b2', name: 'MW-2' })], [rd({ uid: 'r9', boreholeUid: 'b2' })])).toMatchObject({ ok: false });
    const names = sheet('Boreholes').objects().map((b) => b['Borehole Name']);
    const reads = sheet('Readings').objects().map((r) => r['Reading UID'] ?? r.UID);
    expect(reads.length === 0 || names.includes('MW-2')).toBe(true);
    env.ss.failAfter = null;
    expect(push([bh({ uid: 'b2', name: 'MW-2' })], [rd({ uid: 'r9', boreholeUid: 'b2' })]).acked).toEqual(['b:b2', 'r:r9']);
  });
  it('#1/#2 deleting a borehole never deletes readings the deleting phone had not seen: it is kept and flagged', () => {
    push([bh()], [rd(), rd({ uid: 'r2' })]);
    const c = pull().cursor;
    // phone B only knew r1
    const res = push([], [], [{ uid: 'r1', kind: 'reading', deletedAt: T2 }, { uid: 'b1', kind: 'borehole', deletedAt: T2 }]);
    expect(res.acked).toEqual(['t:r1', 't:b1']);
    const p = pull(c);
    expect(p.boreholes[0]).toMatchObject({ uid: 'b1' });
    expect(p.boreholes[0].flag).toMatch(/1 reading\(s\) that phone had not seen were kept/);
    expect(p.boreholes[0].updatedAt > T2).toBe(true); // newer than the delete, so the deleting phone accepts it back
    expect(p.readings.map((r: ReadingRec) => r.uid)).toEqual(['r2']);
    expect(p.tombstones.map((t: { uid: string }) => t.uid)).toEqual(['r1']);
  });
  it('#2 a reading for a deleted borehole is held (not acked, not deleted) until the phone restores the borehole', () => {
    push([bh()]);
    push([], [], [{ uid: 'b1', kind: 'borehole', deletedAt: T2 }]);
    const res = push([], [rd({ uid: 'off1' })]);
    expect(res.acked).toEqual([]);
    expect(res.held).toEqual([{ key: 'r:off1', reason: expect.stringMatching(/deleted on another phone/) }]);
    expect(sheet('Tombstones').objects().map((t) => t.UID)).toEqual(['b1']);
    // the phone restores it (edit newer than the delete), then the reading goes in
    const r2 = push([bh({ flag: 'restored', flagAt: T3, updatedAt: T3 })], [rd({ uid: 'off1' })]);
    expect(r2.acked).toEqual(['b:b1', 'r:off1']);
    const p = pull();
    expect(p.boreholes.map((b: BoreholeRec) => b.uid)).toEqual(['b1']);
    expect(p.readings.map((r: ReadingRec) => r.uid)).toEqual(['off1']);
    expect(p.tombstones[0]).toMatchObject({ uid: 'b1', restoredAt: expect.any(String) });
  });
  it('#7 a delete loses to an edit made after it, and the record is flagged; an older edit loses', () => {
    push([bh()], [rd({ depthFt: 10, updatedAt: T3 })]); // edited at T3 on phone A
    push([], [], [{ uid: 'r1', kind: 'reading', deletedAt: T2 }]); // phone B deleted it at T2
    let p = pull();
    expect(p.readings.map((r: ReadingRec) => r.uid)).toEqual(['r1']);
    expect(p.boreholes[0].flag).toMatch(/Reading OD-0001 was deleted on a phone but edited later/);
    // a newer delete wins
    push([], [], [{ uid: 'r1', kind: 'reading', deletedAt: '2026-10-26T13:00:00.000Z' }]);
    expect(pull().readings).toEqual([]);
    // an edit newer than that delete brings it back (tombstone marked restored)
    push([], [rd({ depthFt: 12, updatedAt: '2026-10-26T14:00:00.000Z' })]);
    p = pull();
    expect(p.readings.map((r: ReadingRec) => [r.uid, r.depthFt])).toEqual([['r1', 12]]);
    expect(p.tombstones.find((t: { uid: string }) => t.uid === 'r1')).toMatchObject({ restoredAt: expect.any(String) });
  });
  it('#3 writes only changed rows; hand edits to other rows and extra columns (formulas too) survive', () => {
    push([bh()], Array.from({ length: 5 }, (_, i) => rd({ uid: `r${i}`, seq: i + 1 })));
    const R = sheet('Readings');
    const hd = R.data[0] as string[];
    R.data[0].push('Checked by'); // a column the team added
    for (let i = 1; i <= 5; i++) R.getRange(i + 1, hd.length, 1, 1).setValues([[i === 3 ? '=1+1' : `ok ${i}`]]);
    R.data[2][hd.indexOf('Notes')] = 'hand note'; // hand edit to row of r1
    const before = R.rowsWritten;
    push([], [rd({ uid: 'r3', seq: 4, depthFt: 7, updatedAt: T2 }), rd({ uid: 'new', seq: 9 })]);
    expect(R.rowsWritten - before).toBe(2); // one changed row + one appended row
    const o = R.objects();
    expect(o[1].Notes).toBe('hand note');
    expect(o[3]['Depth to Top of Water (ft)']).toBe(7);
    expect(R.formulas.get(`4,${hd.length}`)).toBe('=1+1');
    expect(o.map((x) => x['Checked by'])).toEqual(['ok 1', 'ok 2', '#FORMULA', 'ok 4', 'ok 5', '']);
    expect(o[5]['Reading UID']).toBe('new');
    // a delete blanks only our columns in that row
    push([], [], [{ uid: 'r0', kind: 'reading', deletedAt: T3 }]);
    expect(R.objects()[0]).toMatchObject({ 'Reading UID': '', 'Checked by': 'ok 1' });
    expect(pull().readings.map((r: ReadingRec) => r.uid).sort()).toEqual(['new', 'r1', 'r2', 'r3', 'r4']);
  });
  it('#4 a push that dies part-way is completed by the retry with the same end state; batches are capped', () => {
    const batch = () => push([bh(), bh({ uid: 'b2', name: 'MW-2' })], [rd(), rd({ uid: 'r2', boreholeUid: 'b2' })]);
    batch();
    const clean = JSON.stringify([sheet('Boreholes').objects(), sheet('Readings').objects()]);
    env = fakeEnv();
    batch(); // creates sheets
    env = fakeEnv();
    env.ss.failAfter = 4; // fail during the row writes of the first push
    expect(batch()).toMatchObject({ ok: false });
    expect(env.isLocked()).toBe(false);
    expect(env._store.get('REV')).toBeUndefined(); // the revision is stored only after all writes
    expect(batch()).toMatchObject({ ok: true, acked: ['b:b1', 'b:b2', 'r:r1', 'r:r2'] });
    const strip = (rows: Record<string, unknown>[]) => rows.map(({ Rev: _r, ...x }) => x);
    expect(JSON.stringify([strip(sheet('Boreholes').objects()), strip(sheet('Readings').objects())])).toBe(JSON.stringify((JSON.parse(clean) as Record<string, unknown>[][]).map(strip)));
    expect(push([], Array.from({ length: 251 }, (_, i) => rd({ uid: `x${i}` })))).toMatchObject({ ok: false, error: expect.stringMatching(/Too many/) });
  });
  it('#5 invalid items are rejected with a reason; valid items in the same batch still go in', () => {
    const res = push([bh(), bh({ uid: 'bad', name: '  ' })], [rd(), rd({ uid: 'neg', depthFt: -1 }), { ...rd({ uid: 'nodate' }), datetime: 'yesterday' }]);
    expect(res.acked).toEqual(['b:b1', 'r:r1']);
    expect(res.rejected).toEqual([
      { key: 'b:bad', reason: 'Borehole Name is empty' },
      { key: 'r:neg', reason: 'Depth is negative' },
      { key: 'r:nodate', reason: 'Reading date/time is not valid' }
    ]);
  });
  it('upgrades a 0.4.0 Tombstones sheet (no Restored At column) in place', () => {
    const T = env.ss.insertSheet('Tombstones');
    T.getRange(1, 1, 1, 5).setValues([['Kind', 'UID', 'Deleted At', 'Merged Into', 'Rev']]);
    T.getRange(2, 1, 1, 5).setValues([['reading', 'r1', T2, '', 1]]);
    push([bh()], [rd({ updatedAt: T3 })]);
    expect(sheet('Tombstones').data[0]).toEqual(['Kind', 'UID', 'Deleted At', 'Merged Into', 'Rev', 'Restored At']);
    expect(sheet('Tombstones').objects()[0]['Restored At']).not.toBe('');
  });
});

describe('Apps Script: review fixes (0.4.0)', () => {
  it('grows the sheet past its first 1000 rows', () => {
    push([bh()]);
    for (let k = 0; k < 9; k++) {
      const rs = Array.from({ length: 150 }, (_, i) => rd({ uid: `r${k}-${i}`, seq: k * 150 + i + 1, displayId: `OD-${k * 150 + i + 1}` }));
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
