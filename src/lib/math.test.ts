import { describe, expect, it } from 'vitest';
import { deriveReadings, fmt2, fromUnit, inDateRange, latestPerBorehole, nowLocal, parseDecimal, round2, toUnit, waterElevationFt } from './math';
import type { Reading } from './types';

let n = 0;
const R = (borehole: string, datetime: string, depthFt: number, refElevationFt = 100): Reading =>
  ({ id: ++n, borehole, datetime, depthFt, refElevationFt, referencePoint: 'top of casing', userCode: '', createdAt: '', updatedAt: '' });

describe('rounding and units', () => {
  it('rounds to 2 dp without float artefacts', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(fmt2(1012.3 - 10.1)).toBe('1002.20');
    expect(round2(-0.001)).toBe(0);
    expect(Object.is(round2(-0.004), -0)).toBe(false);
    expect(fmt2(undefined)).toBe('');
  });
  it('converts feet and meters', () => {
    expect(round2(toUnit(10, 'm'))).toBe(3.05);
    expect(fromUnit(3.048, 'm')).toBeCloseTo(10, 10);
    expect(toUnit(12.34, 'ft')).toBe(12.34);
  });
  it('parses decimals', () => {
    expect(parseDecimal('12.5')).toBe(12.5);
    expect(parseDecimal(' 7,25 ')).toBe(7.25);
    expect(parseDecimal('1,050')).toBeNaN();
    expect(parseDecimal('1,050.5')).toBeNaN();
    expect(parseDecimal('.5')).toBe(0.5);
    expect(parseDecimal('1e3')).toBeNaN();
    expect(parseDecimal('')).toBeNaN();
    expect(parseDecimal('abc')).toBeNaN();
  });
});

describe('elevation', () => {
  it('water elevation = reference elevation - depth to top of water', () => {
    expect(waterElevationFt({ depthFt: 12.25, refElevationFt: 1050.5 })).toBe(1038.25);
    expect(fmt2(waterElevationFt({ depthFt: 10.1, refElevationFt: 1012.3 }))).toBe('1002.20');
  });
  it('orders by date/time, then Reading ID, and uses each reading’s reference snapshot', () => {
    const a = R('A', '2026-03-01T08:00', 20), b = R('A', '2026-01-01T08:00', 25, 101.5), c = R('A', '2026-03-01T08:00', 21);
    const d = deriveReadings([c, a, b]);
    expect(d.map((x) => x.id)).toEqual([b.id, a.id, c.id]);
    expect(d[0].waterElevFt).toBe(76.5);
    expect(latestPerBorehole(d).get('A')!.id).toBe(c.id);
  });
  it('keeps boreholes independent', () => {
    const d = deriveReadings([R('A', '2026-01-01T08:00', 10), R('B', '2026-01-02T08:00', 50)]);
    expect(latestPerBorehole(d).get('A')!.waterElevFt).toBe(90);
    expect(latestPerBorehole(d).get('B')!.waterElevFt).toBe(50);
  });
  it('stamps the phone clock as local YYYY-MM-DDTHH:mm', () => {
    expect(nowLocal(new Date(2026, 9, 5, 7, 3, 59))).toBe('2026-10-05T07:03');
  });
  it('filters by inclusive date range', () => {
    expect(inDateRange('2026-01-05T23:59', '2026-01-05', '2026-01-05')).toBe(true);
    expect(inDateRange('2026-01-06T00:00', undefined, '2026-01-05')).toBe(false);
    expect(inDateRange('2026-01-04T10:00', '2026-01-05')).toBe(false);
  });
});
