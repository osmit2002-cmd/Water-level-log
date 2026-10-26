import { describe, expect, it } from 'vitest';
import { BOM, boreholesCsv, csvFilename, parseBoreholesCsv, parseCsv, quoteField, readingsCsv, readingsHeader, textCell } from './csv';
import { deriveReadings } from './math';
import type { Borehole, Reading } from './types';

const bh: Borehole = { id: 'MW-1', name: 'North, "old" well', referencePoint: 'top of casing', refElevationFt: 1050.5, totalDepthFt: 80, lat: 37.1234567, lon: -87.5, createdAt: '', updatedAt: '' };
const rd = (uid: string, datetime: string, depthFt: number | undefined, status: Reading['status'] = 'ok', notes?: string): Reading =>
  ({ uid, boreholeId: 'MW-1', datetime, status, depthFt, refElevationFt: 1050.5, referencePoint: 'top of casing', notes, reader: 'Odin', createdAt: uid, updatedAt: '' });

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
  const rs = deriveReadings([rd('1', '2026-01-01T08:00', 20.1), rd('2', '2026-01-02T09:05', undefined, 'dry'), rd('3', '2026-01-03T10:30', 19.6, 'ok', '=evil')]);
  it('has BOM, ordered unit headers, CRLF and 2 dp numbers', () => {
    const csv = readingsCsv(rs, new Map([[bh.id, bh]]), 'ft');
    expect(csv.startsWith(BOM)).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('borehole_id,reference_point,reference_elevation_ft,date,time,depth_to_water_ft,water_elevation_ft,change_from_previous_ft,total_depth_ft,notes,status,borehole_name,reader,latitude,longitude');
    expect(lines[1]).toBe('MW-1,top of casing,1050.50,2026-01-01,08:00,20.10,1030.40,,80.00,,ok,"North, ""old"" well",Odin,37.1234567,-87.5');
    expect(lines[2]).toBe('MW-1,top of casing,1050.50,2026-01-02,09:05,,,,80.00,,dry,"North, ""old"" well",Odin,37.1234567,-87.5');
    expect(lines[3]).toContain(',19.60,1030.90,0.50,80.00,\'=evil,ok,');
    const parsed = parseCsv(csv);
    expect(parsed).toHaveLength(4);
    expect(parsed[1]).toHaveLength(15);
  });
  it('uses _m headers and converts in meters', () => {
    expect(readingsHeader('m')[2]).toBe('reference_elevation_m');
    const csv = readingsCsv(rs.slice(0, 1), new Map([[bh.id, bh]]), 'm');
    expect(parseCsv(csv)[1][2]).toBe('320.19');
    expect(parseCsv(csv)[1][5]).toBe('6.13');
  });
  it('keeps negative change numeric (not formula-guarded)', () => {
    const d = deriveReadings([rd('1', '2026-01-01T08:00', 10), rd('2', '2026-01-02T08:00', 12)]);
    expect(parseCsv(readingsCsv(d, new Map([[bh.id, bh]]), 'ft'))[2][7]).toBe('-2.00');
  });
  it('builds safe filenames', () => {
    expect(csvFilename('all', '2026-10-26')).toBe('waterlevels_all_2026-10-26.csv');
    expect(csvFilename('MW 1/a', '2026-10-26')).toBe('waterlevels_MW-1-a_2026-10-26.csv');
  });
});

describe('boreholes CSV import', () => {
  it('round-trips an export', () => {
    const res = parseBoreholesCsv(boreholesCsv([{ ...bh, notes: '-deep' }], 'ft'), 'ft');
    expect(res.errors).toEqual([]);
    expect(res.rows[0]).toMatchObject({ id: 'MW-1', name: 'North, "old" well', refElevationFt: 1050.5, totalDepthFt: 80, notes: '-deep', lat: 37.1234567 });
  });
  it('reads meters, reports bad rows, last duplicate wins', () => {
    const text = 'borehole_id,reference_elevation_m,latitude\nA,100,\n,5,\nB,abc,\nC,10,95\nA,200,1\n';
    const res = parseBoreholesCsv(text, 'ft');
    expect(res.rows.map((r) => r.id)).toEqual(['A']);
    expect(res.rows[0].refElevationFt).toBeCloseTo(200 / 0.3048, 8);
    expect(res.errors.map((e) => e.line)).toEqual([3, 4, 5, 6]);
  });
  it('rejects a file without the required header', () => {
    expect(parseBoreholesCsv('name,foo\nx,1', 'ft').errors[0].message).toMatch(/borehole_id/);
  });
});

describe('boreholes CSV import (review fixes)', () => {
  it('only sets columns present in the file', () => {
    const res = parseBoreholesCsv('borehole_id,reference_elevation_ft\nMW-1,1060\n', 'ft');
    expect(res.rows[0]).toEqual({ id: 'MW-1', refElevationFt: 1060 });
  });
  it('converts each length column by its own unit suffix', () => {
    const res = parseBoreholesCsv('borehole_id,reference_elevation_m,total_depth_ft\nA,100,80\n', 'ft');
    expect(res.rows[0].totalDepthFt).toBe(80);
    expect(res.rows[0].refElevationFt).toBeCloseTo(328.084, 3);
  });
});
