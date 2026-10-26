import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import * as db from '../lib/db';
import { syncOnce } from './engine';
import { MockAdapter } from './mock';
import { displayId } from '../lib/ids';
import { fakeEnv, loadCodeGs, type FakeEnv } from '../../sync/apps-script/fake-sheet.mjs';
import type { AdapterStatus, PullResult, PushBatch, PushResult, SyncAdapter } from './types';

const gs = loadCodeGs();
/** Adapter that runs the real Code.gs against a fake Sheet (JSON round trip like the network). */
class CodeGsAdapter implements SyncAdapter {
  readonly kind = 'code-gs';
  offline = false;
  constructor(public env: FakeEnv, public team = 'TEAM-123') {}
  private call(o: object) {
    if (this.offline) throw new Error('offline');
    const r = JSON.parse(JSON.stringify(gs.handleRequest_(JSON.stringify({ team: this.team, ...o }), this.env)));
    if (!r.ok) throw new Error(r.error);
    return r;
  }
  async push(b: PushBatch): Promise<PushResult> { return this.call({ op: 'push', ...b }); }
  async pull(since: number): Promise<PullResult> { return this.call({ op: 'pull', since }); }
  async status(): Promise<AdapterStatus> { return { ok: true, message: 'ok' }; }
}

/** Each phone has its own IndexedDB. */
function phone() { return new IDBFactory(); }
async function on<T>(p: IDBFactory, fn: () => Promise<T>): Promise<T> {
  await db.closeDb();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = p;
  try { return await fn(); } finally { await db.closeDb(); }
}
const T = (m: number) => new Date(Date.parse('2026-10-26T13:00:00Z') + m * 60000).toISOString();
const bh = (name: string, elev = 100, at = T(0)) => ({ name, referencePoint: 'top of casing', refElevationFt: elev, createdAt: at, updatedAt: at });
const rd = (borehole: string, depthFt: number, userCode = 'OD', at = T(1)) => ({ borehole, datetime: '2026-10-26T09:15', referencePoint: 'top of casing', refElevationFt: 100, depthFt, userCode, createdAt: at, updatedAt: at });
const snapshot = async () => ({
  b: (await db.allBoreholes()).map((b) => [b.uid, b.name, b.refElevationFt, b.referencePoint]).sort(),
  r: (await db.allReadings()).map((r) => [r.uid, r.borehole, r.depthFt, r.refElevationFt, displayId(r)]).sort()
});

describe('outbox queue', () => {
  it('every local change is queued; edits coalesce; deletes become tombstones', async () => {
    await on(phone(), async () => {
      await db.saveBorehole(bh('MW-1'));
      const id = await db.addReading(rd('MW-1', 10));
      expect((await db.outboxAll()).map((o) => o.key[0]).sort()).toEqual(['b', 'r']);
      const r = (await db.allReadings())[0];
      await db.updateReading({ ...r, depthFt: 11, updatedAt: T(2) });
      expect(await db.outboxCount()).toBe(2);
      expect(((await db.outboxAll()).find((o) => o.kind === 'reading')!.rec as { depthFt: number }).depthFt).toBe(11);
      await db.deleteReading(id);
      const kinds = (await db.outboxAll()).map((o) => o.kind).sort();
      expect(kinds).toEqual(['borehole', 'tombstone']);
      expect((await db.allTombstones())[0]).toMatchObject({ uid: r.uid, kind: 'reading' });
    });
  });
  it('display IDs use the per-phone running number and the User Code at save', async () => {
    await on(phone(), async () => {
      await db.saveBorehole(bh('MW-1'));
      await db.addReading(rd('MW-1', 1, 'OD'));
      await db.addReading(rd('MW-1', 2, 'JD'));
      expect((await db.allReadings()).map(displayId)).toEqual(['OD-0001', 'JD-0002']);
    });
  });
  it('items leave the queue only after the server acknowledges them, and a newer edit made during sync stays', async () => {
    await on(phone(), async () => {
      const m = new MockAdapter();
      await db.saveBorehole(bh('MW-1'));
      await db.addReading(rd('MW-1', 10));
      m.failNext = 1;
      await expect(syncOnce(m)).rejects.toThrow(/no signal/);
      expect(await db.outboxCount()).toBe(2);
      m.dropAcks = true;
      await syncOnce(m);
      expect(await db.outboxCount()).toBe(2); // sent but not acknowledged: still queued
      m.dropAcks = false;
      // simulate an edit landing between push and ack
      const sent = await db.outboxAll();
      const r = (await db.allReadings())[0];
      await db.updateReading({ ...r, depthFt: 12, updatedAt: T(5) });
      await db.outboxAck(sent, sent.map((s) => s.key));
      expect((await db.outboxAll()).map((o) => o.key)).toEqual([`r:${r.uid}`]);
      await syncOnce(m);
      expect(await db.outboxCount()).toBe(0);
      expect([...m.r.values()][0].depthFt).toBe(12);
    });
  });
});

describe('two phones through the real Apps Script logic', () => {
  it('converge: offline work on both phones, field-by-field borehole edits, same-name merge, tombstones', async () => {
    const env = fakeEnv();
    const A = phone(), B = phone();
    const sa = new CodeGsAdapter(env), sb = new CodeGsAdapter(env);
    // Phone A creates MW-1 and a reading, syncs.
    await on(A, async () => { await db.saveBorehole(bh('MW-1')); await db.addReading(rd('MW-1', 10, 'OD')); await syncOnce(sa); });
    // Phone B (with older local data of its own) joins: queue everything, sync.
    await on(B, async () => { await db.saveBorehole(bh('MW-2', 200)); await db.addReading(rd('MW-2', 20, 'JD')); await db.queueEverything(); await syncOnce(sb); });
    await on(A, () => syncOnce(sa));
    const a1 = await on(A, snapshot), b1 = await on(B, snapshot);
    expect(a1).toEqual(b1);
    expect(a1.r.map((r) => r[4])).toEqual(expect.arrayContaining(['OD-0001', 'JD-0001']));

    // Both offline: A renames MW-1, B changes its reference elevation; both create "MW-3" independently.
    sa.offline = sb.offline = true;
    await on(A, async () => {
      const b = (await db.allBoreholes()).find((x) => x.name === 'MW-1')!;
      await db.saveBorehole({ ...b, name: 'MW-1A', updatedAt: T(10) }, 'MW-1');
      await db.saveBorehole(bh('MW-3', 300, T(11)));
      await db.addReading(rd('MW-3', 30, 'OD', T(12)));
      await expect(syncOnce(sa)).rejects.toThrow('offline');
    });
    await on(B, async () => {
      const b = (await db.allBoreholes()).find((x) => x.name === 'MW-1')!;
      await db.saveBorehole({ ...b, refElevationFt: 101, updatedAt: T(13) }, 'MW-1');
      await db.saveBorehole(bh('mw-3', 301, T(14)));
      await db.addReading(rd('mw-3', 31, 'JD', T(15)));
    });
    // Back online, in any order, twice.
    sa.offline = sb.offline = false;
    for (let i = 0; i < 2; i++) { await on(B, () => syncOnce(sb)); await on(A, () => syncOnce(sa)); }
    const a2 = await on(A, snapshot), b2 = await on(B, snapshot);
    expect(a2).toEqual(b2);
    const mw1 = (await on(A, db.allBoreholes)).find((b) => b.name === 'MW-1A')!;
    expect(mw1.refElevationFt).toBe(101); // both field edits survive
    const bs = await on(B, db.allBoreholes);
    // B reached the sheet first, so its spelling "mw-3" is kept for the merged borehole.
    expect(bs.map((b) => b.name).sort()).toEqual(['MW-1A', 'MW-2', 'mw-3']);
    expect(bs.find((b) => b.name === 'mw-3')!.flag).toMatch(/two phones/);
    expect(a2.r.filter((r) => r[1] === 'mw-3')).toHaveLength(2); // readings from both phones land on the merged borehole
    // The reading saved before the elevation change keeps its snapshot.
    expect(a2.r.find((r) => r[4] === 'OD-0001')![3]).toBe(100);
    expect(await on(A, db.outboxCount)).toBe(0);
    expect(await on(B, db.outboxCount)).toBe(0);

    // Tombstone: B deletes OD-0001; A edits it offline afterwards; it stays deleted everywhere.
    await on(B, async () => { const r = (await db.allReadings()).find((x) => displayId(x) === 'OD-0001')!; await db.deleteReading(r.id); await syncOnce(sb); });
    await on(A, async () => { const r = (await db.allReadings()).find((x) => displayId(x) === 'OD-0001')!; await db.updateReading({ ...r, depthFt: 99, updatedAt: T(30) }); await syncOnce(sa); await syncOnce(sa); });
    await on(B, () => syncOnce(sb));
    const a3 = await on(A, snapshot), b3 = await on(B, snapshot);
    expect(a3).toEqual(b3);
    expect(a3.r.map((r) => r[4])).not.toContain('OD-0001');
    expect(env.ss.getSheetByName('Readings')!.objects().map((r) => r['Reading ID'])).not.toContain('OD-0001');

    // Borehole delete cascades to its readings on the other phone.
    await on(A, async () => { await db.deleteBorehole('MW-2'); await syncOnce(sa); });
    await on(B, () => syncOnce(sb));
    expect((await on(B, snapshot)).b.map((b) => b[1])).not.toContain('MW-2');
    expect((await on(B, snapshot)).r.map((r) => r[1])).not.toContain('MW-2');
    expect(await on(A, snapshot)).toEqual(await on(B, snapshot));
  });
});
