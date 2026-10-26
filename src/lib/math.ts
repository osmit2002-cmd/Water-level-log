import type { Reading, Unit } from './types';

export const FT_PER_M = 1 / 0.3048;
export const WARN_CHANGE_FT = 10;

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
export function fmtChange(ft: number | undefined, u: Unit): string {
  if (ft == null) return '';
  const v = round2(toUnit(ft, u));
  return (v > 0 ? '+' : '') + v.toFixed(2);
}
export function changeLabel(ft: number | undefined, u: Unit = 'ft'): 'rise' | 'fall' | 'no change' | '' {
  if (ft == null) return '';
  const v = round2(toUnit(ft, u));
  return v > 0 ? 'rise' : v < 0 ? 'fall' : 'no change';
}

/** Parse a user-entered decimal (accepts "," as decimal separator). Returns NaN when invalid. */
export function parseDecimal(s: string): number {
  const t = s.trim().replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
  return Number(t);
}

export function waterElevationFt(r: Pick<Reading, 'status' | 'depthFt' | 'refElevationFt'>): number | undefined {
  if (r.status !== 'ok' || r.depthFt == null) return undefined;
  return r.refElevationFt - r.depthFt;
}

export interface DerivedReading extends Reading {
  waterElevFt?: number;
  changeFt?: number; // vs previous valid reading of the same borehole
}

export function compareReadings(a: Reading, b: Reading): number {
  return a.datetime < b.datetime ? -1 : a.datetime > b.datetime ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
}

/** Chronological readings per borehole with water elevation and change from the previous valid reading. */
export function deriveReadings(readings: Reading[]): DerivedReading[] {
  const sorted = [...readings].sort(compareReadings);
  const lastElev = new Map<string, number>();
  return sorted.map((r) => {
    const w = waterElevationFt(r);
    const d: DerivedReading = { ...r, waterElevFt: w };
    if (w != null) {
      const prev = lastElev.get(r.boreholeId);
      if (prev != null) d.changeFt = w - prev;
      lastElev.set(r.boreholeId, w);
    }
    return d;
  });
}

/** Change the candidate reading would have once saved (insert or replace by uid), using the same chronology as the lists. */
export function previewChange(readings: Reading[], candidate: Reading): number | undefined {
  const others = readings.filter((r) => r.uid !== candidate.uid);
  return deriveReadings([...others, candidate]).find((r) => r.uid === candidate.uid)?.changeFt;
}

export function latestPerBorehole(derived: DerivedReading[]): Map<string, DerivedReading> {
  const m = new Map<string, DerivedReading>();
  for (const d of derived) if (d.waterElevFt != null) m.set(d.boreholeId, d);
  return m;
}

export function inDateRange(datetime: string, from?: string, to?: string): boolean {
  const day = datetime.slice(0, 10);
  return (!from || day >= from) && (!to || day <= to);
}

export function nowLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const todayLocal = () => nowLocal().slice(0, 10);
