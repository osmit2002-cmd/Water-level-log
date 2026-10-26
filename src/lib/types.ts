export type Unit = 'ft' | 'm';

/** All lengths are stored in feet. A borehole is identified by its (unique, renamable) name. */
export interface Borehole {
  name: string;
  referencePoint: string; // e.g. "top of casing", "collar"
  refElevationFt: number;
  createdAt: string;
  updatedAt: string;
}

export interface Reading {
  id: number; // Reading ID: sequential, assigned at save, never reused
  borehole: string; // borehole name
  datetime: string; // phone clock at save, local "YYYY-MM-DDTHH:mm"
  referencePoint: string; // snapshot at save
  refElevationFt: number; // snapshot at save
  depthFt: number; // depth to top of water below the reference point
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

/** Report/CSV columns, in their fixed order. */
export const COLUMNS = ['readingId', 'boreholeName', 'date', 'time', 'referencePoint', 'refElevation', 'depth', 'waterElevation', 'notes'] as const;
export type ColumnKey = (typeof COLUMNS)[number];
export type Columns = Record<ColumnKey, boolean>;

export interface Settings {
  unit: Unit;
  theme: 'auto' | 'light' | 'dark';
  columns: Columns;
}
export const ALL_COLUMNS: Columns = Object.fromEntries(COLUMNS.map((c) => [c, true])) as Columns;
export const DEFAULT_SETTINGS: Settings = { unit: 'ft', theme: 'auto', columns: { ...ALL_COLUMNS } };

/** Clean untrusted settings (localStorage, backups). Unknown column keys are dropped; at least one column stays on. */
export function normalizeSettings(x: unknown): Settings {
  const s = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const c = (s.columns && typeof s.columns === 'object' ? s.columns : {}) as Record<string, unknown>;
  const columns = Object.fromEntries(COLUMNS.map((k) => [k, c[k] !== false])) as Columns;
  if (!COLUMNS.some((k) => columns[k])) Object.assign(columns, ALL_COLUMNS);
  return { unit: s.unit === 'm' ? 'm' : 'ft', theme: s.theme === 'light' || s.theme === 'dark' ? s.theme : 'auto', columns };
}
