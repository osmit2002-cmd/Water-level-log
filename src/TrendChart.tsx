import type { Unit } from './lib/types';
import { fmt2, toUnit, type DerivedReading } from './lib/math';

/** Lightweight SVG line chart of water elevation over time (valid readings only). */
export default function TrendChart({ readings, unit }: { readings: DerivedReading[]; unit: Unit }) {
  const pts = readings.filter((r) => r.waterElevFt != null).map((r) => ({ t: Date.parse(r.datetime), v: toUnit(r.waterElevFt!, unit), r }));
  if (pts.length < 2) return <p className="muted small chart-empty">The trend chart appears after two water levels.</p>;
  const W = 340, H = 180, L = 52, R = 10, T = 12, B = 26;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  let v0 = Math.min(...pts.map((p) => p.v)), v1 = Math.max(...pts.map((p) => p.v));
  if (v1 - v0 < 0.5) { const m = (v0 + v1) / 2; v0 = m - 0.25; v1 = m + 0.25; }
  const pad = (v1 - v0) * 0.08; v0 -= pad; v1 += pad;
  const x = (t: number) => L + (t1 === t0 ? (W - L - R) / 2 : ((t - t0) / (t1 - t0)) * (W - L - R));
  const y = (v: number) => T + (1 - (v - v0) / (v1 - v0)) * (H - T - B);
  const ticks = [v0 + pad, (v0 + v1) / 2, v1 - pad];
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  return (
    <figure className="chart" data-testid="trend-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Water elevation trend, ${pts.length} readings`}>
        {ticks.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" /><text x={L - 4} y={y(v) + 4} textAnchor="end">{fmt2(v)}</text></g>)}
        <text x={L} y={H - 6}>{pts[0].r.datetime.slice(0, 10)}</text>
        <text x={W - R} y={H - 6} textAnchor="end">{pts[pts.length - 1].r.datetime.slice(0, 10)}</text>
        <path d={d} className="line" />
        {pts.map((p) => <circle key={p.r.id} cx={x(p.t)} cy={y(p.v)} r={3.5} className="dot"><title>{`${p.r.datetime.replace('T', ' ')}: ${fmt2(p.v)} ${unit}`}</title></circle>)}
      </svg>
      <figcaption className="muted small">Water elevation ({unit})</figcaption>
    </figure>
  );
}
