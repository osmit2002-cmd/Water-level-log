import type { AdapterStatus, BoreholeRec, PullResult, PushBatch, PushResult, ReadingRec, SyncAdapter, TombRec } from './types';
import { mergeBorehole, mergeReading } from './merge';

/**
 * In-memory backend for tests and demos: same contract as the Sheet (idempotent upserts, tombstones win,
 * per-field merge, pull since a revision cursor). `failNext` simulates lost signal / server errors.
 * (Same-name merging is only implemented in the real Apps Script; see Code.gs.)
 */
export class MockAdapter implements SyncAdapter {
  readonly kind = 'mock';
  rev = 0;
  b = new Map<string, BoreholeRec & { rev: number }>();
  r = new Map<string, ReadingRec & { rev: number }>();
  t = new Map<string, TombRec & { rev: number }>();
  failNext = 0;
  dropAcks = false;
  calls: string[] = [];
  private gate(op: string) { this.calls.push(op); if (this.failNext > 0) { this.failNext--; throw new Error('Could not reach the sync server (no signal?)'); } }
  async push(x: PushBatch): Promise<PushResult> {
    this.gate('push');
    const acked: string[] = [];
    for (const t of x.tombstones) {
      if (!this.t.has(t.uid)) this.t.set(t.uid, { ...t, rev: ++this.rev });
      this.b.delete(t.uid); this.r.delete(t.uid);
      if (t.kind === 'borehole') for (const [k, r] of this.r) if (r.boreholeUid === t.uid) { this.r.delete(k); this.t.set(k, { uid: k, kind: 'reading', deletedAt: t.deletedAt, rev: ++this.rev }); }
      acked.push(`t:${t.uid}`);
    }
    for (const b of x.boreholes) {
      if (!this.t.has(b.uid)) {
        const cur = this.b.get(b.uid);
        const m = cur ? mergeBorehole(cur, b) : b;
        if (!cur || JSON.stringify({ ...m, rev: 0 }) !== JSON.stringify({ ...cur, rev: 0 })) this.b.set(b.uid, { ...m, rev: ++this.rev });
      }
      acked.push(`b:${b.uid}`);
    }
    for (const r of x.readings) {
      if (this.t.has(r.uid)) { acked.push(`r:${r.uid}`); continue; }
      if (!this.b.has(r.boreholeUid)) { if (this.t.has(r.boreholeUid)) acked.push(`r:${r.uid}`); continue; }
      const cur = this.r.get(r.uid);
      const m = cur ? mergeReading(cur, r) : r;
      if (!cur || m.updatedAt !== cur.updatedAt) this.r.set(r.uid, { ...m, rev: ++this.rev });
      acked.push(`r:${r.uid}`);
    }
    return { acked: this.dropAcks ? [] : acked };
  }
  async pull(since: number): Promise<PullResult> {
    this.gate('pull');
    const strip = <T extends { rev: number }>(m: Map<string, T>) => [...m.values()].filter((v) => v.rev > since).map(({ rev: _r, ...v }) => v);
    return { cursor: this.rev, boreholes: strip(this.b) as BoreholeRec[], readings: strip(this.r) as ReadingRec[], tombstones: strip(this.t) as TombRec[] };
  }
  async status(): Promise<AdapterStatus> { return { ok: true, message: 'Mock connected' }; }
}
