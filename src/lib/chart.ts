import type { DerivedReading } from './math';

/** 0.6.0 chart quick ranges (days, counting today). */
export const QUICK_DAYS = [7, 28, 180, 365] as const;
export type QuickDays = (typeof QUICK_DAYS)[number];

/** "YYYY-MM-DD" plus n days (calendar days, no time zone involved). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
/** Last N days including today: from = today − (N − 1), to = today. */
export function quickRange(days: number, today: string): { from: string; to: string } {
  return { from: addDays(today, -(days - 1)), to: today };
}
/** Which quick button matches the current From/To (null = a custom range or none). */
export function activeQuick(from: string, to: string, today: string): QuickDays | null {
  for (const d of QUICK_DAYS) { const q = quickRange(d, today); if (q.from === from && q.to === to) return d; }
  return null;
}

export type Measure = 'elevation' | 'depth';
export interface Series { borehole: string; pts: { t: number; v: number; r: DerivedReading }[] }
/** "YYYY-MM-DDTHH:mm" (phone local) as a number for the x axis; UTC is used only as a neutral scale. */
export const tOf = (dt: string) => Date.parse(`${dt.length === 10 ? `${dt}T00:00` : dt}:00Z`);

/** One series per borehole (in name order), points in time order. Readings without a valid value are skipped. */
export function toSeries(rows: DerivedReading[], measure: Measure, conv: (ft: number) => number = (x) => x): Series[] {
  const by = new Map<string, Series>();
  for (const r of rows) {
    const ft = measure === 'elevation' ? r.waterElevFt : r.depthFt;
    if (ft == null || !Number.isFinite(ft)) continue;
    let s = by.get(r.borehole);
    if (!s) by.set(r.borehole, (s = { borehole: r.borehole, pts: [] }));
    s.pts.push({ t: tOf(r.datetime), v: conv(ft), r });
  }
  const out = [...by.values()].sort((a, b) => a.borehole.localeCompare(b.borehole, undefined, { numeric: true }));
  for (const s of out) s.pts.sort((a, b) => a.t - b.t);
  return out;
}

/** The x span: the chosen From/To days if set (whole days), else the data's first..last reading. */
export function xSpan(series: Series[], from: string, to: string): [number, number] | null {
  const ts = series.flatMap((s) => s.pts.map((p) => p.t));
  if (!ts.length) return null;
  const t0 = from ? tOf(from) : Math.min(...ts);
  const t1 = to ? tOf(addDays(to, 1)) - 60_000 : Math.max(...ts);
  if (t1 <= t0) return [t0 - 43_200_000, t0 + 43_200_000]; // a single moment: show half a day each side
  return [t0, t1];
}

/** Rounded y-axis ticks covering [lo, hi] (3–6 ticks). */
export function niceTicks(lo: number, hi: number): number[] {
  if (!(hi > lo)) { lo -= 0.5; hi += 0.5; }
  const raw = (hi - lo) / 4, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => (hi - lo) / s <= 5)!;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  if (out[0] > lo) out.unshift(out[0] - step);
  if (out[out.length - 1] < hi) out.push(out[out.length - 1] + step);
  return out.map((v) => Number(v.toPrecision(12)));
}

/** Date labels for the x axis: about `n` evenly spaced days. */
export function dayTicks(t0: number, t1: number, n = 4): number[] {
  if (n < 2) return [t0];
  return Array.from({ length: n }, (_, i) => t0 + ((t1 - t0) * i) / (n - 1));
}
