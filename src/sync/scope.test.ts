import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import * as db from '../lib/db';
import { PUSH_CHUNK, syncOnce } from './engine';
import { prepareEnable } from './enable';
import { makeBackup, validateBackup } from '../lib/backup';
import { boreholesCsv, parseBoreholesCsv } from '../lib/csv';
import { DEFAULT_SETTINGS, scopeOf } from '../lib/types';
import { fakeEnv, loadCodeGs, type FakeEnv } from '../../sync/apps-script/fake-sheet.mjs';
import type { AdapterStatus, PullResult, PushBatch, PushResult, SyncAdapter } from './types';

/** 0.5.0 Local / Shared boreholes, against the real Code.gs on a fake Sheet. */
const gs = loadCodeGs();
class Sheet implements SyncAdapter {
  readonly kind = 'code-gs';
  pushed: PushBatch[] = [];
  constructor(public env: FakeEnv) {}
  private call(o: object) {
    const r = JSON.parse(JSON.stringify(gs.handleRequest_(JSON.stringify({ team: 'TEAM-123', ...o }), this.env)));
    if (!r.ok) throw new Error(r.error);
    return r;
  }
  async push(b: PushBatch): Promise<PushResult> { this.pushed.push(JSON.parse(JSON.stringify(b))); return this.call({ op: 'push', ...b }); }
  async pull(since: number): Promise<PullResult> { return this.call({ op: 'pull', since }); }
  async status(): Promise<AdapterStatus> { return { ok: true, message: 'ok' }; }
  all = () => this.pull(0);
}
const sheet = () => new Sheet(fakeEnv());
const phone = () => new IDBFactory();
async function on<T>(p: IDBFactory, fn: () => Promise<T>): Promise<T> {
  await db.closeDb();
  (globalThis as { indexedDB: IDBFactory }).indexedDB = p;
  try { return await fn(); } finally { await db.closeDb(); }
}
const T = (m: number) => new Date(Date.parse('2026-10-26T13:00:00Z') + m * 60000).toISOString();
const bh = (name: string, scope?: 'local' | 'shared', elev = 100) => ({ name, referencePoint: 'top of casing', refElevationFt: elev, createdAt: T(0), updatedAt: T(0), ...(scope ? { scope } : {}) });
const rd = (borehole: string, depthFt: number, userCode = 'OD', minute = 15) => ({ borehole, datetime: `2026-10-26T09:${String(minute % 60).padStart(2, '0')}`, referencePoint: 'top of casing', refElevationFt: 100, depthFt, userCode, createdAt: T(1), updatedAt: T(1) });
const names = async () => (await db.allBoreholes()).map((b) => `${b.name}:${scopeOf(b)}${b.hidden ? ':hidden' : ''}`).sort();

describe('queue exclusion', () => {
  it('Local boreholes and their readings never enter the outbox (add, edit, rename, delete)', async () => {
    await on(phone(), async () => {
      await db.saveBorehole(bh('LOC-1', 'local'));
      const id = await db.addReading(rd('LOC-1', 5));
      const r = (await db.allReadings())[0];
      await db.updateReading({ ...r, depthFt: 6, updatedAt: T(2) });
      await db.saveBorehole({ ...(await db.getBorehole('LOC-1'))!, name: 'LOC-2', updatedAt: T(3) }, 'LOC-1');
      expect(await db.outboxCount()).toBe(0);
      expect(scopeOf(await db.getBorehole('LOC-2'))).toBe('local'); // an edit keeps the scope
      await db.deleteReading(id);
      await db.deleteBorehole('LOC-2');
      expect(await db.outboxCount()).toBe(0);
      expect((await db.allTombstones()).every((t) => t.localOnly)).toBe(true);
      await db.queueEverything(); // turning sync on later does not send the local deletes either
      expect(await db.outboxCount()).toBe(0);
    });
  });
  it('a shared borehole next to a local one syncs normally; the sheet never sees the local one', async () => {
    const s = sheet();
    await on(phone(), async () => {
      await db.saveBorehole(bh('MW-1'));
      await db.saveBorehole(bh('LOC-1', 'local'));
      await db.addReading(rd('MW-1', 10));
      await db.addReading(rd('LOC-1', 5));
      expect((await db.outboxAll()).map((o) => o.key[0]).sort()).toEqual(['b', 'r']);
      await syncOnce(s);
      expect(await db.outboxCount()).toBe(0);
      expect(await names()).toEqual(['LOC-1:local', 'MW-1:shared']);
      expect((await db.allReadings()).length).toBe(2);
    });
    const all = await s.all();
    expect(all.boreholes.map((b) => b.name)).toEqual(['MW-1']);
    expect(all.readings.map((r) => r.boreholeName)).toEqual(['MW-1']);
    expect(JSON.stringify(s.pushed)).not.toContain('LOC-1');
  });
  it('the engine drops a stray queued Local item before pushing (safety net)', async () => {
    const s = sheet();
    await on(phone(), async () => {
      await db.saveBorehole(bh('LOC-1', 'local'));
      const b = (await db.getBorehole('LOC-1'))!;
      const tx = await db._rw(['outbox']);
      await tx.objectStore('outbox').put({ key: `b:${b.uid}`, kind: 'borehole', rec: db.toBRec(b), ver: 'x' });
      await tx.done;
      await syncOnce(s);
      expect(await db.outboxCount()).toBe(0);
    });
    expect((await s.all()).boreholes).toEqual([]);
  });
});

describe('migration', () => {
  it('boreholes from before 0.5.0 (no scope) are Shared and upload when sync is turned on', async () => {
    const s = sheet();
    await on(phone(), async () => {
      // As stored by 0.4.x: no scope field at all.
      const tx = await db._rw(['boreholes', 'readings']);
      await tx.objectStore('boreholes').put({ ...bh('OLD-1'), uid: 'old-borehole-uid-1' });
      await tx.objectStore('readings').put({ ...rd('OLD-1', 3), id: 1, uid: 'old-reading-uid-1', boreholeUid: 'old-borehole-uid-1', seq: 1 });
      await tx.done;
      expect(scopeOf(await db.getBorehole('OLD-1'))).toBe('shared');
      await prepareEnable(s);
      expect(await db.outboxCount()).toBe(2);
      await syncOnce(s);
    });
    const all = await s.all();
    expect(all.boreholes.map((b) => b.uid)).toEqual(['old-borehole-uid-1']);
    expect(all.readings.map((r) => r.uid)).toEqual(['old-reading-uid-1']);
  });
  it('pulled boreholes are always Shared', async () => {
    const s = sheet();
    await on(phone(), async () => { await db.saveBorehole(bh('MW-1')); await db.addReading(rd('MW-1', 1)); await syncOnce(s); });
    await on(phone(), async () => { await syncOnce(s); expect(await names()).toEqual(['MW-1:shared']); });
  });
  it('old backups restore as Shared; new backups keep Local and hidden', async () => {
    const old = { ...makeBackup([{ ...bh('MW-1'), uid: 'aaaaaaaa-1' }], [{ ...rd('MW-1', 2), id: 1 }], DEFAULT_SETTINGS, 2, '0.4.3') };
    const v = validateBackup(JSON.parse(JSON.stringify(old))).backup;
    expect(v.boreholes[0].scope).toBeUndefined();
    const nb = makeBackup([{ ...bh('LOC-1', 'local'), uid: 'bbbbbbbb-1' }, { ...bh('MW-2'), uid: 'cccccccc-1', hidden: true }], [{ ...rd('LOC-1', 2), id: 1 }], DEFAULT_SETTINGS, 2, '0.5.0');
    const v2 = validateBackup(JSON.parse(JSON.stringify(nb))).backup;
    expect(v2.boreholes.map((b) => [b.name, scopeOf(b), !!b.hidden])).toEqual([['LOC-1', 'local', false], ['MW-2', 'shared', true]]);
    expect(() => validateBackup({ ...nb, boreholes: [{ ...nb.boreholes[0], scope: 'public' }] })).toThrow(/bad scope/);
    await on(phone(), async () => {
      await db.replaceAll(v2.boreholes, v2.readings, v2.nextReadingId);
      expect(await names()).toEqual(['LOC-1:local', 'MW-2:shared:hidden']);
      expect((await db.outboxAll()).map((o) => o.key)).toEqual(['b:cccccccc-1']); // the Local borehole and its reading are not queued
    });
  });
  it('boreholes CSV carries the scope; import creates Local ones but never converts an existing borehole', async () => {
    await on(phone(), async () => {
      await db.saveBorehole(bh('MW-1'));
      const csv = boreholesCsv([{ ...bh('MW-1'), scope: 'local' }, bh('NEW-1', 'local'), bh('NEW-2')], 'ft');
      expect(csv).toContain('Local');
      const res = parseBoreholesCsv(csv, 'ft');
      await db.upsertBoreholes(res.rows);
      expect(await names()).toEqual(['MW-1:shared', 'NEW-1:local', 'NEW-2:shared']);
    });
  });
});

describe('Local -> Shared', () => {
  it('uploads the borehole and its whole history; borehole first, even across push chunks', async () => {
    const s = sheet();
    const n = PUSH_CHUNK + 30;
    await on(phone(), async () => {
      await db.saveBorehole(bh('LOC-1', 'local'));
      for (let i = 0; i < n; i++) await db.addReading(rd('LOC-1', i, 'OD', i));
      await syncOnce(s);
      expect((await s.all()).boreholes).toEqual([]);
      expect(await db.shareBorehole('LOC-1')).toBe(n);
      expect(scopeOf(await db.getBorehole('LOC-1'))).toBe('shared');
      const run = await syncOnce(s);
      expect(run.held).toEqual([]);
      expect(run.rejected).toEqual([]);
      expect(await db.outboxCount()).toBe(0);
      expect(await db.orphanCount()).toBe(0);
    });
    // The first push request carried the borehole.
    const first = s.pushed.find((p) => p.boreholes.length || p.readings.length)!;
    expect(first.boreholes.map((b) => b.name)).toEqual(['LOC-1']);
    const all = await s.all();
    expect(all.readings.length).toBe(n);
    await on(phone(), async () => { await syncOnce(s); expect((await db.allReadings()).length).toBe(n); expect(await names()).toEqual(['LOC-1:shared']); });
  });
});

describe('Shared -> Local (make a local copy)', () => {
  it('forks a new Local borehole; nothing is deleted on the sheet and no duplicate comes back on pull', async () => {
    const s = sheet();
    const A = phone(), B = phone();
    await on(A, async () => { await db.saveBorehole(bh('MW-1')); await db.addReading(rd('MW-1', 10)); await db.addReading(rd('MW-1', 11, 'OD', 20)); await syncOnce(s); });
    const before = await s.all();
    await on(A, async () => {
      const name = db.localCopyName((await db.allBoreholes()).map((b) => b.name), 'MW-1');
      expect(name).toBe('MW-1 (local)');
      expect(await db.makeLocalCopy('MW-1', name, true)).toEqual({ name, readings: 2 });
      expect(await db.outboxCount()).toBe(0);
      expect(await names()).toEqual(['MW-1 (local):local', 'MW-1:shared:hidden']);
      const rs = await db.allReadings();
      expect(rs.length).toBe(4);
      expect(new Set(rs.map((r) => r.uid)).size).toBe(4);
      await syncOnce(s);
      await db.resetCursor(); // a full re-pull
      await syncOnce(s);
      expect(await names()).toEqual(['MW-1 (local):local', 'MW-1:shared:hidden']);
      expect((await db.allReadings()).length).toBe(4);
    });
    const after = await s.all();
    expect(after.boreholes.map((b) => b.uid)).toEqual(before.boreholes.map((b) => b.uid));
    expect(after.readings.map((r) => r.uid).sort()).toEqual(before.readings.map((r) => r.uid).sort());
    expect(after.tombstones).toEqual([]);
    // Another phone keeps using the shared borehole; its new reading reaches A's (hidden) shared copy only.
    await on(B, async () => { await syncOnce(s); await db.addReading(rd('MW-1', 12, 'B', 30)); await syncOnce(s); });
    await on(A, async () => {
      await syncOnce(s);
      const rs = await db.allReadings();
      expect(rs.filter((r) => r.borehole === 'MW-1').length).toBe(3);
      expect(rs.filter((r) => r.borehole === 'MW-1 (local)').length).toBe(2);
      expect(await names()).toEqual(['MW-1 (local):local', 'MW-1:shared:hidden']); // a pulled edit keeps it hidden
      await db.setHidden('MW-1', false);
      expect(await names()).toEqual(['MW-1 (local):local', 'MW-1:shared']);
      expect(await db.outboxCount()).toBe(0); // hiding is never synced
    });
  });
});

describe('pull dedupe', () => {
  it('a shared borehole arriving with the same name as a Local one never merges into it: the Local one is renamed', async () => {
    const s = sheet();
    await on(phone(), async () => { await db.saveBorehole(bh('MW-1', undefined, 200)); await db.addReading(rd('MW-1', 1, 'B')); await syncOnce(s); });
    await on(phone(), async () => {
      await db.saveBorehole(bh('mw-1', 'local'));
      await db.addReading(rd('mw-1', 7, 'A'));
      await prepareEnable(s); // natural-key matching must not adopt the sheet's uid for a Local borehole
      expect(await db.outboxCount()).toBe(0);
      await syncOnce(s);
      expect(await names()).toEqual(['MW-1:shared', 'mw-1 (local):local']);
      const loc = (await db.getBorehole('mw-1 (local)'))!;
      expect(loc.flag).toMatch(/Renamed from mw-1/);
      const rs = await db.allReadings();
      expect(rs.find((r) => r.userCode === 'A')!.borehole).toBe('mw-1 (local)');
      expect(rs.find((r) => r.userCode === 'B')!.borehole).toBe('MW-1');
      expect(await db.outboxCount()).toBe(0);
    });
    const all = await s.all();
    expect(all.boreholes.length).toBe(1);
    expect(all.readings.map((r) => r.userCode)).toEqual(['B']);
  });
});
