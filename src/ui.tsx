import type { Unit } from './lib/types';
import { changeLabel, fmtChange } from './lib/math';

export function Change({ ft, unit }: { ft?: number; unit: Unit }) {
  if (ft == null) return <span className="muted">—</span>;
  const l = changeLabel(ft, unit);
  const cls = l === 'rise' ? 'rise' : l === 'fall' ? 'fall' : 'muted';
  const arrow = l === 'rise' ? '▲' : l === 'fall' ? '▼' : '•';
  return <span className={cls}>{arrow} {fmtChange(ft, unit)} {unit} <small>{l}</small></span>;
}
