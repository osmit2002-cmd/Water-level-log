import { describe, expect, it } from 'vitest';
import { mergeBorehole, mergeReading } from './merge';
import { displayId, uuid } from '../lib/ids';
import type { BoreholeRec, ReadingRec } from './types';

const T1 = '2026-10-26T10:00:00.000Z', T2 = '2026-10-26T11:00:00.000Z', T3 = '2026-10-26T12:00:00.000Z';
const bh = (o: Partial<BoreholeRec> = {}): BoreholeRec => ({ uid: 'b1', name: 'MW-1', referencePoint: 'top of casing', refElevationFt: 100, flag: '',
  nameAt: T1, referencePointAt: T1, refElevationAt: T1, flagAt: T1, createdAt: T1, updatedAt: T1, ...o });
const rd = (o: Partial<ReadingRec> = {}): ReadingRec => ({ uid: 'r1', displayId: 'OD-0001', boreholeUid: 'b1', boreholeName: 'MW-1', datetime: '2026-10-26T09:15', userCode: 'OD',
  seq: 1, referencePoint: 'top of casing', refElevationFt: 100, depthFt: 10, notes: '', createdAt: T1, updatedAt: T1, ...o });

describe('borehole merge: newest edit wins, field by field', () => {
  it('keeps different fields edited on two phones', () => {
    const a = bh({ name: 'MW-1A', nameAt: T2, updatedAt: T2 });
    const b = bh({ refElevationFt: 101.5, refElevationAt: T3, updatedAt: T3 });
    const m = mergeBorehole(a, b);
    expect(m.name).toBe('MW-1A');
    expect(m.refElevationFt).toBe(101.5);
    expect(m.updatedAt).toBe(T3);
    expect(mergeBorehole(b, a)).toEqual(m); // order does not matter
  });
  it('same field: the later timestamp wins; equal timestamps break ties by value on every phone', () => {
    expect(mergeBorehole(bh({ referencePoint: 'collar', referencePointAt: T3 }), bh({ referencePoint: 'flange', referencePointAt: T2 })).referencePoint).toBe('collar');
    const x = bh({ referencePoint: 'collar', referencePointAt: T2 }), y = bh({ referencePoint: 'flange', referencePointAt: T2 });
    expect(mergeBorehole(x, y).referencePoint).toBe(mergeBorehole(y, x).referencePoint);
  });
  it('is idempotent', () => { const a = bh({ name: 'Z', nameAt: T2 }); expect(mergeBorehole(a, a)).toEqual(a); });
});

describe('reading merge', () => {
  it('newer edit wins for depth and notes; reference values, date/time, code and number never change', () => {
    const local = rd();
    const inc = rd({ depthFt: 12, notes: 'pump on', updatedAt: T2, refElevationFt: 999, referencePoint: 'x', datetime: '2027-01-01T00:00', userCode: 'ZZ', seq: 9 });
    const m = mergeReading(local, inc);
    expect([m.depthFt, m.notes, m.updatedAt]).toEqual([12, 'pump on', T2]);
    expect([m.refElevationFt, m.referencePoint, m.datetime, m.userCode, m.seq]).toEqual([100, 'top of casing', '2026-10-26T09:15', 'OD', 1]);
  });
  it('older incoming edit is ignored, but a moved borehole link is taken', () => {
    const m = mergeReading(rd({ depthFt: 11, updatedAt: T3 }), rd({ depthFt: 12, updatedAt: T2, boreholeUid: 'b2', boreholeName: 'MW-2' }));
    expect(m.depthFt).toBe(11);
    expect(m.boreholeUid).toBe('b2');
  });
});

describe('IDs', () => {
  it('formats USERCODE-0001 with a per-phone number', () => {
    expect(displayId({ userCode: 'OD-1', seq: 1, id: 7 })).toBe('OD-1-0001');
    expect(displayId({ userCode: 'JD', seq: 12345, id: 1 })).toBe('JD-12345');
  });
  it('legacy readings keep their number; no User Code => LEGACY-', () => {
    expect(displayId({ userCode: '', seq: undefined, id: 3 })).toBe('LEGACY-0003');
    expect(displayId({ userCode: 'OD', seq: undefined, id: 42 })).toBe('OD-0042');
  });
  it('uuid is v4 and unique', () => {
    const a = uuid(), b = uuid();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});
