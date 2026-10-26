export type Unit = 'ft' | 'm';

/** All lengths are stored in feet. A borehole is identified by its (unique, renamable) name. */
export interface Borehole {
  name: string;
  referencePoint: string; // e.g. "top of casing", "collar"
  refElevationFt: number;
  createdAt: string;
  updatedAt: string;
  /** 0.4.0 sync: stable internal ID (filled in by the database layer). */
  uid?: string;
  /** 0.4.0 sync: when each field was last edited (ISO, client clock). Newest wins per field. */
  fieldTimes?: Partial<Record<BoreholeField, string>>;
  /** Set when two phones created the same Borehole Name and the records were merged; '' = nothing to check. */
  flag?: string;
}
export const BOREHOLE_FIELDS = ['name', 'referencePoint', 'refElevationFt', 'flag'] as const;
export type BoreholeField = (typeof BOREHOLE_FIELDS)[number];

export interface Reading {
  id: number; // Reading ID: sequential, assigned at save, never reused
  borehole: string; // borehole name
  datetime: string; // phone clock at save, local "YYYY-MM-DDTHH:mm"
  referencePoint: string; // snapshot at save
  refElevationFt: number; // snapshot at save
  depthFt: number; // depth to top of water below the reference point
  userCode: string; // phone's User Code at save ('' for readings from before 0.3.0)
  notes?: string;
  createdAt: string;
  updatedAt: string;
  /** 0.4.0 sync: stable internal ID (filled in by the database layer). */
  uid?: string;
  /** 0.4.0 sync: the borehole's uid. */
  boreholeUid?: string;
  /** Per-phone running number used in the display ID USERCODE-0001 (legacy readings: their old Reading ID). */
  seq?: number;
}

/** Report/CSV columns, in their fixed order. */
export const COLUMNS = ['readingId', 'boreholeName', 'date', 'time', 'userCode', 'referencePoint', 'refElevation', 'depth', 'waterElevation', 'notes'] as const;
export type ColumnKey = (typeof COLUMNS)[number];
export type Columns = Record<ColumnKey, boolean>;

export interface Settings {
  unit: Unit;
  theme: 'auto' | 'light' | 'dark';
  columns: Columns;
  /** Set once per phone; stamped onto each new reading. '' = not set yet. */
  userCode: string;
}
export const ALL_COLUMNS: Columns = Object.fromEntries(COLUMNS.map((c) => [c, true])) as Columns;
export const DEFAULT_SETTINGS: Settings = { unit: 'ft', theme: 'auto', columns: { ...ALL_COLUMNS }, userCode: '' };

export const USER_CODE_MAX = 20;
/** Trim and uppercase; spaces become '-'. */
export const normalizeUserCode = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '-');
/** Error text for a (normalized) code, or '' when valid. */
export function userCodeError(code: string): string {
  if (!code) return 'Enter a User Code';
  if (code.length > USER_CODE_MAX) return `User Code can be at most ${USER_CODE_MAX} characters`;
  if (!/^[A-Z0-9_-]+$/.test(code)) return 'Use only letters, numbers, - and _';
  return '';
}

/** Clean untrusted settings (localStorage, backups). Unknown column keys are dropped; at least one column stays on. */
export function normalizeSettings(x: unknown): Settings {
  const s = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
  const c = (s.columns && typeof s.columns === 'object' ? s.columns : {}) as Record<string, unknown>;
  const columns = Object.fromEntries(COLUMNS.map((k) => [k, c[k] !== false])) as Columns;
  if (!COLUMNS.some((k) => columns[k])) Object.assign(columns, ALL_COLUMNS);
  return { unit: s.unit === 'm' ? 'm' : 'ft', theme: s.theme === 'light' || s.theme === 'dark' ? s.theme : 'auto', columns, userCode: cleanCode(s.userCode) };
}
function cleanCode(x: unknown): string {
  const c = typeof x === 'string' ? normalizeUserCode(x) : '';
  return userCodeError(c) ? '' : c;
}
