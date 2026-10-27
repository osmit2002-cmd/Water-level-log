import { describe, expect, it } from 'vitest';
import { activeQuick, addDays, dayTicks, niceTicks, quickRange, tOf, toSeries, xSpan } from './chart';
import { deriveReadings } from './math';
import type { Reading } from './types';

const rd = (id: number, borehole: string, datetime: string, depthFt: number, refElevationFt = 100): Reading =>
  ({ id, borehole, datetime, depthFt, refElevationFt, referencePoint: 'toc', userCode: 'OD', createdAt: '', updatedAt: '' });

describe('chart range math', () => {
  it('last N days counts today: 7 days ending Oct 27 starts Oct 21', () => {
    expect(quickRange(7, '2026-10-27')).toEqual({ from: '2026-10-21', to: '2026-10-27' });
    expect(quickRange(28, '2026-10-27').from).toBe('2026-09-30');
    expect(quickRange(180, '2026-10-27').from).toBe('2026-05-01');
    expect(quickRange(365, '2026-10-27').from).toBe('2025-10-28');
  });
  it('crosses month, year and leap-day edges, and DST does not matter', () => {
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(quickRange(7, '2026-11-03').from).toBe('2026-10-28'); // US DST ends Nov 1
    expect(quickRange(365, '2024-12-31').from).toBe('2024-01-02'); // leap year: 366 days
  });
  it('a quick button lights up only when From/To match it exactly', () => {
    expect(activeQuick('2026-10-21', '2026-10-27', '2026-10-27')).toBe(7);
    expect(activeQuick('2026-10-21', '2026-10-26', '2026-10-27')).toBeNull();
    expect(activeQuick('', '', '2026-10-27')).toBeNull();
    expect(activeQuick('2026-10-21', '2026-10-27', '2026-10-28')).toBeNull(); // a new day: yesterday's range is custom now
  });
  it('the x axis covers the whole chosen days (From 00:00 to the end of To)', () => {
    const s = toSeries(deriveReadings([rd(1, 'MW-1', '2026-10-25T09:00', 10)]), 'elevation');
    const [t0, t1] = xSpan(s, '2026-10-21', '2026-10-27')!;
    expect(t0).toBe(tOf('2026-10-21'));
    expect(t1).toBe(tOf('2026-10-27T23:59'));
    // no dates chosen: first..last reading; a single reading gets a day around it
    const [a, b] = xSpan(s, '', '')!;
    expect(b - a).toBe(86_400_000);
  });
  it('one series per borehole, in time order, natural name order; values are water elevation or depth', () => {
    const rows = deriveReadings([rd(1, 'MW-10', '2026-10-02T08:00', 5), rd(2, 'MW-2', '2026-10-03T08:00', 7, 50), rd(3, 'MW-2', '2026-10-01T08:00', 6, 50)]);
    const e = toSeries(rows, 'elevation');
    expect(e.map((s) => s.borehole)).toEqual(['MW-2', 'MW-10']);
    expect(e[0].pts.map((p) => p.v)).toEqual([44, 43]);
    expect(toSeries(rows, 'depth', (ft) => ft * 0.3048)[1].pts[0].v).toBeCloseTo(1.524);
  });
  it('y ticks are round numbers that cover the data', () => {
    const t = niceTicks(87.3, 91.9);
    expect(t[0]).toBeLessThanOrEqual(87.3);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(91.9);
    expect(t.length).toBeGreaterThanOrEqual(3);
    expect(t.length).toBeLessThanOrEqual(7);
    expect(t.every((v) => Number.isInteger(v * 4))).toBe(true);
    expect(niceTicks(5, 5).length).toBeGreaterThanOrEqual(2);
    expect(dayTicks(0, 300, 4)).toEqual([0, 100, 200, 300]);
  });
});
