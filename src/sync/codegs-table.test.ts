import { beforeEach, describe, expect, it } from 'vitest';
import { fakeEnv, fakeTables, loadCodeGs, type FakeEnv } from '../../sync/apps-script/fake-sheet.mjs';
import type { BoreholeRec, ReadingRec } from './types';

// 0.6.0: number-only Reading IDs, the Readings table, and edits/deletes made by hand in the sheet.
const gs = loadCodeGs();
let env: FakeEnv;
const call = (body: Record<string, unknown>) => gs.handleRequest_(JSON.stringify({ team: 'TEAM-123', ...body }), env);
const T1 = '2026-10-26T10:00:00.000Z', T2 = '2026-10-26T11:00:00.000Z';
const bh = (o: Partial<BoreholeRec> = {}): BoreholeRec => ({ uid: 'b1', name: 'MW-1', referencePoint: 'top of casing', refElevationFt: 100, flag: '',
  nameAt: T1, referencePointAt: T1, refElevationAt: T1, flagAt: T1, createdAt: T1, updatedAt: T1, ...o });
const rd = (o: Partial<ReadingRec> = {}): ReadingRec => ({ uid: 'r1', displayId: '', boreholeUid: 'b1', boreholeName: 'MW-1', datetime: '2026-10-26T09:15', userCode: 'OD',
  seq: 1, referencePoint: 'top of casing', refElevationFt: 100, depthFt: 10, notes: '', createdAt: T1, updatedAt: T1, ...o });
const push = (b: BoreholeRec[] = [], r: ReadingRec[] = [], t: unknown[] = []) => call({ op: 'push', boreholes: b, readings: r, tombstones: t });
const pull = (since = 0) => call({ op: 'pull', since });
const sheet = (n: string) => env.ss.getSheetByName(n)!;
const R = () => sheet('Readings');
const rowOf = (uid: string) => (R().data as unknown[][]).findIndex((r) => r[(R().data[0] as string[]).indexOf('Reading UID')] === uid);
/** Edit a cell by hand, as Odin would in Google Sheets. */
const edit = (uid: string, col: string, v: unknown) => { R().data[rowOf(uid)][(R().data[0] as string[]).indexOf(col)] = v; };
const rec = (uid: string, since = 0) => pull(since).readings.find((r: ReadingRec) => r.uid === uid);
const three = () => push([bh(), bh({ uid: 'b2', name: 'MW-2', refElevationFt: 50 })],
  [rd(), rd({ uid: 'r2', datetime: '2026-10-26T10:00', depthFt: 11 }), rd({ uid: 'r3', datetime: '2026-10-26T11:00', depthFt: 12 })]);

beforeEach(() => { env = fakeEnv(); });

describe('0.6.0 Reading IDs', () => {
  it('the sheet numbers readings 1, 2, 3 in arrival order, ignoring the number a phone guessed; numbers are never reused', () => {
    three();
    expect(R().objects().map((o) => o['Reading ID'])).toEqual([1, 2, 3]);
    push([], [rd({ uid: 'r4', num: 3 } as Partial<ReadingRec>)]); // a phone that guessed 3 offline (another phone took it)
    expect(rec('r4').num).toBe(4);
    expect(rec('r4').displayId).toBe('4');
    R().deleteRow(rowOf('r4') + 1); // the newest row deleted by hand
    push([], [rd({ uid: 'r5' })]);
    expect(rec('r5').num).toBe(5); // 4 is not handed out again
    expect(pull().numMax).toBe(5);
    expect(env._store.get('NUM_MAX')).toBe('5');
  });
});

describe('0.6.0 sheet layout', () => {
  it('readable columns first; the sync columns are hidden and protected with a warning', () => {
    three();
    const h = R().data[0] as string[];
    expect(h.slice(0, 10)).toEqual(['Reading ID', 'Borehole Name', 'Date', 'Time', 'Depth to Top of Water (ft)', 'Water Elevation (ft)', 'Reference Point', 'Reference Elevation (ft)', 'Notes', 'User Code']);
    expect(h.slice(10)).toEqual(['Created At', 'Updated At', 'Reading UID', 'Borehole UID', 'Seq', 'Old Reading ID', 'Rev']);
    expect(R().hiddenCols).toEqual([[11, 7]]);
    expect(R().protections).toMatchObject([{ desc: 'Water Level Log sync columns', warn: true }]);
    expect(R().frozen).toBe(1);
    expect(R().filter).toBeTruthy(); // no Sheets API service: a filter instead of a table
    expect(sheet('Sync Index').hidden).toBe(true);
    expect(env._store.get('LAYOUT')).toBe('6');
  });
  it('with the Sheets API service on, makes a real table and stretches it over appended rows', () => {
    env = fakeEnv({ tables: fakeTables() });
    three();
    const t = env.tables!.list[0];
    expect(env.tables!.calls[0]).toBe('add');
    expect(t.props).toHaveLength(17);
    expect(t.props[4]).toEqual({ columnIndex: 4, columnName: 'Depth to Top of Water (ft)', columnType: 'DOUBLE' });
    expect(t.props[2]).toMatchObject({ columnName: 'Date', columnType: 'TEXT' });
    expect(t.range.endRowIndex).toBe(4); // header + 3
    push([], [rd({ uid: 'r9' })]);
    expect(t.range.endRowIndex).toBe(5);
    expect(R().filter).toBeNull();
  });
  it('one-time migration of a 0.5.0 sheet: every row kept, numbers in date order, old IDs kept, extra columns and formulas kept', () => {
    // Build the 0.5.0 layout by hand.
    const B = env.ss.insertSheet('Boreholes');
    B.getRange(1, 1, 1, gs.COLS_.Boreholes.length).setValues([gs.COLS_.Boreholes.map((c: string[]) => c[1])]);
    B.getRange(2, 1, 1, 12).setValues([['MW-1', 'top of casing', 100, '', T1, T1, T1, T1, T1, T1, 'b1', 1]]);
    const old = ['Reading ID', 'Borehole Name', 'Date', 'Time', 'User Code', 'Reference Point', 'Reference Elevation (ft)', 'Depth to Top of Water (ft)',
      'Water Elevation (ft)', 'Notes', 'Created At', 'Updated At', 'Reading UID', 'Borehole UID', 'Seq', 'Rev', 'Checked by'];
    const S = env.ss.insertSheet('Readings');
    S.getRange(1, 1, 6, old.length).setValues([
      old,
      ['OD-0002', 'MW-1', '2026-10-20', '08:00', 'OD', 'top of casing', 100, 12, 88, 'later', T1, T1, 'ra', 'b1', 2, 3, 'ok'],
      ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''], // a row blanked by a 0.5.0 delete
      ['JD-0001', 'MW-1', '2026-10-19', '07:00', 'JD', 'top of casing', 100, 10, 90, 'first', T1, T1, 'rb', 'b1', 1, 4, '=1+1'],
      ['typed by hand', 'MW-1', '2026-10-21', '', '', '', '', 5, '', 'no uid', '', '', '', '', '', '', 'x'],
      ['OD-0003', 'MW-1', '2026-10-20', '09:00', 'OD', 'top of casing', 100, 13, 87, '', T1, T1, 'rc', 'b1', 3, 5, '']
    ]);
    env._store.set('REV', '5');
    const p = pull();
    expect(p.ok).toBe(true);
    const o = R().objects();
    expect(o.map((x) => [x['Reading ID'], x['Reading UID'], x['Old Reading ID'], x['Checked by']])).toEqual([
      [1, 'rb', 'JD-0001', '#FORMULA'], [2, 'ra', 'OD-0002', 'ok'], [3, 'rc', 'OD-0003', ''], ['typed by hand', '', '', 'x']]);
    expect(R().formulas.get('2,18')).toBe('=1+1');
    expect(o[0]).toMatchObject({ Date: '2026-10-19', 'Depth to Top of Water (ft)': 10, 'Water Elevation (ft)': 90, Notes: 'first', 'User Code': 'JD' });
    // A copy of the old tab is kept, untouched.
    const bk = [...env.ss.sheets.keys()].find((k) => k.startsWith('Readings before 0.6.0'))!;
    expect(sheet(bk).data[1][0]).toBe('OD-0002');
    // Every reading reaches phones again with its new number (Rev bumped past the old cursor).
    expect(pull(5).readings.map((r: ReadingRec) => [r.uid, r.num]).sort()).toEqual([['ra', 2], ['rb', 1], ['rc', 3]]);
    // Running it again keeps the numbers.
    gs.maintenance_(env, true);
    expect(R().objects().slice(0, 3).map((x) => x['Reading ID'])).toEqual([1, 2, 3]);
    expect(R().objects().filter((x) => x['Reading UID']).length).toBe(3);
    // A new reading continues the sequence.
    push([], [rd({ uid: 'rd' })]);
    expect(rec('rd').num).toBe(4);
  });
});

describe('0.6.0 rows deleted by hand', () => {
  it('becomes a final delete: phones are told, and a queued phone edit cannot bring it back', () => {
    three();
    const c0 = pull().cursor;
    R().deleteRow(rowOf('r2') + 1);
    const p = pull(c0);
    expect(p.tombstones).toEqual([{ uid: 'r2', kind: 'reading', deletedAt: expect.any(String), final: true }]);
    expect(sheet('Tombstones').objects()[0]).toMatchObject({ UID: 'r2', Source: 'sheet' });
    // A phone that edited it offline (even "later") pushes: acked, not restored, and the delete is sent again.
    const res = push([], [rd({ uid: 'r2', depthFt: 99, updatedAt: '2030-01-01T00:00:00.000Z' })]);
    expect(res.acked).toEqual(['r:r2']);
    expect(rowOf('r2')).toBe(-1);
    const p2 = pull(p.cursor);
    expect(p2.readings).toEqual([]);
    expect(p2.tombstones.map((t: { uid: string }) => t.uid)).toEqual(['r2']);
    expect(R().objects().map((x) => x['Reading ID'])).toEqual([1, 3]);
  });
  it('putting the row back (Undo / version history) undoes the delete', () => {
    three();
    const i = rowOf('r2'), saved = [...R().data[i]];
    R().deleteRow(i + 1);
    const c = pull().cursor;
    R().data.push(saved);
    const p = pull(c);
    expect(p.tombstones[0]).toMatchObject({ uid: 'r2', restoredAt: expect.any(String) });
    expect(p.readings.map((r: ReadingRec) => [r.uid, r.num])).toEqual([['r2', 2]]);
  });
  it('a delete cut off by a time-out (tombstone written, row still there) is finished', () => {
    three();
    const idx = sheet('Sync Index').data.map((r) => [...r]);
    const i = rowOf('r1'), saved = [...R().data[i]];
    push([], [], [{ uid: 'r1', kind: 'reading', deletedAt: T2 }]);
    // As if the run stopped after the Tombstones write: the row and its index entry are still there.
    R().data.splice(i, 0, saved);
    sheet('Sync Index').data = idx;
    pull();
    expect(rowOf('r1')).toBe(-1);
  });
});

describe('0.6.0 rows edited by hand', () => {
  it('depth, notes, date and time edits flow to phones; Water Elevation is recomputed', () => {
    three();
    const c = pull().cursor;
    edit('r1', 'Depth to Top of Water (ft)', 20);
    edit('r1', 'Notes', 'checked by Odin');
    edit('r1', 'Date', '10/25/2026');
    edit('r1', 'Time', '7:05 pm');
    const p = pull(c);
    expect(p.readings).toHaveLength(1);
    expect(p.readings[0]).toMatchObject({ uid: 'r1', depthFt: 20, notes: 'checked by Odin', datetime: '2026-10-25T19:05' });
    expect(p.readings[0].updatedAt > T1).toBe(true);
    expect(R().objects()[0]).toMatchObject({ 'Water Elevation (ft)': 80, Date: '2026-10-25', Time: '19:05' });
    expect(pull(p.cursor).readings).toEqual([]); // picked up once
  });
  it('changing only Water Elevation sets the depth from it', () => {
    three();
    edit('r2', 'Water Elevation (ft)', 85.5);
    expect(rec('r2')).toMatchObject({ depthFt: 14.5 });
  });
  it('moving a reading to another borehole by name works; bad values and the Reading ID are put back and flagged', () => {
    three();
    edit('r1', 'Borehole Name', 'mw-2');
    edit('r2', 'Depth to Top of Water (ft)', 'abc');
    edit('r3', 'Reading ID', 77);
    edit('r3', 'Borehole Name', 'Nowhere');
    const p = pull();
    const r1 = p.readings.find((r: ReadingRec) => r.uid === 'r1');
    expect(r1).toMatchObject({ boreholeUid: 'b2', boreholeName: 'MW-2' });
    expect(R().objects()[0]['Water Elevation (ft)']).toBe(90); // a reading keeps its own reference elevation
    expect(p.readings.find((r: ReadingRec) => r.uid === 'r2')).toMatchObject({ depthFt: 11 });
    expect(p.readings.find((r: ReadingRec) => r.uid === 'r3')).toMatchObject({ num: 3, boreholeUid: 'b1' });
    expect(R().objects()[2]).toMatchObject({ 'Reading ID': 3, 'Borehole Name': 'MW-1' });
    expect(p.boreholes.find((b: BoreholeRec) => b.uid === 'b1').flag).toMatch(/Reading 3: a sheet edit was put back \(Reading ID .*Borehole Name/);
  });
  it('races: an older phone edit loses to the sheet edit; a newer one wins', () => {
    three();
    edit('r1', 'Depth to Top of Water (ft)', 20);
    push([], [rd({ depthFt: 15, updatedAt: T2 })]); // made before the sheet edit was seen
    expect(rec('r1').depthFt).toBe(20);
    push([], [rd({ depthFt: 16, updatedAt: '2030-01-01T00:00:00.000Z' })]);
    expect(rec('r1').depthFt).toBe(16);
  });
  it('nothing is written if rows moved between reading and writing the sheet', () => {
    three();
    const db = gs.openDb_(env);
    const r = { ...db.r.r1, notes: 'x' };
    gs.putR_(db, r);
    const d = R().data; [d[1], d[2]] = [d[2], d[1]]; // someone sorted the sheet meanwhile
    expect(() => gs.saveAll_(db, env)).toThrow(/changed while syncing/);
    expect(R().objects().map((o) => o.Notes)).toEqual(['', '', '']);
  });
});

describe('0.6.0 review fixes (Code.gs)', () => {
  const nums = () => R().objects().filter((x) => x['Reading UID']).map((x) => [x['Reading UID'], x['Reading ID']]);
  it('a set-up run that stopped half-way is redone from the backup tab, not from the half-written tab', () => {
    three();
    const full = R().data.map((r: unknown[]) => [...r]);
    const bk = env.ss.insertSheet('Readings before 0.6.0 (crash)');
    bk.getRange(1, 1, full.length, full[0].length).setValues(full);
    R().data.splice(2); // the run died after writing one row
    env._store.set('MIGRATING', 'Readings before 0.6.0 (crash)');
    gs.maintenance_(env, true);
    expect(nums()).toEqual([['r1', 1], ['r2', 2], ['r3', 3]]);
    expect(env._store.get('MIGRATING')).toBe('');
  });
  it('re-running set-up never renumbers, even with gaps from deleted rows', () => {
    three();
    R().deleteRow(rowOf('r1') + 1);
    pull();
    gs.maintenance_(env, true);
    expect(nums()).toEqual([['r2', 2], ['r3', 3]]);
    push([], [rd({ uid: 'r9' })]);
    expect(rec('r9').num).toBe(4);
  });
  it('a copied row (same UID twice) holds back deletes until the copy is gone', () => {
    three();
    const copy = [...R().data[rowOf('r2')]];
    R().deleteRow(rowOf('r3') + 1);
    R().data.push(copy);
    pull();
    expect(pull().tombstones.map((t: { uid: string }) => t.uid)).not.toContain('r3');
    R().data.pop();
    expect(pull().tombstones.map((t: { uid: string }) => t.uid)).toContain('r3');
  });
  it('a restored row (Undo) never takes a number back from the sequence holes; a phone guess beyond the batch is ignored', () => {
    three();
    push([], [rd({ uid: 'r4', num: 50 } as Partial<ReadingRec>)]);
    expect(rec('r4').num).toBe(4);
  });
  it('dates typed as d/m/yyyy are read day-first in a non-US spreadsheet', () => {
    three();
    (env.ss as unknown as { getSpreadsheetLocale: () => string }).getSpreadsheetLocale = () => 'en_GB';
    edit('r2', 'Date', '03/04/2026');
    expect(rec('r2').datetime.slice(0, 10)).toBe('2026-04-03');
  });
  it('a copied row cannot bring back a reading a phone deleted; the copy is removed and the delete stands', () => {
    three();
    R().data.push([...R().data[rowOf('r2')]]);
    pull();
    expect(gs.maintenance_(env, false)).toMatch(/appears twice/);
    push([], [], [{ kind: 'reading', uid: 'r2', deletedAt: T2 }]);
    pull();
    expect(rec('r2')).toBeUndefined();
    expect(R().objects().filter((x) => x['Reading UID'] === 'r2').length).toBe(0);
  });
  it('set-up blanks the sync columns of a copied row, so hand deletes are not paused afterwards', () => {
    three();
    R().data.push([...R().data[rowOf('r2')]]);
    env._store.set('LAYOUT', '0');
    pull();
    const copies = R().objects().filter((x) => String(x.Notes).startsWith('Copied row'));
    expect(copies.length).toBe(1);
    expect(copies[0]['Reading UID']).toBe('');
    R().deleteRow(rowOf('r3') + 1);
    expect(pull().tombstones.map((t: { uid: string }) => t.uid)).toContain('r3');
  });
});
