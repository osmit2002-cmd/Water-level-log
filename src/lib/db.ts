import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import type { Borehole, BoreholeField, Reading } from './types';
import { BOREHOLE_FIELDS } from './types';
import type { BoreholePatch } from './csv';
import { migrateV1, type V1Borehole, type V1Reading } from './migrate';
import { displayId, uuid } from './ids';
import type { BoreholeRec, ItemNote, PullResult, ReadingRec, TombRec } from '../sync/types';

/** One queued change. Keyed "b:uid" / "r:uid" / "t:uid" so repeated edits of one record coalesce. */
export interface OutboxItem {
  key: string;
  kind: 'borehole' | 'reading' | 'tombstone';
  rec: BoreholeRec | ReadingRec | TombRec;
  /** Changes on every enqueue; an ack only removes the item if it was not changed again meanwhile. */
  ver: string;
  /** Why the sheet refused it (0.4.1). Failed items are kept but not resent until the user taps Retry. */
  failed?: string;
  failedAt?: string;
}
/** A failed change the user chose to discard: kept here (and in backups) so it can still be recovered by hand. */
export interface DiscardedItem { item: OutboxItem; discardedAt: string }
export const DISCARDED = 'discardedChanges';

interface WLSchema extends DBSchema {
  boreholes: { key: string; value: Borehole; indexes: { byUid: string } };
  readings: { key: number; value: Reading; indexes: { byBorehole: string; byUid: string } };
  meta: { key: string; value: { key: string; value: unknown } };
  outbox: { key: string; value: OutboxItem };
  tombstones: { key: string; value: TombRec };
}
export const DB_NAME = 'water-level-log';
export const DB_VERSION = 3;
const NEXT_ID = 'nextReadingId'; // internal local key counter
const NEXT_SEQ = 'nextSeq'; // this phone's running number for display IDs
export const CURSOR = 'syncCursor';
type Names = StoreNames<WLSchema>;
type Tx = IDBPTransaction<WLSchema, Names[], 'readwrite'>;

let dbp: Promise<IDBPDatabase<WLSchema>> | undefined;
export function db() {
  // On failure or when iOS terminates the connection (app backgrounded), the next call reopens it.
  dbp ??= openDB<WLSchema>(DB_NAME, DB_VERSION, {
    async upgrade(d, oldVersion, _new, tx) {
     try {
      let old: { b: V1Borehole[]; r: V1Reading[] } | undefined;
      let m: ReturnType<typeof migrateV1> | undefined;
      if (oldVersion === 1) {
        // v1 stores: boreholes keyed by id, readings keyed by uid. Read and convert them BEFORE deleting anything;
        // any error aborts the upgrade, leaving the v1 database untouched.
        const t = tx as unknown as { objectStore(n: string): { getAll(): Promise<unknown[]> } };
        old = { b: (await t.objectStore('boreholes').getAll()) as V1Borehole[], r: (await t.objectStore('readings').getAll()) as V1Reading[] };
        m = migrateV1(old.b, old.r);
        d.deleteObjectStore('boreholes');
        d.deleteObjectStore('readings');
      }
      if (oldVersion < 2) {
        d.createObjectStore('boreholes', { keyPath: 'name' });
        d.createObjectStore('readings', { keyPath: 'id' }).createIndex('byBorehole', 'borehole');
        if (d.objectStoreNames.contains('meta')) d.deleteObjectStore('meta');
        const meta = d.createObjectStore('meta', { keyPath: 'key' });
        let next = 1;
        if (old && m) {
          for (const b of m.boreholes) await tx.objectStore('boreholes').put(b);
          for (const r of m.readings) await tx.objectStore('readings').put(r);
          next = m.nextReadingId;
          // Keep the untouched v1 data (incl. Dry/No-reading entries that v2 cannot represent) so nothing is destroyed.
          await meta.put({ key: 'v1Archive', value: { migratedAt: new Date().toISOString(), boreholes: old.b, readings: old.r, skipped: m.skipped.length } });
        }
        await meta.put({ key: NEXT_ID, value: next });
      }
      if (oldVersion < 3) {
        // 0.4.0: sync. Give every record a uid; existing readings keep their number as the display running number.
        tx.objectStore('boreholes').createIndex('byUid', 'uid');
        tx.objectStore('readings').createIndex('byUid', 'uid');
        d.createObjectStore('outbox', { keyPath: 'key' });
        d.createObjectStore('tombstones', { keyPath: 'uid' });
        const bs = tx.objectStore('boreholes'), rs = tx.objectStore('readings'), meta = tx.objectStore('meta');
        const uidOf = new Map<string, string>();
        for (const b of await bs.getAll()) { const f = fillBorehole(b); uidOf.set(f.name, f.uid!); await bs.put(f); }
        for (const r of await rs.getAll()) await rs.put({ ...r, userCode: r.userCode ?? '', uid: r.uid ?? uuid(), seq: r.seq ?? r.id, boreholeUid: uidOf.get(r.borehole) });
        const next = ((await meta.get(NEXT_ID))?.value as number | undefined) ?? 1;
        await meta.put({ key: NEXT_SEQ, value: next });
      }
     } catch (e) { try { tx.abort(); } catch { /* already aborted */ } throw e; }
    },
    blocking() { void dbp?.then((d) => d.close()); dbp = undefined; },
    terminated() { dbp = undefined; }
  }).catch((e) => { dbp = undefined; throw e; });
  return dbp;
}
/** Tests only: forget the cached connection. */
export async function closeDb() { const d = await dbp?.catch(() => undefined); d?.close(); dbp = undefined; }

/** Ensure sync fields; missing field times fall back to updatedAt. */
export function fillBorehole(b: Borehole): Borehole {
  const ft: Partial<Record<BoreholeField, string>> = { ...b.fieldTimes };
  for (const f of BOREHOLE_FIELDS) ft[f] ??= b.updatedAt;
  return { ...b, uid: b.uid ?? uuid(), fieldTimes: ft, flag: b.flag ?? '' };
}

// ---- wire conversion ----
export function toBRec(b: Borehole): BoreholeRec {
  const f = fillBorehole(b), t = f.fieldTimes!;
  return { uid: f.uid!, name: f.name, referencePoint: f.referencePoint, refElevationFt: f.refElevationFt, flag: f.flag ?? '',
    nameAt: t.name!, referencePointAt: t.referencePoint!, refElevationAt: t.refElevationFt!, flagAt: t.flag!, createdAt: f.createdAt, updatedAt: f.updatedAt };
}
export function fromBRec(r: BoreholeRec): Borehole {
  return { uid: r.uid, name: r.name, referencePoint: r.referencePoint, refElevationFt: r.refElevationFt, flag: r.flag ?? '', createdAt: r.createdAt, updatedAt: r.updatedAt,
    fieldTimes: { name: r.nameAt, referencePoint: r.referencePointAt, refElevationFt: r.refElevationAt, flag: r.flagAt } };
}
export function toRRec(r: Reading): ReadingRec {
  return { uid: r.uid!, displayId: displayId(r), boreholeUid: r.boreholeUid!, boreholeName: r.borehole, datetime: r.datetime, userCode: r.userCode ?? '',
    seq: r.seq ?? r.id, referencePoint: r.referencePoint, refElevationFt: r.refElevationFt, depthFt: r.depthFt, notes: r.notes ?? '', createdAt: r.createdAt, updatedAt: r.updatedAt };
}

// ---- outbox / tombstones (inside a caller's transaction) ----
const ver = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
async function queue(tx: Tx, kind: OutboxItem['kind'], rec: OutboxItem['rec']) {
  const key = `${kind[0]}:${rec.uid}`;
  await tx.objectStore('outbox').put({ key, kind, rec, ver: ver() });
  queued();
}
/** Tells the sync loop (if running) that something new is waiting. */
export const QUEUED_EVENT = 'wll-queued';
let queuedPending = false;
function queued() {
  if (queuedPending || typeof window === 'undefined') return;
  queuedPending = true;
  setTimeout(() => { queuedPending = false; window.dispatchEvent(new Event(QUEUED_EVENT)); }, 0);
}
async function tombstone(tx: Tx, t: TombRec, push = true) {
  await tx.objectStore('tombstones').put(t);
  await tx.objectStore('outbox').delete(`${t.kind[0]}:${t.uid}`);
  if (push) await queue(tx, 'tombstone', t);
}
async function bhUid(tx: Tx, name: string) {
  const b = await tx.objectStore('boreholes').get(name);
  if (!b) throw new Error(`Borehole ${name} no longer exists`);
  if (!b.uid) { const f = fillBorehole(b); await tx.objectStore('boreholes').put(f); await queue(tx, 'borehole', toBRec(f)); return f.uid!; }
  return b.uid;
}
const rw = async (stores: Names[]) => (await db()).transaction(stores, 'readwrite') as Tx;
const ALL: Names[] = ['boreholes', 'readings', 'meta', 'outbox', 'tombstones'];

export const allBoreholes = async () => (await db()).getAll('boreholes');
// Readings saved before 0.3.0 have no userCode: treat as blank.
export const allReadings = async () => (await db()).getAll('readings').then((rs) => rs.map((r) => ({ ...r, userCode: r.userCode ?? '' })));
export async function getNextReadingId(): Promise<number> {
  return ((await (await db()).get('meta', NEXT_SEQ))?.value as number | undefined) ?? ((await (await db()).get('meta', NEXT_ID))?.value as number | undefined) ?? 1;
}
export const outboxAll = async () => (await db()).getAll('outbox');
export const outboxCount = async () => (await db()).count('outbox');
export async function outboxStats() {
  const all = await outboxAll();
  const failed = all.filter((x) => x.failed);
  return { waiting: all.length - failed.length, failed };
}
export const getReading = async (id: number) => (await db()).get('readings', id);
export const getBorehole = async (name: string) => (await db()).get('boreholes', name);
export const getBoreholeByUid = async (uid: string) => (await db()).getFromIndex('boreholes', 'byUid', uid);
export const getDiscarded = async () => (((await (await db()).get('meta', DISCARDED))?.value as DiscardedItem[] | undefined) ?? []);
export const allTombstones = async () => (await db()).getAll('tombstones');

/** Insert a new reading: next local key, next running number for the display ID, a uid, and an outbox entry. Returns the local key. */
export async function addReading(r: Omit<Reading, 'id'>): Promise<number> {
  const tx = await rw(ALL);
  try {
    const boreholeUid = await bhUid(tx, r.borehole);
    const meta = tx.objectStore('meta');
    const rs = tx.objectStore('readings');
    let id = ((await meta.get(NEXT_ID))?.value as number | undefined) ?? 1;
    while (await rs.getKey(id)) id++; // defensive: never overwrite
    let seq = r.seq;
    if (seq === undefined) {
      // Never reuse a number this User Code already has (e.g. after a reinstall, readings come back from the sheet).
      seq = ((await meta.get(NEXT_SEQ))?.value as number | undefined) ?? id;
      const code = r.userCode ?? '';
      for (const o of await rs.getAll()) if ((o.userCode ?? '') === code && (o.seq ?? o.id) >= seq) seq = (o.seq ?? o.id) + 1;
    }
    const full: Reading = { ...r, id, uid: r.uid ?? uuid(), boreholeUid, seq };
    await rs.add(full);
    await meta.put({ key: NEXT_ID, value: id + 1 });
    if (r.seq === undefined) await meta.put({ key: NEXT_SEQ, value: seq + 1 });
    await queue(tx, 'reading', toRRec(full));
    await tx.done;
    return id;
  } catch (e) { try { tx.abort(); } catch { /* done */ } throw e; }
}
/** Update an existing reading (same ID). */
export async function updateReading(r: Reading) {
  const tx = await rw(ALL);
  try {
    const boreholeUid = await bhUid(tx, r.borehole);
    const full = { ...r, uid: r.uid ?? uuid(), boreholeUid };
    // Saving over a reading that was deleted meanwhile (the user confirmed it) brings it back: drop the local delete.
    // The edit is newer than the delete, so the sheet restores it too (and flags its borehole).
    if (await tx.objectStore('tombstones').getKey(full.uid)) { await tx.objectStore('tombstones').delete(full.uid); await tx.objectStore('outbox').delete(`t:${full.uid}`); }
    await tx.objectStore('readings').put(full);
    await queue(tx, 'reading', toRRec(full));
    await tx.done;
  } catch (e) { try { tx.abort(); } catch { /* done */ } throw e; }
}
export async function deleteReading(id: number) {
  const tx = await rw(ALL);
  const r = await tx.objectStore('readings').get(id);
  if (r) {
    await tx.objectStore('readings').delete(id);
    if (r.uid) await tombstone(tx, { uid: r.uid, kind: 'reading', deletedAt: new Date().toISOString() });
  }
  await tx.done;
}

export const findName = (names: Iterable<string>, name: string) => {
  const k = name.trim().toLowerCase();
  for (const n of names) if (n.toLowerCase() === k) return n;
  return undefined;
};

/** New field times: every field whose value changed gets `now`. */
function stampFields(old: Borehole | undefined, b: Borehole, now: string): Borehole {
  const o = old ? fillBorehole(old) : undefined;
  // A form that does not carry the flag keeps the existing one (and its time).
  const nb: Borehole = { ...b, uid: o?.uid ?? b.uid ?? uuid(), flag: b.flag ?? o?.flag ?? '' };
  const ft: Partial<Record<BoreholeField, string>> = { ...o?.fieldTimes };
  for (const f of BOREHOLE_FIELDS) if (!o || (o[f] ?? '') !== (nb[f] ?? '')) ft[f] = now;
  return { ...nb, fieldTimes: ft };
}

/** Put a borehole, renaming (moving readings) if its name changed. Inside a transaction. */
async function putBorehole(tx: Tx, b: Borehole, oldName?: string) {
  const bs = tx.objectStore('boreholes');
  if (oldName && oldName !== b.name) {
    const rs = tx.objectStore('readings');
    for (const r of await rs.index('byBorehole').getAll(oldName)) await rs.put({ ...r, borehole: b.name, boreholeUid: b.uid });
    await bs.delete(oldName);
  }
  await bs.put(b);
}

/**
 * Create or update a borehole. `oldName` = current name when editing; a different `b.name` renames it
 * and moves its readings to the new name in the same transaction. Names are unique (case-insensitive).
 */
export async function saveBorehole(b: Borehole, oldName?: string) {
  const tx = await rw(ALL);
  const bs = tx.objectStore('boreholes');
  const clash = findName(await bs.getAllKeys(), b.name);
  if (clash && clash !== oldName) { tx.abort(); throw new Error(`A borehole named ${clash} already exists`); }
  const old = oldName ? await bs.get(oldName) : undefined;
  const nb = stampFields(old, b, b.updatedAt);
  // Re-saving a borehole that was deleted meanwhile (user confirmed it in the conflict panel): drop the local delete.
  if (await tx.objectStore('tombstones').getKey(nb.uid!)) { await tx.objectStore('tombstones').delete(nb.uid!); await tx.objectStore('outbox').delete(`t:${nb.uid}`); }
  await putBorehole(tx, nb, oldName);
  await queue(tx, 'borehole', toBRec(nb));
  await tx.done;
}

export async function deleteBorehole(name: string) {
  const tx = await rw(ALL);
  const rs = tx.objectStore('readings');
  const now = new Date().toISOString();
  for (const r of await rs.index('byBorehole').getAll(name)) {
    await rs.delete(r.id);
    if (r.uid) await tombstone(tx, { uid: r.uid, kind: 'reading', deletedAt: now }); // sent too, in case the sheet already merged this borehole
  }
  const b = await tx.objectStore('boreholes').get(name);
  await tx.objectStore('boreholes').delete(name);
  if (b?.uid) await tombstone(tx, { uid: b.uid, kind: 'borehole', deletedAt: now });
  await tx.done;
}

/** Upsert by name (case-insensitive match keeps the existing spelling). Absent columns keep existing values. */
export async function upsertBoreholes(list: BoreholePatch[]) {
  const tx = await rw(ALL);
  const store = tx.objectStore('boreholes');
  const now = new Date().toISOString();
  const names = await store.getAllKeys();
  let added = 0, updated = 0;
  for (const p of list) {
    const existing = findName(names, p.name);
    const old = existing ? await store.get(existing) : undefined;
    if (old) updated++; else { added++; names.push(p.name); }
    const b = stampFields(old, {
      ...old,
      name: old?.name ?? p.name, referencePoint: p.referencePoint ?? old?.referencePoint ?? 'top of casing', // Keep the stored value when the CSV only differs by export rounding (2 dp in ft or m), so a round trip changes nothing.
      refElevationFt: old && Math.abs(old.refElevationFt - p.refElevationFt) < 0.017 ? old.refElevationFt : p.refElevationFt,
      createdAt: old?.createdAt ?? now, updatedAt: now
    }, now);
    if (old && JSON.stringify(toBRec(fillBorehole(old))) === JSON.stringify(toBRec({ ...b, updatedAt: old.updatedAt }))) continue;
    await store.put(b);
    await queue(tx, 'borehole', toBRec(b));
  }
  await tx.done;
  return { added, updated };
}

/**
 * Replace all data (restore). The local counters only move forward. Every restored record is queued for sync
 * (records deleted on this phone earlier stay deleted). The sync cursor is reset so the next sync pulls everything.
 */
export async function replaceAll(boreholes: Borehole[], readings: Reading[], nextReadingId: number) {
  const tx = await rw(ALL);
  const meta = tx.objectStore('meta');
  const cur = ((await meta.get(NEXT_ID))?.value as number | undefined) ?? 1;
  const curSeq = ((await meta.get(NEXT_SEQ))?.value as number | undefined) ?? 1;
  const dead = new Set((await tx.objectStore('tombstones').getAllKeys()) as string[]);
  await tx.objectStore('boreholes').clear();
  await tx.objectStore('readings').clear();
  // Keep queued deletes so other phones still learn about them; drop queued borehole/reading upserts (re-queued below).
  for (const k of (await tx.objectStore('outbox').getAllKeys()) as string[]) if (!k.startsWith('t:')) await tx.objectStore('outbox').delete(k);
  const uidOf = new Map<string, string>();
  for (const b0 of boreholes) {
    const b = fillBorehole(b0);
    if (dead.has(b.uid!)) continue;
    uidOf.set(b.name, b.uid!);
    await tx.objectStore('boreholes').put(b);
    await queue(tx, 'borehole', toBRec(b));
  }
  let maxSeq = 0;
  for (const r0 of readings) {
    const r = { ...r0, uid: r0.uid ?? uuid(), seq: r0.seq ?? r0.id, boreholeUid: uidOf.get(r0.borehole) };
    if (dead.has(r.uid) || !r.boreholeUid) continue;
    maxSeq = Math.max(maxSeq, r.seq);
    await tx.objectStore('readings').put(r);
    await queue(tx, 'reading', toRRec(r));
  }
  const maxId = readings.reduce((m, r) => Math.max(m, r.id), 0);
  await meta.put({ key: NEXT_ID, value: Math.max(cur, nextReadingId, maxId + 1) });
  await meta.put({ key: NEXT_SEQ, value: Math.max(curSeq, nextReadingId, maxSeq + 1) });
  await meta.put({ key: CURSOR, value: 0 });
  await tx.done;
}

/** Queue every local record (used when sync is turned on, so data saved before joining is uploaded). */
export async function queueEverything() {
  const tx = await rw(ALL);
  for (const b of await tx.objectStore('boreholes').getAll()) {
    const f = fillBorehole(b);
    if (!b.uid || !b.fieldTimes) await tx.objectStore('boreholes').put(f);
    if (!(await tx.objectStore('outbox').getKey(`b:${f.uid}`))) await queue(tx, 'borehole', toBRec(f));
  }
  for (const r of await tx.objectStore('readings').getAll()) {
    if (!r.uid || !r.boreholeUid) continue;
    if (!(await tx.objectStore('outbox').getKey(`r:${r.uid}`))) await queue(tx, 'reading', toRRec(r));
  }
  for (const t of await tx.objectStore('tombstones').getAll()) if (!t.mergedInto && !(await tx.objectStore('outbox').getKey(`t:${t.uid}`))) await queue(tx, 'tombstone', t);
  await tx.done;
}

/** Remove acknowledged items, unless they were changed again after being sent. */
export async function outboxAck(sent: OutboxItem[], acked: string[]) {
  const ok = new Set(acked);
  const tx = await rw(['outbox']);
  for (const s of sent) {
    if (!ok.has(s.key)) continue;
    const cur = await tx.objectStore('outbox').get(s.key);
    if (cur && cur.ver === s.ver) await tx.objectStore('outbox').delete(s.key);
  }
  await tx.done;
}
/** Mark items the server refused (only if unchanged since they were sent; a newer edit gets a fresh try). */
export async function outboxFail(sent: OutboxItem[], rejected: ItemNote[]) {
  const why = new Map(rejected.map((x) => [x.key, x.reason]));
  const tx = await rw(['outbox']);
  const at = new Date().toISOString();
  for (const s of sent) {
    const reason = why.get(s.key);
    if (!reason) continue;
    const cur = await tx.objectStore('outbox').get(s.key);
    if (cur && cur.ver === s.ver) await tx.objectStore('outbox').put({ ...cur, failed: reason, failedAt: at });
  }
  await tx.done;
}
/** Retry one failed item (or all of them): clear the failure so the next sync sends it again. */
export async function retryFailed(key?: string) {
  const tx = await rw(['outbox']);
  for (const it of await tx.objectStore('outbox').getAll()) {
    if (!it.failed || (key && it.key !== key)) continue;
    const { failed: _f, failedAt: _a, ...rest } = it;
    await tx.objectStore('outbox').put({ ...rest, ver: ver() });
  }
  await tx.done;
  queued();
}
/** Stop trying to sync one failed change. The record on this phone is untouched; the change is kept in meta and in backups. */
export async function discardFailed(key: string) {
  const tx = await rw(['outbox', 'meta']);
  const it = await tx.objectStore('outbox').get(key);
  if (it?.failed) {
    const list = ((await tx.objectStore('meta').get(DISCARDED))?.value as DiscardedItem[] | undefined) ?? [];
    await tx.objectStore('meta').put({ key: DISCARDED, value: [...list, { item: it, discardedAt: new Date().toISOString() }] });
    await tx.objectStore('outbox').delete(key);
  }
  await tx.done;
}

/**
 * Turning sync on (0.4.1, fix #8): records restored from an old (v1-v3) backup get NEW uids, so uploading them would
 * duplicate what the sheet already has. Before queueing anything, give local records the sheet's uid when they match
 * by natural key: borehole name (case-insensitive); reading = borehole name + date/time + depth (+-1e-6 ft) + User Code.
 * Returns how many records were matched.
 */
export async function adoptRemoteIds(p: PullResult): Promise<{ boreholes: number; readings: number }> {
  const tx = await rw(ALL);
  let nb = 0, nr = 0;
  try {
    const bs = tx.objectStore('boreholes'), rs = tx.objectStore('readings'), ob = tx.objectStore('outbox');
    const remoteB = new Set(p.boreholes.map((b) => b.uid));
    const remoteR = new Set(p.readings.map((r) => r.uid));
    const nameOf = new Map(p.boreholes.map((b) => [b.uid, b.name]));
    for (const rb of p.boreholes) {
      const k = findName(await bs.getAllKeys(), rb.name);
      const lb = k ? await bs.get(k) : undefined;
      if (!lb || lb.uid === rb.uid || (lb.uid && remoteB.has(lb.uid))) continue;
      if (lb.uid) await ob.delete(`b:${lb.uid}`);
      await bs.put({ ...fillBorehole(lb), uid: rb.uid });
      for (const r of await rs.index('byBorehole').getAll(lb.name)) { await rs.put({ ...r, boreholeUid: rb.uid }); await ob.delete(`r:${r.uid}`); } // re-queued with the new link
      nb++;
    }
    const all = await rs.getAll();
    const used = new Set<number>();
    for (const rr of p.readings) {
      if (all.some((r) => r.uid === rr.uid)) continue;
      const bname = (nameOf.get(rr.boreholeUid) ?? rr.boreholeName ?? '').toLowerCase();
      const m = all.find((r) => !used.has(r.id) && !(r.uid && remoteR.has(r.uid)) && r.borehole.toLowerCase() === bname &&
        r.datetime === rr.datetime && Math.abs(r.depthFt - rr.depthFt) < 1e-6 && (r.userCode ?? '') === (rr.userCode ?? ''));
      if (!m) continue;
      if (m.uid) await ob.delete(`r:${m.uid}`);
      const next = { ...m, uid: rr.uid, seq: rr.seq };
      used.add(m.id);
      await rs.put(next);
      nr++;
    }
    await tx.done;
  } catch (e) { try { tx.abort(); } catch { /* done */ } throw e; }
  return { boreholes: nb, readings: nr };
}

export async function resetCursor() { await (await db()).put('meta', { key: CURSOR, value: 0 }); }
export async function getCursor() { return ((await (await db()).get('meta', CURSOR))?.value as number | undefined) ?? 0; }

export { rw as _rw, putBorehole as _putBorehole, tombstone as _tombstone, queue as _queue };
export type { Tx };

/** Ask the browser to keep our storage (iOS may still evict; JSON backups are the safety net). */
export async function requestPersist(): Promise<boolean | undefined> {
  try {
    if (!navigator.storage?.persist) return undefined;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return undefined; }
}
