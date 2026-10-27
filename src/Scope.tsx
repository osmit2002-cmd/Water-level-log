import type { Borehole, Scope } from './lib/types';
import { scopeOf } from './lib/types';

/** 0.5.0: which boreholes a page shows. Remembered per selector on this phone. */
export type ScopeFilter = Scope | 'all';
export const RD_SCOPE = 'wll-reading-scope';
export const LIST_SCOPE = 'wll-readings-scope';
export function loadScope<T extends ScopeFilter>(key: string, allowed: readonly T[], fallback: T): T {
  try { const v = localStorage.getItem(key) as T | null; return v && allowed.includes(v) ? v : fallback; } catch { return fallback; }
}
export function saveScope(key: string, v: ScopeFilter) { try { localStorage.setItem(key, v); } catch { /* private mode */ } }
/** Boreholes shown in pickers and lists: not hidden on this phone, and in the chosen scope. */
export const inScope = (b: Borehole, f: ScopeFilter) => !b.hidden && (f === 'all' || scopeOf(b) === f);

const TEXT: Record<Scope, { label: string; hint: string }> = {
  local: { label: 'Local', hint: 'this phone only' },
  shared: { label: 'Shared', hint: 'synced' }
};
export function ScopeBadge({ scope, long }: { scope: Scope; long?: boolean }) {
  return <span className={`scope-badge ${scope}`} data-testid={`scope-badge-${scope}`}>{scope === 'local' ? '📱' : '☁️'} {TEXT[scope].label}{long ? ` · ${TEXT[scope].hint}` : ''}</span>;
}

/** Segmented Local / Shared (/ All) control. */
export function ScopeSwitch<T extends ScopeFilter>({ value, options, onChange, testid, counts, disabled, label }: {
  value: T; options: readonly T[]; onChange: (v: T) => void; testid: string; counts?: Partial<Record<T, number>>; disabled?: boolean; label: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label} data-testid={testid}>
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={value === o} className={value === o ? 'on' : ''} disabled={disabled}
          data-testid={`${testid}-${o}`} onClick={() => onChange(o)}>
          {o === 'all' ? 'All' : TEXT[o as Scope].label}{counts?.[o] !== undefined ? ` (${counts[o]})` : ''}
        </button>
      ))}
    </div>
  );
}
