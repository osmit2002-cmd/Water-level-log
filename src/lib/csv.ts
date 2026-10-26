import type { Borehole, Unit } from './types';
import { STATUSES } from './types';
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
function coordCell(n: number | undefined): string {
  return n == null || !Number.isFinite(n) ? '' : String(Math.round(n * 1e7) / 1e7);
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

export function readingsHeader(u: Unit): string[] {
  return ['borehole_id', 'reference_point', `reference_elevation_${u}`, 'date', 'time', `depth_to_water_${u}`, `water_elevation_${u}`,
    `change_from_previous_${u}`, `total_depth_${u}`, 'notes', 'status', 'borehole_name', 'reader', 'latitude', 'longitude'];
}

export function readingsCsv(readings: DerivedReading[], boreholes: Map<string, Borehole>, u: Unit): string {
  const L = (ft?: number) => numCell(ft == null ? undefined : toUnit(ft, u));
  const rows = readings.map((r) => {
    const b = boreholes.get(r.boreholeId);
    return [textCell(r.boreholeId), textCell(r.referencePoint), L(r.refElevationFt), r.datetime.slice(0, 10), r.datetime.slice(11, 16),
      L(r.depthFt), L(r.waterElevFt), L(r.changeFt), L(b?.totalDepthFt), textCell(r.notes), r.status, textCell(b?.name), textCell(r.reader),
      coordCell(b?.lat), coordCell(b?.lon)];
  });
  return toCsv([readingsHeader(u), ...rows]);
}

export function boreholesHeader(u: Unit): string[] {
  return ['borehole_id', 'borehole_name', 'reference_point', `reference_elevation_${u}`, `total_depth_${u}`, 'location', 'notes', 'latitude', 'longitude'];
}
export function boreholesCsv(list: Borehole[], u: Unit): string {
  const L = (ft?: number) => numCell(ft == null ? undefined : toUnit(ft, u));
  return toCsv([boreholesHeader(u), ...list.map((b) => [textCell(b.id), textCell(b.name), textCell(b.referencePoint), L(b.refElevationFt),
    L(b.totalDepthFt), textCell(b.location), textCell(b.notes), coordCell(b.lat), coordCell(b.lon)])]);
}

/** A borehole row from an import. Only keys whose column exists in the file are set (absent columns keep existing values). */
export type BoreholePatch = Pick<Borehole, 'id' | 'refElevationFt'> & Partial<Omit<Borehole, 'id' | 'refElevationFt' | 'createdAt' | 'updatedAt'>>;

export interface ImportResult {
  rows: BoreholePatch[];
  errors: { line: number; message: string }[];
}

/** Parse a boreholes CSV. Each length column's unit comes from its header suffix (_ft or _m); a bare header uses `fallback`. */
export function parseBoreholesCsv(text: string, fallback: Unit): ImportResult {
  const out: ImportResult = { rows: [], errors: [] };
  const rows = parseCsv(text);
  if (!rows.length) { out.errors.push({ line: 1, message: 'File is empty' }); return out; }
  const h = rows[0].map((x) => x.trim().toLowerCase());
  const find = (...names: string[]) => names.map((n) => h.indexOf(n)).find((i) => i >= 0) ?? -1;
  const lengthCol = (base: string): [number, Unit] => {
    for (const u of ['ft', 'm'] as const) { const i = h.indexOf(`${base}_${u}`); if (i >= 0) return [i, u]; }
    return [h.indexOf(base), fallback];
  };
  const iId = find('borehole_id', 'id');
  let [iElev, elevUnit] = lengthCol('reference_elevation');
  if (iElev < 0) iElev = h.indexOf('elevation');
  const [iTd, tdUnit] = lengthCol('total_depth');
  const iName = find('borehole_name', 'name');
  const iRp = find('reference_point');
  const iLoc = find('location');
  const iNotes = find('notes');
  const iLat = find('latitude', 'lat');
  const iLon = find('longitude', 'lon', 'lng');
  if (iId < 0 || iElev < 0) {
    out.errors.push({ line: 1, message: 'Header must include borehole_id and reference_elevation_ft (or _m)' });
    return out;
  }
  const seen = new Map<string, number>();
  rows.slice(1).forEach((r, k) => {
    const line = k + 2;
    const get = (i: number) => (i >= 0 && i < r.length ? unguard(r[i].trim()) : '');
    const id = get(iId);
    if (!id) return out.errors.push({ line, message: 'Missing borehole_id' });
    const elev = parseDecimal(get(iElev));
    if (!Number.isFinite(elev)) return out.errors.push({ line, message: `${id}: reference elevation "${get(iElev)}" is not a number` });
    let bad = false;
    const opt = (i: number, label: string, min: number, max: number): number | undefined => {
      const s = get(i);
      if (!s) return undefined;
      const n = parseDecimal(s);
      if (!Number.isFinite(n) || n < min || n > max) { out.errors.push({ line, message: `${id}: ${label} "${s}" is invalid` }); bad = true; }
      return n;
    };
    const row: BoreholePatch = { id, refElevationFt: fromUnit(elev, elevUnit) };
    if (iTd >= 0) { const td = opt(iTd, 'total depth', 0, Infinity); row.totalDepthFt = td == null ? undefined : fromUnit(td, tdUnit); }
    if (iLat >= 0) row.lat = opt(iLat, 'latitude', -90, 90);
    if (iLon >= 0) row.lon = opt(iLon, 'longitude', -180, 180);
    if (bad) return;
    if (iName >= 0) row.name = get(iName) || id;
    if (iRp >= 0) row.referencePoint = get(iRp) || 'top of casing';
    if (iLoc >= 0) row.location = get(iLoc) || undefined;
    if (iNotes >= 0) row.notes = get(iNotes) || undefined;
    if (seen.has(id)) out.errors.push({ line, message: `${id}: duplicate of line ${seen.get(id)}; last row wins` });
    seen.set(id, line);
    const prev = out.rows.findIndex((x) => x.id === id);
    if (prev >= 0) out.rows[prev] = row; else out.rows.push(row);
  });
  return out;
}

export const isStatus = (s: unknown): s is (typeof STATUSES)[number] => STATUSES.includes(s as never);

export function csvFilename(scope: string, date: string): string {
  const safe = scope.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'borehole';
  return `waterlevels_${safe}_${date}.csv`;
}
