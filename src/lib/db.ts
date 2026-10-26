import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Borehole, Reading } from './types';
import type { BoreholePatch } from './csv';

interface WLSchema extends DBSchema {
  boreholes: { key: string; value: Borehole };
  readings: { key: string; value: Reading; indexes: { byBorehole: string } };
}

let dbp: Promise<IDBPDatabase<WLSchema>> | undefined;
export function db() {
  // On failure or when iOS terminates the connection (app backgrounded), the next call reopens it.
  dbp ??= openDB<WLSchema>('water-level-log', 1, {
    upgrade(d) {
      d.createObjectStore('boreholes', { keyPath: 'id' });
      d.createObjectStore('readings', { keyPath: 'uid' }).createIndex('byBorehole', 'boreholeId');
    },
    blocking() { void dbp?.then((d) => d.close()); dbp = undefined; },
    terminated() { dbp = undefined; }
  }).catch((e) => { dbp = undefined; throw e; });
  return dbp;
}

export const allBoreholes = async () => (await db()).getAll('boreholes');
export const allReadings = async () => (await db()).getAll('readings');
export const putBorehole = async (b: Borehole) => { await (await db()).put('boreholes', b); };
export const putReading = async (r: Reading) => { await (await db()).put('readings', r); };
export const deleteReading = async (uid: string) => { await (await db()).delete('readings', uid); };

export async function deleteBorehole(id: string) {
  const tx = (await db()).transaction(['boreholes', 'readings'], 'readwrite');
  const rs = tx.objectStore('readings');
  for (const key of await rs.index('byBorehole').getAllKeys(id)) await rs.delete(key);
  await tx.objectStore('boreholes').delete(id);
  await tx.done;
}

/** Upsert by ID. Only fields present in each row overwrite; other fields of an existing borehole are kept. */
export async function upsertBoreholes(list: BoreholePatch[]) {
  const tx = (await db()).transaction('boreholes', 'readwrite');
  const now = new Date().toISOString();
  let added = 0, updated = 0;
  for (const b of list) {
    const old = await tx.store.get(b.id);
    if (old) updated++; else added++;
    const merged = { ...old, ...b } as Borehole;
    merged.name ||= b.id;
    merged.referencePoint ||= 'top of casing';
    await tx.store.put({ ...merged, createdAt: old?.createdAt ?? now, updatedAt: now });
  }
  await tx.done;
  return { added, updated };
}

export async function replaceAll(boreholes: Borehole[], readings: Reading[]) {
  const tx = (await db()).transaction(['boreholes', 'readings'], 'readwrite');
  await tx.objectStore('boreholes').clear();
  await tx.objectStore('readings').clear();
  for (const b of boreholes) await tx.objectStore('boreholes').put(b);
  for (const r of readings) await tx.objectStore('readings').put(r);
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

export function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}
