import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import * as db from '../lib/db';
import { syncOnce } from './engine';
import { applyPull } from './apply';
import { displayId } from '../lib/ids';
import { fakeEnv, loadCodeGs, type FakeEnv } from '../../sync/apps-script/fake-sheet.mjs';
import type { AdapterStatus, PullResult, PushBatch, PushResult, SyncAdapter } from './types';

// 0.6.0 phone side: number-only Reading IDs, deletes and edits made by hand in the sheet, races.
const gs = loadCodeGs();
class CodeGsAdapter implements SyncAdapter {
  readonly kind = 'code-gs';
  constructor(public env: FakeEnv) {}
  private call(o: object) {
    const r = JSON.parse(JSON.stringify(gs.handleRequest_(JSON.stringify({ team: 'TEAM-123', ...o }), this.env)));
    if (!r.ok) throw new Error(r.error);
    return r;
  }
  async push(b: PushBatch): Promise<PushResult> { return this.call({ op: 'push', ...b }); }
  async pull(since: number): Promise<PullResult> { return this.call({ op: 'pull', since }); }
  async status(): Promise<AdapterStatus> { return { ok: true, message: 'ok' }; }
}
const phone = () => new IDBFactory();
async function on<T>(p: IDBFactory, fn: () => Promise<T>): Promise<T> {
  await db.closeDb();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = p;
  try { return await fn(); } finally { await db.closeDb(); }
}
const T = (m: number) => new Date(Date.parse('2026-10-26T13:00:00Z') + m * 60000).toISOString();
const bh = (name: string, at = T(0)) => ({ name, referencePoint: 'top of casing', refElevationFt: 100, createdAt: at, updatedAt: at });
const rd = (borehole: string, depthFt: number, datetime = '2026-10-26T09:15', at = T(1)) =>
  ({ borehole, datetime, referencePoint: 'top of casing', refElevationFt: 100, depthFt, userCode: 'OD', createdAt: at, updatedAt: at });
const R = (env: FakeEnv) => env.ss.getSheetByName('Readings')!;
const col = (env: FakeEnv, name: string) => (R(env).data[0] as string[]).indexOf(name);
const rowOf = (env: FakeEnv, uid: string) => R(env).data.findIndex((r) => r[col(env, 'Reading UID')] === uid);
const ids = async () => (await db.allReadings()).map((r) => displayId(r)).sort((a, b) => Number(a) - Number(b));

describe('0.6.0 phone database upgrade (v3 -> v4)', () => {
  it('numbers every reading 1..N in date order and keeps everything else', async () => {
    const p = phone();
    (globalThis as { indexedDB: IDBFactory }).indexedDB = p;
    const old = await openDB(db.DB_NAME, 3, { upgrade(d) {
      d.createObjectStore('boreholes', { keyPath: 'name' }).createIndex('byUid', 'uid');
      const rs = d.createObjectStore('readings', { keyPath: 'id' }); rs.createIndex('byBorehole', 'borehole'); rs.createIndex('byUid', 'uid');
      d.createObjectStore('meta', { keyPath: 'key' }); d.createObjectStore('outbox', { keyPath: 'key' }); d.createObjectStore('tombstones', { keyPath: 'uid' });
    } });
    await old.put('boreholes', { ...bh('MW-1'), uid: 'b1', fieldTimes: {}, flag: '' });
    await old.put('readings', { id: 1, uid: 'u1', boreholeUid: 'b1', seq: 1, ...rd('MW-1', 10, '2026-10-20T08:00') });
    await old.put('readings', { id: 2, uid: 'u2', boreholeUid: 'b1', seq: 2, ...rd('MW-1', 11, '2026-10-18T08:00') });
    await old.put('readings', { id: 3, uid: 'u3', boreholeUid: 'b1', seq: 3, ...rd('MW-1', 12, '2026-10-19T08:00') });
    await old.put('meta', { key: db.CURSOR, value: 42 }); // a 0.5.0 phone that already pulled the migrated sheet
    old.close();
    await on(p, async () => {
      const all = await db.allReadings();
      expect((await (await db.db()).get('meta', db.CURSOR))?.value).toBe(0); // re-pulls everything to get the sheet's numbers
      expect(all.map((r) => [r.uid, r.num, r.seq, r.depthFt]).sort()).toEqual([['u1', 3, 1, 10], ['u2', 1, 2, 11], ['u3', 2, 3, 12]]);
      await db.saveBorehole(bh('MW-2'));
      await db.addReading(rd('MW-2', 1));
      expect(await ids()).toEqual(['1', '2', '3', '4']);
    });
  });
});

describe('0.6.0 numbers across phones', () => {
  it('two phones offline both show 1; after sync the sheet has 1 and 2 and every phone agrees', async () => {
    const env = fakeEnv(), s = new CodeGsAdapter(env);
    const A = phone(), B = phone();
    await on(A, async () => { await db.saveBorehole(bh('MW-1')); await syncOnce(s); });
    await on(B, async () => { await syncOnce(s); });
    await on(A, async () => { await db.addReading(rd('MW-1', 10)); expect(await ids()).toEqual(['1']); });
    await on(B, async () => { await db.addReading(rd('MW-1', 20)); expect(await ids()).toEqual(['1']); });
    await on(A, () => syncOnce(s));
    await on(B, () => syncOnce(s));
    await on(A, () => syncOnce(s));
    const nums = (await on(A, db.allReadings)).map((r) => [r.depthFt, r.num]).sort();
    expect(nums).toEqual([[10, 1], [20, 2]]);
    expect((await on(B, db.allReadings)).map((r) => [r.depthFt, r.num]).sort()).toEqual(nums);
    expect(R(env).objects().map((o) => o['Reading ID'])).toEqual([1, 2]);
    // The next reading on A starts after the sheet's highest number.
    await on(A, async () => { await db.addReading(rd('MW-1', 30)); expect(await ids()).toEqual(['1', '2', '3']); });
  });
});

describe('0.6.0 first upload keeps the phone numbers', () => {
  it('a phone with readings 1..3 (saved out of date order) keeps 1..3 in the sheet', async () => {
    const env = fakeEnv(), s = new CodeGsAdapter(env), A = phone();
    await on(A, async () => {
      await db.saveBorehole(bh('MW-1'));
      await db.addReading(rd('MW-1', 1, '2026-10-26T09:00')); await db.addReading(rd('MW-1', 2, '2026-10-20T09:00')); await db.addReading(rd('MW-1', 3, '2026-10-22T09:00'));
      const before = (await db.allReadings()).map((r) => [r.depthFt, r.num]).sort();
      await syncOnce(s);
      expect((await db.allReadings()).map((r) => [r.depthFt, r.num]).sort()).toEqual(before);
    });
    expect(R(env).objects().map((o) => [o['Depth to Top of Water (ft)'], o['Reading ID']]).sort()).toEqual([[1, 1], [2, 2], [3, 3]]);
  });
});

describe('0.6.0 sheet edits and deletes reach phones', () => {
  async function setup() {
    const env = fakeEnv(), s = new CodeGsAdapter(env), A = phone();
    await on(A, async () => { await db.saveBorehole(bh('MW-1')); await db.addReading(rd('MW-1', 10)); await db.addReading(rd('MW-1', 11, '2026-10-26T10:00')); await syncOnce(s); });
    const uid = R(env).objects()[0]['Reading UID'] as string;
    return { env, s, A, uid };
  }
  it('a row deleted in the sheet disappears from the phone', async () => {
    const { env, s, A, uid } = await setup();
    R(env).deleteRow(rowOf(env, uid) + 1);
    await on(A, async () => { await syncOnce(s); expect((await db.allReadings()).map((r) => r.uid)).not.toContain(uid); expect(await ids()).toEqual(['2']); });
  });
  it('an edit queued on the phone does not bring a sheet-deleted row back (the delete is final)', async () => {
    const { env, s, A, uid } = await setup();
    R(env).deleteRow(rowOf(env, uid) + 1);
    await on(A, async () => {
      const r = (await db.allReadings()).find((x) => x.uid === uid)!;
      await db.updateReading({ ...r, depthFt: 99, updatedAt: new Date(Date.now() + 3_600_000).toISOString() }); // even "newer" than the delete
      await syncOnce(s); await syncOnce(s);
      expect((await db.allReadings()).map((r) => r.uid)).not.toContain(uid);
      expect(await db.outboxCount()).toBe(0);
    });
    expect(rowOf(env, uid)).toBe(-1);
  });
  it('a sheet delete never removes a Local reading with the same number', async () => {
    const { env, s, A, uid } = await setup();
    await on(A, async () => {
      await db.saveBorehole({ ...bh('Mine'), scope: 'local' });
      await db.addReading(rd('Mine', 5));
    });
    R(env).deleteRow(rowOf(env, uid) + 1);
    await on(A, async () => { await syncOnce(s); expect((await db.allReadings()).filter((r) => r.borehole === 'Mine')).toHaveLength(1); });
  });
  it('depth, notes, date/time edited in the sheet show on the phone; a later phone edit still wins for depth', async () => {
    const { env, s, A, uid } = await setup();
    const row = R(env).data[rowOf(env, uid)];
    row[col(env, 'Depth to Top of Water (ft)')] = 15;
    row[col(env, 'Notes')] = 'fixed by Odin';
    row[col(env, 'Date')] = '2026-10-25';
    await on(A, async () => {
      await syncOnce(s);
      const r = (await db.allReadings()).find((x) => x.uid === uid)!;
      expect([r.depthFt, r.notes, r.datetime, r.num]).toEqual([15, 'fixed by Odin', '2026-10-25T09:15', 1]);
      await db.updateReading({ ...r, depthFt: 16, updatedAt: new Date(Date.now() + 60_000).toISOString() });
      await syncOnce(s);
    });
    expect(R(env).objects().find((o) => o['Reading UID'] === uid)).toMatchObject({ 'Depth to Top of Water (ft)': 16, Notes: 'fixed by Odin', Date: '2026-10-25' });
  });
  it('race: a phone edit made before the sheet edit loses (newest wins), on the sheet and on the phone', async () => {
    const { env, s, A, uid } = await setup();
    await on(A, async () => {
      const r = (await db.allReadings()).find((x) => x.uid === uid)!;
      await db.updateReading({ ...r, depthFt: 12, updatedAt: T(2) }); // offline edit, older than the sheet edit below
    });
    R(env).data[rowOf(env, uid)][col(env, 'Depth to Top of Water (ft)')] = 14;
    await on(A, async () => { await syncOnce(s); await syncOnce(s); expect((await db.allReadings()).find((x) => x.uid === uid)!.depthFt).toBe(14); });
    expect(R(env).objects().find((o) => o['Reading UID'] === uid)!['Depth to Top of Water (ft)']).toBe(14);
  });
});

describe('0.6.0 held push clash', () => {
  it('a reading still waiting to upload whose number the sheet gave to another reading is renumbered on the phone', async () => {
    const env = fakeEnv(), s = new CodeGsAdapter(env);
    const A = phone(), B = phone();
    await on(A, async () => { await db.saveBorehole(bh('MW-1')); await syncOnce(s); });
    await on(B, async () => { await syncOnce(s); await db.addReading(rd('MW-1', 20)); expect(await ids()).toEqual(['1']); });
    await on(A, async () => { await db.addReading(rd('MW-1', 10)); await syncOnce(s); });
    // B only pulls (its push is held back): the sheet's reading 1 arrives; B's own one moves off 1 at once.
    await on(B, async () => {
      await applyPull(await s.pull(0));
      const all = await db.allReadings();
      expect(all.map((r) => r.num).sort()).toEqual([1, 2]);
      expect(all.find((r) => r.depthFt === 20)!.num).toBe(2);
    });
  });
});
