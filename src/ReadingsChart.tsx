import { useState } from 'react';
import type { Unit } from './lib/types';
import { fmt2, toUnit, type DerivedReading } from './lib/math';
import { dayTicks, niceTicks, toSeries, xSpan, type Measure } from './lib/chart';
import { displayId } from './lib/ids';

// Colour-blind-safe palette (Okabe–Ito + extras); line dash patterns repeat after it so many boreholes stay distinct.
const COLORS = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9', '#7F3C8D', '#999933'];
const DASH = ['', '6 4', '2 3', '10 3 2 3'];
const MEASURE_KEY = 'wl.chartMeasure';
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (t: number) => { const d = new Date(t); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const fmtYear = (t: number) => String(new Date(t).getUTCFullYear());

/**
 * 0.6.0: readings over time, one line per borehole. Plain SVG (works offline, no chart library).
 * Water elevation: up = water higher. Depth to water: drawn with the axis flipped, so down = deeper (water lower) and both views look alike.
 */
export default function ReadingsChart({ rows, unit, from, to }: { rows: DerivedReading[]; unit: Unit; from: string; to: string }) {
  const [measure, setMeasureState] = useState<Measure>(() => (localStorage.getItem(MEASURE_KEY) === 'depth' ? 'depth' : 'elevation'));
  const setMeasure = (m: Measure) => { setMeasureState(m); try { localStorage.setItem(MEASURE_KEY, m); } catch { /* private mode */ } };
  const series = toSeries(rows, measure, (ft) => toUnit(ft, unit));
  const span = xSpan(series, from, to);
  const n = series.reduce((k, s) => k + s.pts.length, 0);
  const title = measure === 'elevation' ? `Water elevation (${unit})` : `Depth to water (${unit})`;
  const dir = measure === 'elevation' ? '↑ higher = water higher' : '↓ deeper = water lower';
  const W = 360, H = 236, L = 54, R = 12, T = 14, B = 34;
  let body = null;
  if (span && n) {
    const vs = series.flatMap((s) => s.pts.map((p) => p.v));
    const ticks = niceTicks(Math.min(...vs), Math.max(...vs));
    const lo = ticks[0], hi = ticks[ticks.length - 1];
    const [t0, t1] = span;
    const x = (t: number) => L + ((t - t0) / (t1 - t0)) * (W - L - R);
    // Elevation: high values at the top. Depth: small depths at the top (axis flipped).
    const y = (v: number) => { const f = (v - lo) / (hi - lo); return T + (measure === 'elevation' ? 1 - f : f) * (H - T - B); };
    const xt = dayTicks(t0, t1, 4);
    const multiYear = fmtYear(t0) !== fmtYear(t1);
    const many = n > 80;
    body = (
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}, ${series.length} borehole(s), ${n} reading(s)`} data-testid="chart-svg">
        {ticks.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" /><text x={L - 5} y={y(v) + 4} textAnchor="end">{fmt2(v)}</text></g>)}
        {xt.map((t, i) => <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={T} y2={H - B} className="grid" />
          <text x={x(t)} y={H - B + 16} textAnchor={i === 0 ? 'start' : i === xt.length - 1 ? 'end' : 'middle'}>{fmtDay(t)}</text>
          {(multiYear || i === 0) && <text x={x(t)} y={H - B + 31} className="sub" textAnchor={i === 0 ? 'start' : i === xt.length - 1 ? 'end' : 'middle'}>{fmtYear(t)}</text>}
        </g>)}
        {series.map((s, i) => {
          const c = COLORS[i % COLORS.length], dash = DASH[Math.floor(i / COLORS.length) % DASH.length];
          const d = s.pts.map((p, j) => `${j ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
          return <g key={s.borehole} data-testid="chart-series" data-borehole={s.borehole}>
            {s.pts.length > 1 && <path d={d} fill="none" stroke={c} strokeWidth={2.5} strokeDasharray={dash || undefined} strokeLinejoin="round" />}
            {(!many || s.pts.length === 1) && s.pts.map((p) => <circle key={p.r.id} cx={x(p.t)} cy={y(p.v)} r={3.5} fill={c}>
              <title>{`${s.borehole} · Reading ${displayId(p.r)} · ${p.r.datetime.replace('T', ' ')}: ${fmt2(p.v)} ${unit}`}</title></circle>)}
          </g>;
        })}
      </svg>
    );
  }
  return (
    <figure className="chart multi" data-testid="readings-chart">
      <div className="chart-head">
        <div className="seg small-seg" role="group" aria-label="Chart shows">
          <button type="button" className={measure === 'elevation' ? 'on' : ''} aria-pressed={measure === 'elevation'} onClick={() => setMeasure('elevation')} data-testid="chart-elev">Water elevation</button>
          <button type="button" className={measure === 'depth' ? 'on' : ''} aria-pressed={measure === 'depth'} onClick={() => setMeasure('depth')} data-testid="chart-depth">Depth to water</button>
        </div>
      </div>
      <p className="axis-label" data-testid="chart-axis">{title} <span className="muted">{dir}</span></p>
      {body ?? <p className="muted small chart-empty">No readings to chart for this selection.</p>}
      {body && <ul className="legend" data-testid="chart-legend">
        {series.map((s, i) => <li key={s.borehole}>
          <svg width="26" height="10" aria-hidden="true"><line x1="1" x2="25" y1="5" y2="5" stroke={COLORS[i % COLORS.length]} strokeWidth="3" strokeDasharray={DASH[Math.floor(i / COLORS.length) % DASH.length] || undefined} /></svg>
          {s.borehole} <span className="muted">({s.pts.length})</span></li>)}
      </ul>}
    </figure>
  );
}
