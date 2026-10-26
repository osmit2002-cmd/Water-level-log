import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import * as db from '../lib/db';
import { PUSH_CHUNK, syncOnce } from './engine';
import { prepareEnable } from './enable';
import { applyMine, staleBorehole, staleReading } from '../lib/conflict';
import { makeBackup } from '../lib/backup';
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

    // Tombstone: B deletes OD-0001; A's offline edit is OLDER than the delete, so it stays deleted everywhere.
    await on(B, async () => { const r = (await db.allReadings()).find((x) => displayId(x) === 'OD-0001')!; await db.deleteReading(r.id); await syncOnce(sb); });
    await on(A, async () => { const r = (await db.allReadings()).find((x) => displayId(x) === 'OD-0001')!; await db.updateReading({ ...r, depthFt: 99, updatedAt: T(-600) }); await syncOnce(sa); await syncOnce(sa); });
    await on(B, () => syncOnce(sb));
    const a3 = await on(A, snapshot), b3 = await on(B, snapshot);
    expect(a3).toEqual(b3);
    expect(a3.r.map((r) => r[4])).not.toContain('OD-0001');
    expect(env.ss.getSheetByName('Readings')!.objects().map((r) => r['Reading ID'])).not.toContain('OD-0001');

    // Deleting a borehole whose readings the deleting phone had all seen removes them on the other phone (each has its own tombstone).
    await on(A, async () => { await db.deleteBorehole('MW-2'); await syncOnce(sa); });
    await on(B, () => syncOnce(sb));
    expect((await on(B, snapshot)).b.map((b) => b[1])).not.toContain('MW-2');
    expect((await on(B, snapshot)).r.map((r) => r[1])).not.toContain('MW-2');
    expect(await on(A, snapshot)).toEqual(await on(B, snapshot));
  });
});

describe('review fixes (0.4.0)', () => {
  it('a restore keeps queued deletes; queueEverything re-sends reading tombstones', async () => {
    await on(phone(), async () => {
      await db.saveBorehole(bh('MW-1'));
      await db.addReading(rd('MW-1', 10));
      const r = (await db.allReadings())[0];
      await db.deleteReading(r.id);
      await db.replaceAll(await db.allBoreholes(), [], 2);
      expect((await db.outboxAll()).some((o) => o.key === `t:${r.uid}`)).toBe(true);
    });
  });
  it('a reinstalled phone never reuses a display number that came back from the sheet', async () => {
    const env = fakeEnv();
    const a = phone(), a2 = phone();
    await on(a, async () => {
      await db.saveBorehole(bh('MW-1'));
      await db.addReading(rd('MW-1', 10)); await db.addReading(rd('MW-1', 11));
      await syncOnce(new CodeGsAdapter(env));
    });
    await on(a2, async () => {
      await syncOnce(new CodeGsAdapter(env));
      await db.addReading(rd('MW-1', 12));
      expect((await db.allReadings()).map(displayId).sort()).toEqual(['OD-0001', 'OD-0002', 'OD-0003']);
    });
  });
});

const future = (m: number) => new Date(Date.now() + m * 60000).toISOString();
const sheetRows = (env: FakeEnv, name: string) => env.ss.getSheetByName(name)!.objects().filter((r) => Object.values(r).some((v) => v !== ''));

describe('0.4.1 hardening (two phones, real Code.gs)', () => {
  async function setup() {
    const env = fakeEnv();
    const A = phone(), B = phone();
    const sa = new CodeGsAdapter(env), sb = new CodeGsAdapter(env);
    await on(A, async () => { await db.saveBorehole(bh('MW-1')); await db.addReading(rd('MW-1', 10)); await syncOnce(sa); });
    await on(B, () => syncOnce(sb));
    return { env, A, B, sa, sb };
  }

  it('#1/#2 a reading taken offline in a borehole deleted on another phone is kept: borehole restored and flagged everywhere', async () => {
    const { env, A, B, sa, sb } = await setup();
    sa.offline = true;
    await on(A, async () => { await db.addReading(rd('MW-1', 11, 'OD', T(5))); });
    await on(B, async () => { await db.deleteBorehole('MW-1'); await syncOnce(sb); });
    sa.offline = false;
    const run = await on(A, () => syncOnce(sa));
    // round 1: the sheet holds the reading (borehole deleted); the pull restores the borehole and round 2 sends both
    expect(run.held).toEqual([]);
    await on(B, () => syncOnce(sb));
    const a = await on(A, snapshot), b = await on(B, snapshot);
    expect(a).toEqual(b);
    expect(a.b.map((x) => x[1])).toEqual(['MW-1']);
    expect(a.r.map((r) => r[2])).toEqual([11]); // the deleted reading stays deleted, the offline one survives
    expect((await on(B, db.allBoreholes))[0].flag).toMatch(/kept/);
    expect(sheetRows(env, 'Readings').map((r) => r['Depth to Top of Water (ft)'])).toEqual([11]);
    expect(await on(A, db.outboxCount)).toBe(0);
  });

  it('#1 deleting a borehole never removes readings the deleting phone had not seen yet', async () => {
    const { A, B, sa, sb } = await setup();
    await on(A, async () => { await db.addReading(rd('MW-1', 12, 'OD', T(5))); await syncOnce(sa); });
    await on(B, async () => { await db.deleteBorehole('MW-1'); await syncOnce(sb); }); // B never pulled reading 12
    await on(A, () => syncOnce(sa));
    const a = await on(A, snapshot), b = await on(B, snapshot);
    expect(a).toEqual(b);
    expect(a.r.map((r) => r[2])).toEqual([12]);
  });

  it('#7 a remote delete wins over an older local edit, and loses to a newer one (restored and flagged)', async () => {
    const { env, A, B, sa, sb } = await setup();
    sa.offline = true;
    await on(B, async () => { await db.deleteReading((await db.allReadings())[0].id); await syncOnce(sb); });
    await on(A, async () => { const r = (await db.allReadings())[0]; await db.updateReading({ ...r, depthFt: 13, updatedAt: future(5) }); });
    sa.offline = false;
    await on(A, () => syncOnce(sa));
    await on(B, () => syncOnce(sb));
    const a = await on(A, snapshot), b = await on(B, snapshot);
    expect(a).toEqual(b);
    expect(a.r.map((r) => r[2])).toEqual([13]);
    expect((await on(B, db.allBoreholes))[0].flag).toMatch(/edited later/);
    expect(sheetRows(env, 'Tombstones')[0]['Restored At']).not.toBe('');
    // B has no stale local tombstone left for it
    expect(await on(B, db.allTombstones)).toEqual([]);
  });

  it('#7 the same rule when the delete arrives at the editing phone first (pull side)', async () => {
    const { A, B, sa, sb } = await setup();
    await on(B, async () => { await db.deleteReading((await db.allReadings())[0].id); await syncOnce(sb); });
    // A edits after the delete but before syncing; the edit is still waiting when the delete is pulled
    await on(A, async () => {
      const r = (await db.allReadings())[0];
      await db.updateReading({ ...r, depthFt: 14, updatedAt: future(5) });
      await syncOnce(sa);
    });
    await on(B, () => syncOnce(sb));
    expect((await on(B, snapshot)).r.map((r) => r[2])).toEqual([14]);
  });

  it('#4 a sync that times out half-way is finished by the next sync without duplicates', async () => {
    const env = fakeEnv();
    const s = new CodeGsAdapter(env);
    await on(phone(), async () => {
      await db.saveBorehole(bh('MW-1'));
      for (let i = 0; i < 5; i++) await db.addReading(rd('MW-1', i));
      await syncOnce(s); // sheets exist
      for (let i = 5; i < 10; i++) await db.addReading(rd('MW-1', i));
      env.ss.failAfter = 0;
      await expect(syncOnce(s)).rejects.toThrow(/execution time/);
      expect(await db.outboxCount()).toBe(5); // nothing acked, nothing lost
      await syncOnce(s);
      expect(await db.outboxCount()).toBe(0);
    });
    const ids = sheetRows(env, 'Readings').map((r) => r['Reading UID']);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it('#4 large queues go in chunks the server accepts', async () => {
    const m = new MockAdapter();
    await on(phone(), async () => {
      await db.saveBorehole(bh('MW-1'));
      for (let i = 0; i < 2 * PUSH_CHUNK + 5; i++) await db.addReading(rd('MW-1', i));
      await syncOnce(m);
      expect(await db.outboxCount()).toBe(0);
    });
    expect(m.calls.filter((c) => c === 'push')).toHaveLength(3);
    expect(PUSH_CHUNK).toBeLessThanOrEqual(250);
  });

  it('#5 readings of a refused borehole are failed too, linked to it, and retrying the borehole retries them', async () => {
    const m = new MockAdapter();
    await on(phone(), async () => {
      await db.saveBorehole(bh('MW-1'));
      await db.addReading(rd('MW-1', 10)); await db.addReading(rd('MW-1', 11));
      const b = (await db.allBoreholes())[0];
      m.reject = (k) => (k === `b:${b.uid}` ? 'Reference Elevation is not a number' : undefined);
      const run = await syncOnce(m);
      expect(run.held).toEqual([]);
      let st = await db.outboxStats();
      expect(st.waiting).toBe(0);
      expect(st.failed).toHaveLength(3);
      const rf = st.failed.filter((f) => f.kind === 'reading');
      expect(rf.every((f) => f.failedBy === `b:${b.uid}` && /MW-1 was refused \(Reference Elevation is not a number\)/.test(f.failed!))).toBe(true);
      m.reject = () => undefined;
      await db.retryFailed(`b:${b.uid}`);
      await syncOnce(m);
      st = await db.outboxStats();
      expect(st).toEqual({ waiting: 0, failed: [] });
      expect(m.r.size).toBe(2);
    });
  });

  it('#6 saving a stale form for a reading whose borehole was deleted restores both, flagged, on every phone', async () => {
    const { env, A, B, sa, sb } = await setup();
    const old = await on(A, async () => (await db.allReadings())[0]);
    await on(B, async () => { await db.deleteBorehole('MW-1'); await syncOnce(sb); });
    await on(A, () => syncOnce(sa)); // A's copy is gone now; its form was still open
    expect(await on(A, db.allBoreholes)).toEqual([]);
    await on(A, async () => { await db.updateReading({ ...old, depthFt: 13, updatedAt: new Date().toISOString() }); await syncOnce(sa); });
    await on(B, () => syncOnce(sb));
    for (const p of [A, B]) {
      const bs = await on(p, db.allBoreholes);
      expect(bs.map((b) => [b.name, b.flag])).toEqual([['MW-1', expect.stringMatching(/brought back|kept|restored/i)]]);
      expect((await on(p, db.allReadings)).map((r) => r.depthFt)).toEqual([13]);
    }
    expect(sheetRows(env, 'Readings').map((r) => r['Depth to Top of Water (ft)'])).toEqual([13]);
    expect(await on(A, db.outboxCount)).toBe(0);
  });

  it('review: a stale reading form keeps a borehole rename made meanwhile (found by uid, not by the old name)', async () => {
    const { env, A, B, sa, sb } = await setup();
    const old = await on(A, async () => (await db.allReadings())[0]);
    await on(B, async () => { const b = (await db.allBoreholes())[0]; await db.saveBorehole({ ...b, name: 'MW-1A', updatedAt: new Date().toISOString() }, 'MW-1'); await syncOnce(sb); });
    await on(A, () => syncOnce(sa));
    await on(A, async () => { await db.updateReading({ ...old, depthFt: 14, updatedAt: new Date().toISOString() }); await syncOnce(sa); });
    await on(B, () => syncOnce(sb));
    for (const p of [A, B]) {
      expect((await on(p, db.allBoreholes)).map((b) => [b.name, b.flag ?? ''])).toEqual([['MW-1A', '']]);
      expect((await on(p, db.allReadings)).map((r) => [r.borehole, r.depthFt])).toEqual([['MW-1A', 14]]);
    }
    expect(sheetRows(env, 'Boreholes').map((b) => b['Borehole Name'])).toEqual(['MW-1A']);
  });

  it('review: discarding a refused borehole discards its linked readings too (kept for the backup)', async () => {
    const m = new MockAdapter();
    await on(phone(), async () => {
      await db.saveBorehole(bh('MW-1')); await db.addReading(rd('MW-1', 10));
      const b = (await db.allBoreholes())[0];
      m.reject = (k) => (k === `b:${b.uid}` ? 'bad' : undefined);
      await syncOnce(m);
      expect((await db.outboxStats()).failed).toHaveLength(2);
      await db.discardFailed(`b:${b.uid}`);
      expect(await db.outboxCount()).toBe(0);
      expect((await db.getDiscarded()).map((d) => d.item.kind).sort()).toEqual(['borehole', 'reading']);
    });
  });

  it('#5 rejected changes become "failed" with the reason, are not resent, and can be retried or discarded (kept in backups)', async () => {
    const m = new MockAdapter();
    await on(phone(), async () => {
      await db.saveBorehole(bh('MW-1'));
      await db.addReading(rd('MW-1', 10)); await db.addReading(rd('MW-1', 11));
      const [r1, r2] = await db.allReadings();
      m.reject = (k) => (k === `r:${r1.uid}` || k === `r:${r2.uid}` ? 'Reading date/time is not valid' : undefined);
      const run = await syncOnce(m);
      expect(run.rejected).toHaveLength(2);
      let st = await db.outboxStats();
      expect(st.waiting).toBe(0);
      expect(st.failed.map((f) => f.failed)).toEqual(['Reading date/time is not valid', 'Reading date/time is not valid']);
      const pushes = m.calls.length;
      await syncOnce(m);
      expect(m.calls.length - pushes).toBe(1); // only a pull: failed items are not resent
      m.reject = () => undefined;
      await db.retryFailed(`r:${r1.uid}`);
      await syncOnce(m);
      st = await db.outboxStats();
      expect(st.failed.map((f) => f.key)).toEqual([`r:${r2.uid}`]);
      expect([...m.r.keys()]).toEqual([r1.uid]);
      await db.discardFailed(`r:${r2.uid}`);
      expect((await db.outboxStats()).failed).toEqual([]);
      const disc = await db.getDiscarded();
      expect(disc[0].item).toMatchObject({ key: `r:${r2.uid}`, failed: 'Reading date/time is not valid' });
      expect((await db.allReadings()).map((r) => r.uid)).toContain(r2.uid); // the record itself stays on the phone
      const b = makeBackup(await db.allBoreholes(), await db.allReadings(), {} as never, 3, 't', { failed: [], discarded: disc });
      expect(b.unsynced!.discarded).toHaveLength(1);
      // a new edit of a failed item gets a fresh try
      await db.updateReading({ ...r2, depthFt: 12, updatedAt: T(9) });
      expect((await db.outboxStats()).waiting).toBe(1);
    });
  });

  it('#5 the real Code.gs rejections reach the phone as failed items', async () => {
    const env = fakeEnv();
    await on(phone(), async () => {
      await db.saveBorehole(bh('MW-1'));
      await db.addReading({ ...rd('MW-1', 10), datetime: 'not a date' });
      await syncOnce(new CodeGsAdapter(env));
      expect((await db.outboxStats()).failed.map((f) => f.failed)).toEqual(['Reading date/time is not valid']);
    });
  });

  it('#6 stale-form detection and field-wise apply', async () => {
    await on(phone(), async () => {
      await db.saveBorehole(bh('MW-1'));
      await db.addReading(rd('MW-1', 10));
      const base = (await db.allReadings())[0];
      expect(staleReading(base, await db.getReading(base.id))).toBeNull();
      await db.updateReading({ ...base, depthFt: 11, updatedAt: T(3) }); // e.g. a sync landed
      expect(staleReading(base, await db.getReading(base.id))).toEqual({ kind: 'changed', fields: ['depthFt'] });
      await db.deleteReading(base.id);
      expect(staleReading(base, await db.getReading(base.id))).toEqual({ kind: 'deleted' });
      // "Restore it with my values" drops the local delete
      await db.updateReading({ ...base, depthFt: 15, updatedAt: T(4) });
      expect(await db.allTombstones()).toEqual([]);
      expect((await db.outboxAll()).map((o) => o.key).filter((k) => k.startsWith('t:'))).toEqual([]);
      const bBase = (await db.allBoreholes())[0];
      await db.saveBorehole({ ...bBase, refElevationFt: 105, updatedAt: T(5) }, 'MW-1');
      const cur = (await db.allBoreholes())[0];
      expect(staleBorehole(bBase, cur)).toEqual({ kind: 'changed', fields: ['refElevationFt'] });
      // my form only changed the reference point: the newer elevation survives
      expect(applyMine(bBase, cur, { name: 'MW-1', referencePoint: 'collar', refElevationFt: bBase.refElevationFt })).toMatchObject({ refElevationFt: 105, referencePoint: 'collar' });
    });
  });

  it('#8 sync off, restore an old backup (no ids), sync on: matched by natural key, no duplicates on the sheet', async () => {
    const { env, A, sa } = await setup();
    await on(A, async () => {
      await db.addReading(rd('MW-1', 20, 'OD', T(6)));
      await syncOnce(sa);
      // an old (v3) backup: same data, no uids / seq
      const old = (await db.allReadings()).map(({ uid: _u, seq: _s, boreholeUid: _b, ...r }) => ({ ...r, borehole: r.borehole.toLowerCase() }));
      const bs = (await db.allBoreholes()).map(({ uid: _u, fieldTimes: _f, flag: _g, ...b }) => ({ ...b, name: b.name.toLowerCase() }));
      await db.replaceAll(bs as never, [...old, { ...rd('mw-1', 30, 'OD', T(7)), id: 99 }], 100);
      const matched = await prepareEnable(sa);
      expect(matched).toEqual({ boreholes: 1, readings: 2 });
      await syncOnce(sa);
      expect(await db.outboxCount()).toBe(0);
    });
    expect(sheetRows(env, 'Boreholes')).toHaveLength(1);
    expect(sheetRows(env, 'Readings').map((r) => r['Depth to Top of Water (ft)']).sort()).toEqual([10, 20, 30]);
    const a = await on(A, snapshot);
    expect(a.r).toHaveLength(3);
    expect(a.r.map((r) => r[4]).sort()).toEqual(['OD-0001', 'OD-0002', 'OD-0099']);
  });
});
