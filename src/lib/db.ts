import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Borehole, Reading } from './types';
import type { BoreholePatch } from './csv';
import { migrateV1, type V1Borehole, type V1Reading } from './migrate';

interface WLSchema extends DBSchema {
  boreholes: { key: string; value: Borehole };
  readings: { key: number; value: Reading; indexes: { byBorehole: string } };
  meta: { key: string; value: { key: string; value: unknown } };
}
export const DB_NAME = 'water-level-log';
export const DB_VERSION = 2;
const NEXT_ID = 'nextReadingId';

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
     } catch (e) { try { tx.abort(); } catch { /* already aborted */ } throw e; }
    },
    blocking() { void dbp?.then((d) => d.close()); dbp = undefined; },
    terminated() { dbp = undefined; }
  }).catch((e) => { dbp = undefined; throw e; });
  return dbp;
}

export const allBoreholes = async () => (await db()).getAll('boreholes');
// Readings saved before 0.3.0 have no userCode: treat as blank.
export const allReadings = async () => (await db()).getAll('readings').then((rs) => rs.map((r) => ({ ...r, userCode: r.userCode ?? '' })));
export async function getNextReadingId(): Promise<number> {
  return ((await (await db()).get('meta', NEXT_ID))?.value as number | undefined) ?? 1;
}

/** Insert a new reading with the next Reading ID (atomic; IDs are never reused, even after deletes). */
export async function addReading(r: Omit<Reading, 'id'>): Promise<number> {
  const tx = (await db()).transaction(['readings', 'meta', 'boreholes'], 'readwrite');
  if (!(await tx.objectStore('boreholes').getKey(r.borehole))) { tx.abort(); throw new Error(`Borehole ${r.borehole} no longer exists`); }
  const meta = tx.objectStore('meta');
  const rs = tx.objectStore('readings');
  let id = ((await meta.get(NEXT_ID))?.value as number | undefined) ?? 1;
  while (await rs.getKey(id)) id++; // defensive: never overwrite
  await rs.add({ ...r, id });
  await meta.put({ key: NEXT_ID, value: id + 1 });
  await tx.done;
  return id;
}
/** Update an existing reading (same ID). */
export async function updateReading(r: Reading) {
  const tx = (await db()).transaction(['readings', 'boreholes'], 'readwrite');
  if (!(await tx.objectStore('boreholes').getKey(r.borehole))) { tx.abort(); throw new Error(`Borehole ${r.borehole} no longer exists`); }
  await tx.objectStore('readings').put(r);
  await tx.done;
}
export const deleteReading = async (id: number) => { await (await db()).delete('readings', id); };

export const findName = (names: Iterable<string>, name: string) => {
  const k = name.trim().toLowerCase();
  for (const n of names) if (n.toLowerCase() === k) return n;
  return undefined;
};

/**
 * Create or update a borehole. `oldName` = current name when editing; a different `b.name` renames it
 * and moves its readings to the new name in the same transaction. Names are unique (case-insensitive).
 */
export async function saveBorehole(b: Borehole, oldName?: string) {
  const tx = (await db()).transaction(['boreholes', 'readings'], 'readwrite');
  const bs = tx.objectStore('boreholes');
  const clash = findName(await bs.getAllKeys(), b.name);
  if (clash && clash !== oldName) { tx.abort(); throw new Error(`A borehole named ${clash} already exists`); }
  if (oldName && oldName !== b.name) {
    const rs = tx.objectStore('readings');
    for (const r of await rs.index('byBorehole').getAll(oldName)) await rs.put({ ...r, borehole: b.name });
    await bs.delete(oldName);
  }
  await bs.put(b);
  await tx.done;
}

export async function deleteBorehole(name: string) {
  const tx = (await db()).transaction(['boreholes', 'readings'], 'readwrite');
  const rs = tx.objectStore('readings');
  for (const key of await rs.index('byBorehole').getAllKeys(name)) await rs.delete(key);
  await tx.objectStore('boreholes').delete(name);
  await tx.done;
}

/** Upsert by name (case-insensitive match keeps the existing spelling). Absent columns keep existing values. */
export async function upsertBoreholes(list: BoreholePatch[]) {
  const tx = (await db()).transaction('boreholes', 'readwrite');
  const now = new Date().toISOString();
  const names = await tx.store.getAllKeys();
  let added = 0, updated = 0;
  for (const p of list) {
    const existing = findName(names, p.name);
    const old = existing ? await tx.store.get(existing) : undefined;
    if (old) updated++; else { added++; names.push(p.name); }
    await tx.store.put({
      name: old?.name ?? p.name, referencePoint: p.referencePoint ?? old?.referencePoint ?? 'top of casing', // Keep the stored value when the CSV only differs by export rounding (2 dp in ft or m), so a round trip changes nothing.
      refElevationFt: old && Math.abs(old.refElevationFt - p.refElevationFt) < 0.017 ? old.refElevationFt : p.refElevationFt,
      createdAt: old?.createdAt ?? now, updatedAt: now
    });
  }
  await tx.done;
  return { added, updated };
}

/** Replace all data (restore). The ID counter only moves forward, so IDs used on this device are never handed out again. */
export async function replaceAll(boreholes: Borehole[], readings: Reading[], nextReadingId: number) {
  const tx = (await db()).transaction(['boreholes', 'readings', 'meta'], 'readwrite');
  const cur = ((await tx.objectStore('meta').get(NEXT_ID))?.value as number | undefined) ?? 1;
  await tx.objectStore('boreholes').clear();
  await tx.objectStore('readings').clear();
  for (const b of boreholes) await tx.objectStore('boreholes').put(b);
  for (const r of readings) await tx.objectStore('readings').put(r);
  const maxId = readings.reduce((m, r) => Math.max(m, r.id), 0);
  await tx.objectStore('meta').put({ key: NEXT_ID, value: Math.max(cur, nextReadingId, maxId + 1) });
  await tx.done;
}

/** Ask the browser to keep our storage (iOS may still evict; JSON backups are the safety net). */
export async function requestPersist(): Promise<boolean | undefined> {
  try {
    if (!navigator.storage?.persist) return undefined;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return undefined; }
}
