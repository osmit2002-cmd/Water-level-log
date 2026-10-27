import type { AdapterStatus, BoreholeRec, ItemNote, PullResult, PushBatch, PushResult, ReadingRec, SyncAdapter, TombRec } from './types';
import { mergeBorehole, mergeReading } from './merge';

const later = (iso: string) => { const n = new Date().toISOString(); return n > iso ? n : new Date(Date.parse(iso) + 1).toISOString(); };

/**
 * In-memory backend for tests and demos, with the same rules as Code.gs (0.4.1): idempotent upserts, per-field merge,
 * pull since a revision cursor, deletes never cascade to readings the deleter had not seen, a delete loses to a newer
 * edit (record restored and flagged), invalid items are rejected with a reason, readings of a deleted/missing borehole are held.
 * `failNext` simulates lost signal; `reject` lets a test refuse items. Same-name merging is only implemented in Code.gs.
 */
export class MockAdapter implements SyncAdapter {
  readonly kind = 'mock';
  rev = 0;
  /** 0.6.0: the sheet's Reading ID sequence (never reused). */
  numMax = 0;
  b = new Map<string, BoreholeRec & { rev: number }>();
  r = new Map<string, ReadingRec & { rev: number }>();
  t = new Map<string, TombRec & { rev: number }>();
  failNext = 0;
  dropAcks = false;
  reject: (key: string) => string | undefined = () => undefined;
  calls: string[] = [];
  private gate(op: string) { this.calls.push(op); if (this.failNext > 0) { this.failNext--; throw new Error('Could not reach the sync server (no signal?)'); } }
  private dead(uid: string) { const t = this.t.get(uid); return !!t && !t.restoredAt; }
  private restore(uid: string) { const t = this.t.get(uid)!; this.t.set(uid, { ...t, restoredAt: new Date().toISOString(), rev: ++this.rev }); }
  private flag(uid: string, why: string, at: string) {
    const b = this.b.get(uid); if (!b) return;
    this.b.set(uid, { ...b, flag: why, flagAt: at, updatedAt: at > b.updatedAt ? at : b.updatedAt, rev: ++this.rev });
  }
  async push(x: PushBatch): Promise<PushResult> {
    this.gate('push');
    const acked: string[] = [], rejected: ItemNote[] = [], held: ItemNote[] = [];
    const ok = (key: string) => { const why = this.reject(key); if (why) rejected.push({ key, reason: why }); return !why; };
    const tombs = [...x.tombstones].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'reading' ? -1 : 1));
    for (const t of tombs) {
      if (!ok(`t:${t.uid}`)) continue;
      if (t.kind === 'reading') {
        const cur = this.r.get(t.uid);
        if (cur && cur.updatedAt > t.deletedAt) this.flag(cur.boreholeUid, `Reading ${cur.displayId} was deleted on a phone but edited later, so it was kept`, later(t.deletedAt));
        else if (!this.dead(t.uid)) { this.r.delete(t.uid); this.t.set(t.uid, { ...t, rev: ++this.rev }); }
      } else {
        const cur = this.b.get(t.uid);
        const left = [...this.r.values()].filter((r) => r.boreholeUid === t.uid);
        if (cur && (cur.updatedAt > t.deletedAt || left.length)) {
          this.flag(t.uid, left.length ? `Deleted on a phone, but ${left.length} reading(s) that phone had not seen were kept` : 'Deleted on a phone but edited later, so it was kept', later(t.deletedAt));
          for (const r of left) this.r.set(r.uid, { ...r, rev: ++this.rev });
        } else if (!this.dead(t.uid)) { this.b.delete(t.uid); this.t.set(t.uid, { ...t, rev: ++this.rev }); }
      }
      acked.push(`t:${t.uid}`);
    }
    for (const b of x.boreholes) {
      const key = `b:${b.uid}`;
      if (!b.name.trim()) { rejected.push({ key, reason: 'Borehole Name is empty' }); continue; }
      if (!ok(key)) continue;
      if (this.dead(b.uid)) {
        if (b.updatedAt > this.t.get(b.uid)!.deletedAt) this.restore(b.uid); else { acked.push(key); continue; }
      }
      const cur = this.b.get(b.uid);
      const m = cur ? mergeBorehole(cur, b) : b;
      if (!cur || JSON.stringify({ ...m, rev: 0 }) !== JSON.stringify({ ...cur, rev: 0 })) this.b.set(b.uid, { ...m, rev: ++this.rev });
      acked.push(key);
    }
    for (const r of x.readings) {
      const key = `r:${r.uid}`;
      if (!(r.depthFt >= 0)) { rejected.push({ key, reason: 'Depth is negative' }); continue; }
      if (!ok(key)) continue;
      if (this.dead(r.uid)) {
        if (r.updatedAt > this.t.get(r.uid)!.deletedAt) { this.restore(r.uid); this.flag(r.boreholeUid, `Reading ${r.displayId} was deleted on a phone but edited later, so it was restored`, r.updatedAt); }
        else { acked.push(key); continue; }
      }
      if (this.dead(r.boreholeUid)) { held.push({ key, reason: 'Its borehole was deleted on another phone; this phone will restore it' }); continue; }
      if (!this.b.has(r.boreholeUid)) { held.push({ key, reason: 'Its borehole is not on the sheet yet' }); continue; }
      const cur = this.r.get(r.uid);
      // 0.6.0: the server numbers new readings (the phone's number is only provisional) and keeps the number after.
      const m = cur ? { ...mergeReading(cur, r), num: cur.num, datetime: cur.datetime, referencePoint: cur.referencePoint, refElevationFt: cur.refElevationFt, userCode: cur.userCode }
        : { ...r, num: ++this.numMax };
      if (m.num) m.displayId = String(m.num);
      if (!cur || m.updatedAt !== cur.updatedAt) this.r.set(r.uid, { ...m, rev: ++this.rev });
      acked.push(key);
    }
    return { acked: this.dropAcks ? [] : acked, rejected, held };
  }
  async pull(since: number): Promise<PullResult> {
    this.gate('pull');
    const strip = <T extends { rev: number }>(m: Map<string, T>) => [...m.values()].filter((v) => v.rev > since).map(({ rev: _r, ...v }) => v);
    return { cursor: this.rev, boreholes: strip(this.b) as BoreholeRec[], readings: strip(this.r) as ReadingRec[], tombstones: strip(this.t) as TombRec[], numMax: this.numMax };
  }
  async status(): Promise<AdapterStatus> { return { ok: true, message: 'Mock connected' }; }
}
