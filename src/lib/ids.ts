import type { Reading } from './types';

/** Random UUID v4 (crypto.randomUUID needs iOS 15.4+; fall back to getRandomValues). */
export function uuid(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * 0.6.0 display Reading ID: just the number (1, 2, 3...). Shared readings are numbered by the sheet (one sequence for the
 * whole team, never reused); a new reading shows a provisional number until it syncs. The uid stays the sync key.
 */
export function displayId(r: Pick<Reading, 'num' | 'seq' | 'id'>): string {
  return String(r.num ?? r.seq ?? r.id);
}
