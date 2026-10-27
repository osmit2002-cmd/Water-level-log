import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from 'idb';
import type { Borehole, BoreholeField, Reading, Scope } from './types';
import { BOREHOLE_FIELDS, scopeOf } from './types';
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
  /** Set when this item failed only because another item (its borehole, "b:uid") was refused. */
  failedBy?: string;
}
/** A failed change the user chose to discard: kept here (and in backups) so it can still be recovered by hand. */
export interface DiscardedItem { item: OutboxItem; discardedAt: string }
export const DISCARDED = 'discardedChanges';

interface WLSchema extends DBSchema {
  boreholes: { key: string; value: Borehole; indexes: { byUid: string } };
  readings: { key: number; value: Reading; indexes: { byBorehole: string; byUid: string } };
  meta: { key: string; value: { key: string; value: unknown } };
  outbox: { key: string; value: OutboxItem };
  tombstones: { key: string; value: LocalTomb };
}
/** A tombstone as stored on this phone. `localOnly` (0.5.0): the deleted record was Local, so the delete is never sent. */
export type LocalTomb = TombRec & { localOnly?: boolean };
export const DB_NAME = 'water-level-log';
export const DB_VERSION = 4;
const NEXT_ID = 'nextReadingId'; // internal local key counter
const NEXT_SEQ = 'nextSeq'; // this phone's running number for display IDs
export const CURSOR = 'syncCursor';
/** 0.6.0: highest Reading ID (number) this phone has used or seen from the sheet. */
export const NUM_HWM = 'numHwm';
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
      if (oldVersion < 4) {
        // 0.6.0: number-only Reading IDs. Number every reading 1..N in date order (same order the sheet's one-time setup uses);
        // shared readings get the sheet's number on the next sync.
        const rs = tx.objectStore('readings'), meta = tx.objectStore('meta');
        const all = (await rs.getAll()).sort((a, b) => a.datetime.localeCompare(b.datetime) || a.createdAt.localeCompare(b.createdAt) || (a.uid ?? '').localeCompare(b.uid ?? ''));
        let n = 0;
        for (const r of all) await rs.put({ ...r, num: ++n });
        await meta.put({ key: NUM_HWM, value: n });
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
    seq: r.seq ?? r.id, ...(r.num ? { num: r.num } : {}), referencePoint: r.referencePoint, refElevationFt: r.refElevationFt, depthFt: r.depthFt, notes: r.notes ?? '', createdAt: r.createdAt, updatedAt: r.updatedAt };
}

// ---- 0.6.0 Reading ID numbers (inside a caller's transaction) ----
/**
 * Next number for a reading saved on this phone: one past the highest number seen here (own readings or from the sheet).
 * For a Shared reading this is provisional: the sheet assigns the final number when it arrives (it differs only if
 * another phone saved a reading in between). Local readings keep it.
 */
export async function takeNum(tx: Tx): Promise<number> {
  const meta = tx.objectStore('meta');
  let hwm = ((await meta.get(NUM_HWM))?.value as number | undefined) ?? 0;
  for (const o of await tx.objectStore('readings').getAll()) if ((o.num ?? 0) > hwm) hwm = o.num!;
  await meta.put({ key: NUM_HWM, value: hwm + 1 });
  return hwm + 1;
}
export async function seeNum(tx: Tx, n: number | undefined) {
  if (!n) return;
  const meta = tx.objectStore('meta');
  if (n > (((await meta.get(NUM_HWM))?.value as number | undefined) ?? 0)) await meta.put({ key: NUM_HWM, value: n });
}

// ---- outbox / tombstones (inside a caller's transaction) ----
const ver = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
async function queue(tx: Tx, kind: OutboxItem['kind'], rec: OutboxItem['rec']) {
  // 0.5.0: Local boreholes and their readings never enter the outbox (checked here, so every caller is covered).
  if (await isLocalRec(tx, kind, rec)) return;
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
async function tombstone(tx: Tx, t: LocalTomb, push = true) {
  await tx.objectStore('tombstones').put(t);
  await tx.objectStore('outbox').delete(`${t.kind[0]}:${t.uid}`);
  if (push && !t.localOnly) await queue(tx, 'tombstone', t);
}
/** True when `uid` is a Local borehole on this phone. */
async function isLocalBh(tx: Tx, uid: string | undefined): Promise<boolean> {
  if (!uid) return false;
  return scopeOf(await tx.objectStore('boreholes').index('byUid').get(uid)) === 'local';
}
async function isLocalRec(tx: Tx, kind: OutboxItem['kind'], rec: OutboxItem['rec']): Promise<boolean> {
  if (kind === 'borehole') return isLocalBh(tx, rec.uid);
  if (kind === 'reading') return isLocalBh(tx, (rec as ReadingRec).boreholeUid);
  return !!(await tx.objectStore('tombstones').get(rec.uid))?.localOnly;
}
export const RESTORED_FOR_EDIT = 'Deleted on another phone, but a reading in it was edited on this phone afterwards, so it was brought back. Check the reference values.';
async function bhUid(tx: Tx, name: string, from?: Reading): Promise<{ uid: string; name: string }> {
  if (from?.boreholeUid) {
    // An existing reading: find its borehole by uid (following merges), so a rename or merge made meanwhile is kept.
    let u = from.boreholeUid;
    for (let i = 0; i < 20; i++) { const t = await tx.objectStore('tombstones').get(u); if (t?.mergedInto) u = t.mergedInto; else break; }
    const cur = await tx.objectStore('boreholes').index('byUid').get(u);
    if (cur?.uid) return { uid: cur.uid, name: cur.name };
    const tomb = await tx.objectStore('tombstones').get(u);
    if (tomb?.mergedInto || (!tomb && (await tx.objectStore('boreholes').get(name)))) from = undefined; // not a plain delete: no rebuild
    else from = { ...from, boreholeUid: u };
  }
  let b = await tx.objectStore('boreholes').get(name);
  if (!b && from) {
    // A reading saved from a form left open while its borehole was deleted: bring the borehole back (flagged) from the
    // reading's snapshot instead of failing. Same uid, edited now (after the delete), so the sheet restores it too.
    const now = new Date().toISOString();
    const uid = from.boreholeUid ?? uuid();
    const wasLocal = !!(await tx.objectStore('tombstones').get(uid))?.localOnly; // 0.5.0: a Local borehole comes back Local
    b = { name, uid, ...(wasLocal ? { scope: 'local' as Scope } : {}), referencePoint: from.referencePoint, refElevationFt: from.refElevationFt, createdAt: now, updatedAt: now, flag: RESTORED_FOR_EDIT,
      fieldTimes: { name: now, referencePoint: now, refElevationFt: now, flag: now } };
    await tx.objectStore('boreholes').put(b);
    if (await tx.objectStore('tombstones').getKey(uid)) { await tx.objectStore('tombstones').delete(uid); await tx.objectStore('outbox').delete(`t:${uid}`); }
    await queue(tx, 'borehole', toBRec(b));
    return { uid, name };
  }
  if (!b) throw new Error(`Borehole ${name} no longer exists`);
  if (!b.uid) { const f = fillBorehole(b); await tx.objectStore('boreholes').put(f); await queue(tx, 'borehole', toBRec(f)); return { uid: f.uid!, name: f.name }; }
  return { uid: b.uid, name: b.name };
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
    const { uid: boreholeUid } = await bhUid(tx, r.borehole);
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
    const full: Reading = { ...r, id, uid: r.uid ?? uuid(), boreholeUid, seq, num: r.num ?? (await takeNum(tx)) };
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
    const bh = await bhUid(tx, r.borehole, r.uid ? r : undefined);
    const full = { ...r, uid: r.uid ?? uuid(), boreholeUid: bh.uid, borehole: bh.name };
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
    const local = await isLocalBh(tx, r.boreholeUid);
    await tx.objectStore('readings').delete(id);
    if (r.uid) await tombstone(tx, { uid: r.uid, kind: 'reading', deletedAt: new Date().toISOString(), ...(local ? { localOnly: true } : {}) });
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
  // 0.5.0: scope and hidden are this phone's own settings; an edit never changes them (conversions have their own functions).
  if (o) { if (o.scope) nb.scope = o.scope; else delete nb.scope; if (o.hidden) nb.hidden = true; else delete nb.hidden; }
  else if (nb.scope !== 'local') delete nb.scope;
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
  const b = await tx.objectStore('boreholes').get(name);
  const lo = scopeOf(b) === 'local' ? { localOnly: true } : {};
  for (const r of await rs.index('byBorehole').getAll(name)) {
    await rs.delete(r.id);
    if (r.uid) await tombstone(tx, { uid: r.uid, kind: 'reading', deletedAt: now, ...lo }); // sent too, in case the sheet already merged this borehole
  }
  await tx.objectStore('boreholes').delete(name);
  if (b?.uid) await tombstone(tx, { uid: b.uid, kind: 'borehole', deletedAt: now, ...lo });
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
      createdAt: old?.createdAt ?? now, updatedAt: now,
      ...(!old && p.scope === 'local' ? { scope: 'local' as Scope } : {})
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
    if (!r.num) r.num = await takeNum(tx); else await seeNum(tx, r.num);
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
  for (const t of await tx.objectStore('tombstones').getAll()) if (!t.mergedInto && !t.localOnly && !(await tx.objectStore('outbox').getKey(`t:${t.uid}`))) await queue(tx, 'tombstone', t);
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
/** Readings whose borehole was refused can't go in either: mark them failed too, linked to the borehole's failure. */
export async function outboxLinkFailures() {
  const tx = await rw(['outbox']);
  const ob = tx.objectStore('outbox');
  const all = await ob.getAll();
  const badB = new Map(all.filter((x) => x.failed && x.kind === 'borehole').map((x) => [(x.rec as BoreholeRec).uid, x]));
  const at = new Date().toISOString();
  let n = 0;
  for (const it of all) {
    if (it.kind !== 'reading') continue;
    if (it.failed && it.failedBy && !badB.has((it.rec as ReadingRec).boreholeUid)) {
      // its borehole is no longer failing (fixed, edited or retried): send the reading again
      const { failed: _f, failedAt: _a, failedBy: _b, ...rest } = it; await ob.put({ ...rest, ver: ver() }); n++; continue;
    }
    if (it.failed) continue;
    const b = badB.get((it.rec as ReadingRec).boreholeUid);
    if (!b) continue;
    await ob.put({ ...it, failed: `Its borehole ${(b.rec as BoreholeRec).name} was refused (${b.failed}). Fix or retry the borehole.`, failedAt: at, failedBy: b.key });
    n++;
  }
  await tx.done;
  return n;
}
/** Retry one failed item (or all of them): clear the failure so the next sync sends it again. Retrying a borehole also retries readings that failed because of it. */
export async function retryFailed(key?: string) {
  const tx = await rw(['outbox']);
  for (const it of await tx.objectStore('outbox').getAll()) {
    if (!it.failed || (key && it.key !== key && it.failedBy !== key)) continue;
    const { failed: _f, failedAt: _a, failedBy: _b, ...rest } = it;
    await tx.objectStore('outbox').put({ ...rest, ver: ver() });
  }
  await tx.done;
  queued();
}
/** Stop trying to sync one failed change. The record on this phone is untouched; the change is kept in meta and in backups. */
/** Readings pulled from the sheet whose borehole has not arrived yet (parked, applied when it does). */
export async function orphanCount(): Promise<number> {
  const v = (await (await db()).get('meta', 'orphanReadings'))?.value as Record<string, unknown> | undefined;
  return v ? Object.keys(v).length : 0;
}
export async function discardFailed(key: string) {
  const tx = await rw(['outbox', 'meta']);
  const it = await tx.objectStore('outbox').get(key);
  if (it?.failed) {
    // Discarding a borehole also discards the readings that failed because of it (they could never go in without it).
    // Also any reading of that borehole still waiting to be sent: without the borehole it would wait forever.
    const buid = it.kind === 'borehole' ? (it.rec as { uid: string }).uid : undefined;
    const linked = (await tx.objectStore('outbox').getAll()).filter((x) => x.key !== key && (x.failedBy === key ||
      (buid !== undefined && x.kind === 'reading' && (x.rec as { boreholeUid?: string }).boreholeUid === buid)));
    const at = new Date().toISOString();
    const list = ((await tx.objectStore('meta').get(DISCARDED))?.value as DiscardedItem[] | undefined) ?? [];
    await tx.objectStore('meta').put({ key: DISCARDED, value: [...list, ...[it, ...linked].map((item) => ({ item, discardedAt: at }))] });
    for (const x of [it, ...linked]) await tx.objectStore('outbox').delete(x.key);
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
      if (!lb || lb.uid === rb.uid || (lb.uid && remoteB.has(lb.uid)) || scopeOf(lb) === 'local') continue; // 0.5.0: a Local borehole is never matched to the sheet
      if (lb.uid) await ob.delete(`b:${lb.uid}`);
      await bs.put({ ...fillBorehole(lb), uid: rb.uid });
      for (const r of await rs.index('byBorehole').getAll(lb.name)) { await rs.put({ ...r, boreholeUid: rb.uid }); await ob.delete(`r:${r.uid}`); } // re-queued with the new link
      nb++;
    }
    const localNames = new Set((await bs.getAll()).filter((b) => scopeOf(b) === 'local').map((b) => b.name));
    const all = (await rs.getAll()).filter((r) => !localNames.has(r.borehole));
    const used = new Set<number>();
    for (const rr of p.readings) {
      if (all.some((r) => r.uid === rr.uid)) continue;
      const bname = (nameOf.get(rr.boreholeUid) ?? rr.boreholeName ?? '').toLowerCase();
      const m = all.find((r) => !used.has(r.id) && !(r.uid && remoteR.has(r.uid)) && r.borehole.toLowerCase() === bname &&
        r.datetime === rr.datetime && Math.abs(r.depthFt - rr.depthFt) < 1e-6 && (r.userCode ?? '') === (rr.userCode ?? ''));
      if (!m) continue;
      if (m.uid) await ob.delete(`r:${m.uid}`);
      const next = { ...m, uid: rr.uid, seq: rr.seq, num: rr.num ?? m.num };
      used.add(m.id);
      await rs.put(next);
      nr++;
    }
    await tx.done;
  } catch (e) { try { tx.abort(); } catch { /* done */ } throw e; }
  return { boreholes: nb, readings: nr };
}

// ---- 0.5.0: Local / Shared boreholes ----

/** Drop queued items that belong to Local boreholes (a safety net run before every push; normally there are none). */
export async function outboxPurgeLocal(): Promise<number> {
  const tx = await rw(ALL);
  let n = 0;
  for (const it of await tx.objectStore('outbox').getAll()) {
    if (await isLocalRec(tx, it.kind, it.rec)) { await tx.objectStore('outbox').delete(it.key); n++; }
  }
  await tx.done;
  return n;
}

/** A free name like "MW-1 (local)", "MW-1 (local 2)"... (case-insensitive, like every borehole name). */
export function localCopyName(names: Iterable<string>, base: string): string {
  const list = [...names];
  for (let i = 1; ; i++) {
    const n = `${base} (local${i > 1 ? ` ${i}` : ''})`;
    if (!findName(list, n)) return n;
  }
}

/**
 * Local -> Shared. The borehole keeps its uid and its readings keep theirs; the borehole is queued first, then every
 * reading (the engine always pushes boreholes before readings, so no reading reaches the sheet before its borehole).
 * Returns how many readings were queued.
 */
export async function shareBorehole(name: string): Promise<number> {
  const tx = await rw(ALL);
  try {
    const b = await tx.objectStore('boreholes').get(name);
    if (!b) throw new Error(`Borehole ${name} no longer exists`);
    if (scopeOf(b) !== 'local') { await tx.done; return 0; }
    const { scope: _s, hidden: _h, ...rest } = fillBorehole(b);
    const shared: Borehole = rest;
    await tx.objectStore('boreholes').put(shared);
    await queue(tx, 'borehole', toBRec(shared));
    let n = 0;
    for (const r of await tx.objectStore('readings').index('byBorehole').getAll(name)) {
      const full = { ...r, uid: r.uid ?? uuid(), boreholeUid: shared.uid };
      if (full.uid !== r.uid || full.boreholeUid !== r.boreholeUid) await tx.objectStore('readings').put(full);
      await queue(tx, 'reading', toRRec(full));
      n++;
    }
    // Deletes made while it was Local stay on this phone only (the sheet never had those records).
    await tx.done;
    return n;
  } catch (e) { try { tx.abort(); } catch { /* done */ } throw e; }
}

/**
 * Shared -> Local, without touching the sheet: fork a NEW Local borehole (new uid) with a copy of every reading
 * (new uids, same date/time, depth, User Code and running number). The shared borehole stays exactly as it is and keeps
 * syncing, so nothing is deleted anywhere and the next pull cannot bring a duplicate back. `hideShared` hides the shared
 * one on this phone only. Returns the new borehole's name and how many readings were copied.
 */
export async function makeLocalCopy(name: string, newName: string, hideShared = false, userCode?: string): Promise<{ name: string; readings: number }> {
  const tx = await rw(ALL);
  try {
    const bs = tx.objectStore('boreholes'), rs = tx.objectStore('readings'), meta = tx.objectStore('meta');
    const src = await bs.get(name);
    if (!src) throw new Error(`Borehole ${name} no longer exists`);
    const nn = newName.trim();
    if (!nn) throw new Error('Enter a name for the local copy');
    const clash = findName(await bs.getAllKeys(), nn);
    if (clash) throw new Error(`A borehole named ${clash} already exists`);
    const now = new Date().toISOString();
    const copy: Borehole = { name: nn, uid: uuid(), scope: 'local', referencePoint: src.referencePoint, refElevationFt: src.refElevationFt, flag: '',
      createdAt: now, updatedAt: now, fieldTimes: { name: now, referencePoint: now, refElevationFt: now, flag: now } };
    await bs.put(copy);
    let id = ((await meta.get(NEXT_ID))?.value as number | undefined) ?? 1;
    let n = 0;
    // Copies get fresh Reading IDs in this phone's own range (its User Code + NEXT_SEQ, as for a new reading), so they can never
    // collide with a number another phone will use. The original ID and author are kept in the notes.
    const code = userCode ?? '';
    let nextSeq = ((await meta.get(NEXT_SEQ))?.value as number | undefined) ?? id;
    for (const o of await rs.getAll()) if ((o.userCode ?? '') === code && (o.seq ?? o.id) >= nextSeq) nextSeq = (o.seq ?? o.id) + 1;
    for (const r of (await rs.index('byBorehole').getAll(name)).sort((x, y) => x.datetime.localeCompare(y.datetime) || x.id - y.id)) {
      while (await rs.getKey(id)) id++;
      const note = `Copy of reading ${displayId(r)}`;
      await rs.add({ ...r, id, uid: uuid(), borehole: nn, boreholeUid: copy.uid, userCode: code, seq: nextSeq++, num: await takeNum(tx), notes: r.notes ? `${note}. ${r.notes}` : note });
      id++; n++;
    }
    await meta.put({ key: NEXT_ID, value: id });
    if (n) await meta.put({ key: NEXT_SEQ, value: nextSeq });
    if (hideShared && scopeOf(src) === 'shared') await bs.put({ ...src, hidden: true });
    await tx.done;
    return { name: nn, readings: n };
  } catch (e) { try { tx.abort(); } catch { /* done */ } throw e; }
}

/** Hide or show a shared borehole on this phone only. Never queued: the sheet and other phones are not affected. */
export async function setHidden(name: string, hidden: boolean) {
  const tx = await rw(['boreholes']);
  const b = await tx.objectStore('boreholes').get(name);
  if (b) { const { hidden: _h, ...rest } = b; await tx.objectStore('boreholes').put(hidden ? { ...rest, hidden: true } : rest); }
  await tx.done;
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
