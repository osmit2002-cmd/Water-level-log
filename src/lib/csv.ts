import { displayId } from './ids';
import type { Borehole, ColumnKey, Columns, Unit } from './types';
import { COLUMNS } from './types';
import type { DerivedReading } from './math';
import { fmt2, fromUnit, parseDecimal, toUnit } from './math';

export const BOM = '\uFEFF';

/** RFC 4180 field quoting. */
export function quoteField(s: string): string {
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
/** Guard free-text cells against spreadsheet formula injection (=, +, -, @, tab, CR prefix). */
export function textCell(s: string | undefined | null): string {
  const v = s ?? '';
  return quoteField(/^[=+\-@\t\r]/.test(v) ? "'" + v : v);
}
/** Numbers are emitted as plain decimals (never formula-guarded, so negatives stay numeric). */
export function numCell(n: number | undefined | null): string {
  return fmt2(n);
}
export function toCsv(rows: string[][]): string {
  return BOM + rows.map((r) => r.join(',')).join('\r\n') + '\r\n';
}

/** RFC 4180 parser. Strips a UTF-8 BOM, handles quoted fields, "" escapes, CRLF/LF, embedded newlines. */
export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { f += '"'; i++; } else q = false;
      } else f += c;
    } else if (c === '"' && f === '') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(f); rows.push(row); row = []; f = '';
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}
/** Undo the export-side formula guard on import. */
export function unguard(s: string): string {
  return /^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s;
}

/** Column header for reports/CSV. Length headers carry the display unit. */
export function columnLabel(c: ColumnKey, u: Unit): string {
  switch (c) {
    case 'readingId': return 'Reading ID';
    case 'boreholeName': return 'Borehole Name';
    case 'date': return 'Date';
    case 'time': return 'Time';
    case 'userCode': return 'User Code';
    case 'referencePoint': return 'Reference Point';
    case 'refElevation': return `Reference Elevation (${u})`;
    case 'depth': return `Depth to Top of Water (${u})`;
    case 'waterElevation': return `Water Elevation (${u})`;
    case 'notes': return 'Notes';
  }
}
export const enabledColumns = (cols: Columns): ColumnKey[] => COLUMNS.filter((c) => cols[c]);

export function readingsHeader(u: Unit, cols: Columns): string[] {
  return enabledColumns(cols).map((c) => columnLabel(c, u));
}

function readingCell(r: DerivedReading, c: ColumnKey, u: Unit): string {
  const L = (ft: number) => numCell(toUnit(ft, u));
  switch (c) {
    case 'readingId': return displayId(r);
    case 'boreholeName': return textCell(r.borehole);
    case 'date': return r.datetime.slice(0, 10);
    case 'time': return r.datetime.slice(11, 16);
    case 'userCode': return textCell(r.userCode);
    case 'referencePoint': return textCell(r.referencePoint);
    case 'refElevation': return L(r.refElevationFt);
    case 'depth': return L(r.depthFt);
    case 'waterElevation': return L(r.waterElevFt);
    case 'notes': return textCell(r.notes);
  }
}

export function readingsCsv(readings: DerivedReading[], u: Unit, cols: Columns): string {
  const keys = enabledColumns(cols);
  return toCsv([readingsHeader(u, cols), ...readings.map((r) => keys.map((c) => readingCell(r, c, u)))]);
}

export function boreholesHeader(u: Unit): string[] {
  return ['Borehole Name', 'Reference Point', `Reference Elevation (${u})`];
}
export function boreholesCsv(list: Borehole[], u: Unit): string {
  return toCsv([boreholesHeader(u), ...list.map((b) => [textCell(b.name), textCell(b.referencePoint), numCell(toUnit(b.refElevationFt, u))])]);
}

/** A borehole row from an import. referencePoint is only set when that column exists (absent columns keep existing values). */
export type BoreholePatch = Pick<Borehole, 'name' | 'refElevationFt'> & Partial<Pick<Borehole, 'referencePoint'>>;

export interface ImportResult {
  rows: BoreholePatch[];
  errors: { line: number; message: string }[];
}

/** "Reference Elevation (ft)" / "reference_elevation_ft" -> "reference_elevation_ft". */
const normHeader = (h: string) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** Parse a boreholes CSV (Borehole Name, Reference Point, Reference Elevation (ft|m)). Matched by name. */
export function parseBoreholesCsv(text: string, fallback: Unit): ImportResult {
  const out: ImportResult = { rows: [], errors: [] };
  const rows = parseCsv(text);
  if (!rows.length) { out.errors.push({ line: 1, message: 'File is empty' }); return out; }
  const h = rows[0].map(normHeader);
  const find = (...names: string[]) => names.map((n) => h.indexOf(n)).find((i) => i >= 0) ?? -1;
  const iName = find('borehole_name', 'borehole', 'name');
  const iRp = find('reference_point');
  let iElev = -1, elevUnit: Unit = fallback;
  for (const [n, u] of [['reference_elevation_ft', 'ft'], ['reference_elevation_m', 'm'], ['reference_elevation', fallback], ['elevation', fallback]] as const) {
    if (iElev < 0 && h.indexOf(n) >= 0) { iElev = h.indexOf(n); elevUnit = u; }
  }
  if (iName < 0 || iElev < 0) {
    out.errors.push({ line: 1, message: 'Header must include Borehole Name and Reference Elevation (ft) or (m)' });
    return out;
  }
  const seen = new Map<string, number>();
  rows.slice(1).forEach((r, k) => {
    const line = k + 2;
    const get = (i: number) => (i >= 0 && i < r.length ? unguard(r[i].trim()) : '');
    const name = get(iName);
    if (!name) return out.errors.push({ line, message: 'Missing Borehole Name' });
    const elev = parseDecimal(get(iElev));
    if (!Number.isFinite(elev)) return out.errors.push({ line, message: `${name}: reference elevation "${get(iElev)}" is not a number` });
    const row: BoreholePatch = { name, refElevationFt: fromUnit(elev, elevUnit) };
    if (iRp >= 0) row.referencePoint = get(iRp) || 'top of casing';
    const key = name.toLowerCase();
    if (seen.has(key)) out.errors.push({ line, message: `${name}: duplicate of line ${seen.get(key)}; last row wins` });
    seen.set(key, line);
    const prev = out.rows.findIndex((x) => x.name.toLowerCase() === key);
    if (prev >= 0) out.rows[prev] = row; else out.rows.push(row);
  });
  return out;
}

export function csvFilename(scope: string, date: string): string {
  const safe = scope.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'borehole';
  return `waterlevels_${safe}_${date}.csv`;
}
