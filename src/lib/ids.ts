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
 * Display Reading ID: USERCODE-0001 (User Code at save + that phone's running number, at least 4 digits).
 * Readings saved before 0.4.0 keep their old number as the running number; readings without a User Code
 * (saved before 0.3.0) use the prefix LEGACY-.
 */
export function displayId(r: Pick<Reading, 'userCode' | 'seq' | 'id'>): string {
  const n = r.seq ?? r.id;
  return `${r.userCode || 'LEGACY'}-${String(n).padStart(4, '0')}`;
}
