import { describe, expect, it } from 'vitest';
import { BOM, boreholesCsv, csvFilename, parseBoreholesCsv, parseCsv, quoteField, readingsCsv, readingsHeader, textCell } from './csv';
import { deriveReadings } from './math';
import { DEFAULT_SETTINGS, type Borehole, type Reading } from './types';

const bh: Borehole = { name: 'North, "old" well', referencePoint: 'top of casing', refElevationFt: 1050.5, createdAt: '', updatedAt: '' };
const rd = (id: number, datetime: string, depthFt: number, notes?: string): Reading =>
  ({ id, borehole: bh.name, datetime, depthFt, refElevationFt: 1050.5, referencePoint: 'top of casing', userCode: 'JD', notes, createdAt: '', updatedAt: '' });
const HEADER_FT = 'Reading ID,Borehole Name,Date,Time,User Code,Reference Point,Reference Elevation (ft),Depth to Top of Water (ft),Water Elevation (ft),Notes';

describe('escaping', () => {
  it('quotes per RFC 4180', () => {
    expect(quoteField('plain')).toBe('plain');
    expect(quoteField('a,b')).toBe('"a,b"');
    expect(quoteField('say "hi"')).toBe('"say ""hi"""');
    expect(quoteField('l1\nl2')).toBe('"l1\nl2"');
  });
  it('guards formula injection in text cells', () => {
    expect(textCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(textCell('+1')).toBe("'+1");
    expect(textCell('-cmd')).toBe("'-cmd");
    expect(textCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(textCell(undefined)).toBe('');
  });
});

describe('parsing', () => {
  it('round-trips quoted fields, BOM and CRLF', () => {
    const rows = parseCsv(BOM + 'a,b,c\r\n"x,1","he said ""no""","multi\nline"\r\n\r\n');
    expect(rows).toEqual([['a', 'b', 'c'], ['x,1', 'he said "no"', 'multi\nline']]);
    expect(parseCsv('a,,\nb')).toEqual([['a', '', ''], ['b']]);
  });
});

describe('readings CSV', () => {
  const rs = deriveReadings([rd(1, '2026-01-01T08:00', 20.1), rd(3, '2026-01-03T10:30', 19.6, '=evil'), rd(2, '2026-01-02T09:05', 21, 'a,"b"')]);
  it('has BOM, the 10 columns in order with readable headers, CRLF and 2 dp numbers', () => {
    const csv = readingsCsv(rs, 'ft', DEFAULT_SETTINGS.columns);
    expect(csv.startsWith(BOM)).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(HEADER_FT);
    expect(lines[1]).toBe('1,"North, ""old"" well",2026-01-01,08:00,JD,top of casing,1050.50,20.10,1030.40,');
    expect(lines[2]).toBe('2,"North, ""old"" well",2026-01-02,09:05,JD,top of casing,1050.50,21.00,1029.50,"a,""b"""');
    expect(lines[3]).toBe('3,"North, ""old"" well",2026-01-03,10:30,JD,top of casing,1050.50,19.60,1030.90,\'=evil');
    const parsed = parseCsv(csv);
    expect(parsed).toHaveLength(4);
    expect(parsed.every((r) => r.length === 10)).toBe(true);
  });
  it('uses (m) headers and converts in meters', () => {
    expect(readingsHeader('m', DEFAULT_SETTINGS.columns)).toEqual(['Reading ID', 'Borehole Name', 'Date', 'Time', 'User Code', 'Reference Point', 'Reference Elevation (m)', 'Depth to Top of Water (m)', 'Water Elevation (m)', 'Notes']);
    const row = parseCsv(readingsCsv(rs.slice(0, 1), 'm', DEFAULT_SETTINGS.columns))[1];
    expect(row[6]).toBe('320.19');
    expect(row[7]).toBe('6.13');
  });
  it('includes only the columns switched on, keeping the fixed order', () => {
    const cols = { ...DEFAULT_SETTINGS.columns, boreholeName: false, time: false, userCode: false, referencePoint: false, notes: false };
    const p = parseCsv(readingsCsv(rs, 'ft', cols));
    expect(p[0]).toEqual(['Reading ID', 'Date', 'Reference Elevation (ft)', 'Depth to Top of Water (ft)', 'Water Elevation (ft)']);
    expect(p[1]).toEqual(['1', '2026-01-01', '1050.50', '20.10', '1030.40']);
    const one = parseCsv(readingsCsv(rs, 'ft', { ...Object.fromEntries(Object.keys(DEFAULT_SETTINGS.columns).map((k) => [k, false])), waterElevation: true } as typeof DEFAULT_SETTINGS.columns));
    expect(one[0]).toEqual(['Water Elevation (ft)']);
  });
  it('keeps negative numbers numeric (not formula-guarded)', () => {
    const d = deriveReadings([{ ...rd(1, '2026-01-01T08:00', 10), refElevationFt: -5 }]);
    expect(parseCsv(readingsCsv(d, 'ft', DEFAULT_SETTINGS.columns))[1][8]).toBe('-15.00');
  });
  it('puts User Code right after Time, formula-guarded, blank for old readings, with its own switch', () => {
    const d = deriveReadings([rd(1, '2026-01-01T08:00', 1), { ...rd(2, '2026-01-01T09:00', 1), userCode: '' }, { ...rd(3, '2026-01-01T10:00', 1), userCode: '-X' }]);
    const p = parseCsv(readingsCsv(d, 'ft', DEFAULT_SETTINGS.columns));
    expect(p[0].slice(3, 5)).toEqual(['Time', 'User Code']);
    expect(p.slice(1).map((r) => r[4])).toEqual(['JD', '', "'-X"]);
    expect(parseCsv(readingsCsv(d, 'ft', { ...DEFAULT_SETTINGS.columns, userCode: false }))[0]).not.toContain('User Code');
  });
  it('builds safe filenames', () => {
    expect(csvFilename('all', '2026-10-26')).toBe('waterlevels_all_2026-10-26.csv');
    expect(csvFilename('MW 1/a', '2026-10-26')).toBe('waterlevels_MW-1-a_2026-10-26.csv');
  });
});

describe('boreholes CSV', () => {
  it('exports the 3 columns plus Scope and round-trips', () => {
    const csv = boreholesCsv([{ ...bh, referencePoint: '-collar' }], 'ft');
    expect(csv.slice(1).split('\r\n')[0]).toBe('Borehole Name,Reference Point,Reference Elevation (ft),Scope');
    const res = parseBoreholesCsv(csv, 'ft');
    expect(res.errors).toEqual([]);
    expect(res.rows[0]).toEqual({ name: 'North, "old" well', referencePoint: '-collar', refElevationFt: 1050.5 });
  });
  it('reads meters and snake_case headers, reports bad rows, last duplicate (case-insensitive) wins', () => {
    const res = parseBoreholesCsv('borehole_name,reference_elevation_m\nA,100\n,5\nB,abc\na,200\n', 'ft');
    expect(res.rows.map((r) => r.name)).toEqual(['a']);
    expect(res.rows[0].refElevationFt).toBeCloseTo(200 / 0.3048, 8);
    expect(res.rows[0].referencePoint).toBeUndefined();
    expect(res.errors.map((e) => e.line)).toEqual([3, 4, 5]);
  });
  it('rejects a file without the required header', () => {
    expect(parseBoreholesCsv('borehole_id,foo\nx,1', 'ft').errors[0].message).toMatch(/Borehole Name/);
  });
});
