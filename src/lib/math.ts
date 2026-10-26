import type { Reading, Unit } from './types';

export const FT_PER_M = 1 / 0.3048;

/** Round to 2 decimals without binary float artefacts (e.g. 1.005 -> 1.01, -0 -> 0). */
export function round2(n: number): number {
  const r = Math.round((n + Math.sign(n) * Number.EPSILON * Math.max(1, Math.abs(n))) * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}
export function fmt2(n: number | undefined | null): string {
  return n == null || !Number.isFinite(n) ? '' : round2(n).toFixed(2);
}
export const toUnit = (ft: number, u: Unit) => (u === 'ft' ? ft : ft * 0.3048);
export const fromUnit = (v: number, u: Unit) => (u === 'ft' ? v : v * FT_PER_M);
export function fmtLen(ft: number | undefined, u: Unit): string {
  return ft == null ? '' : fmt2(toUnit(ft, u));
}

/** Parse a user-entered decimal (accepts "," as decimal separator). Returns NaN when invalid. */
export function parseDecimal(s: string): number {
  const raw = s.trim();
  // A comma is a decimal comma only on its own, never a thousands separator ("1,050" is rejected, not 1.05).
  if (raw.includes(',') && (raw.includes('.') || /,\d{3}$/.test(raw))) return NaN;
  const t = raw.replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
  return Number(t);
}

export function waterElevationFt(r: Pick<Reading, 'depthFt' | 'refElevationFt'>): number {
  return r.refElevationFt - r.depthFt;
}

export interface DerivedReading extends Reading {
  waterElevFt: number;
}

export function compareReadings(a: Reading, b: Reading): number {
  return a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : a.id - b.id;
}

/** Readings in date/time order (Reading ID breaks ties) with computed water elevation. */
export function deriveReadings(readings: Reading[]): DerivedReading[] {
  return [...readings].sort(compareReadings).map((r) => ({ ...r, waterElevFt: waterElevationFt(r) }));
}

export function latestPerBorehole(derived: DerivedReading[]): Map<string, DerivedReading> {
  const m = new Map<string, DerivedReading>();
  for (const d of derived) m.set(d.borehole, d);
  return m;
}

export function inDateRange(datetime: string, from?: string, to?: string): boolean {
  const day = datetime.slice(0, 10);
  return (!from || day >= from) && (!to || day <= to);
}

/** The phone's local clock as "YYYY-MM-DDTHH:mm". */
export function nowLocal(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const todayLocal = () => nowLocal().slice(0, 10);
