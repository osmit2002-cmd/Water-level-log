import { describe, expect, it } from 'vitest';
import { changeLabel, deriveReadings, fmt2, fmtChange, fromUnit, inDateRange, latestPerBorehole, parseDecimal, previewChange, round2, toUnit, waterElevationFt } from './math';
import type { Reading } from './types';

let n = 0;
const R = (boreholeId: string, datetime: string, depthFt: number | undefined, refElevationFt = 100, status: Reading['status'] = 'ok'): Reading =>
  ({ uid: `u${++n}`, boreholeId, datetime, status, depthFt, refElevationFt, referencePoint: 'top of casing', createdAt: `c${String(n).padStart(4, '0')}`, updatedAt: '' });

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
    expect(parseDecimal('.5')).toBe(0.5);
    expect(parseDecimal('1e3')).toBeNaN();
    expect(parseDecimal('')).toBeNaN();
    expect(parseDecimal('abc')).toBeNaN();
  });
  it('formats change and labels', () => {
    expect(fmtChange(1.234, 'ft')).toBe('+1.23');
    expect(fmtChange(-0.5, 'ft')).toBe('-0.50');
    expect(fmtChange(-0.001, 'ft')).toBe('0.00');
    expect(changeLabel(0.2)).toBe('rise');
    expect(changeLabel(-0.2)).toBe('fall');
    expect(changeLabel(0.004)).toBe('no change');
  });
});

describe('elevation and change', () => {
  it('water elevation = reference - depth; none for dry/no reading', () => {
    expect(waterElevationFt({ status: 'ok', depthFt: 12.25, refElevationFt: 1050.5 })).toBe(1038.25);
    expect(waterElevationFt({ status: 'dry', depthFt: undefined, refElevationFt: 100 })).toBeUndefined();
  });
  it('computes change chronologically even when inserted out of order', () => {
    const rs = [R('A', '2026-03-01T08:00', 20), R('A', '2026-01-01T08:00', 25), R('A', '2026-02-01T08:00', 22)];
    const d = deriveReadings(rs);
    expect(d.map((x) => x.datetime.slice(5, 7))).toEqual(['01', '02', '03']);
    expect(d[0].changeFt).toBeUndefined();
    expect(round2(d[1].changeFt!)).toBe(3); // rise
    expect(round2(d[2].changeFt!)).toBe(2);
  });
  it('skips dry/no reading when computing change', () => {
    const d = deriveReadings([R('A', '2026-01-01T08:00', 10), R('A', '2026-01-02T08:00', undefined, 100, 'dry'), R('A', '2026-01-03T08:00', undefined, 100, 'no_reading'), R('A', '2026-01-04T08:00', 12)]);
    expect(d[1].changeFt).toBeUndefined();
    expect(d[1].waterElevFt).toBeUndefined();
    expect(round2(d[3].changeFt!)).toBe(-2);
  });
  it('uses each reading’s own reference elevation snapshot', () => {
    const d = deriveReadings([R('A', '2026-01-01T08:00', 10, 100), R('A', '2026-01-02T08:00', 10, 101.5)]);
    expect(round2(d[1].changeFt!)).toBe(1.5);
  });
  it('keeps boreholes independent and recomputes after delete', () => {
    const a1 = R('A', '2026-01-01T08:00', 10), b1 = R('B', '2026-01-01T09:00', 50), a2 = R('A', '2026-01-02T08:00', 11), a3 = R('A', '2026-01-03T08:00', 15);
    let d = deriveReadings([a1, b1, a2, a3]);
    expect(d.find((x) => x.uid === b1.uid)!.changeFt).toBeUndefined();
    expect(round2(d.find((x) => x.uid === a3.uid)!.changeFt!)).toBe(-4);
    d = deriveReadings([a1, b1, a3]);
    expect(round2(d.find((x) => x.uid === a3.uid)!.changeFt!)).toBe(-5);
    expect(latestPerBorehole(d).get('A')!.uid).toBe(a3.uid);
  });
  it('previews the change of an edited reading against its neighbours, not itself', () => {
    const a1 = R('A', '2026-01-01T08:00', 10), a2 = R('A', '2026-01-02T08:00', 11);
    expect(round2(previewChange([a1, a2], { ...a2, depthFt: 30 })!)).toBe(-20);
    expect(previewChange([a1, a2], { ...a2, datetime: '2025-12-31T08:00' })).toBeUndefined();
    expect(round2(previewChange([a1, a2], { ...R('A', '2026-01-05T08:00', 9), uid: '__new__', createdAt: '9999' })!)).toBe(2);
  });
  it('filters by inclusive date range', () => {
    expect(inDateRange('2026-01-05T23:59', '2026-01-05', '2026-01-05')).toBe(true);
    expect(inDateRange('2026-01-06T00:00', undefined, '2026-01-05')).toBe(false);
    expect(inDateRange('2026-01-04T10:00', '2026-01-05')).toBe(false);
  });
});
