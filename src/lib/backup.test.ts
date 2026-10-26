import { describe, expect, it } from 'vitest';
import { makeBackup, validateBackup } from './backup';

const b = { id: 'A', name: 'A', referencePoint: 'collar', refElevationFt: 10, createdAt: 'x', updatedAt: 'x' };
const r = { uid: '1', boreholeId: 'A', datetime: '2026-01-01T08:00', status: 'ok' as const, depthFt: 2, refElevationFt: 10, referencePoint: 'collar', createdAt: 'x', updatedAt: 'x' };

describe('backup', () => {
  it('round-trips', () => {
    const bk = JSON.parse(JSON.stringify(makeBackup([b], [r], { unit: 'm', theme: 'dark' }, 't')));
    const v = validateBackup(bk);
    expect(v.boreholes).toHaveLength(1);
    expect(v.settings.unit).toBe('m');
  });
  it('rejects bad files', () => {
    expect(() => validateBackup({})).toThrow(/Not a Water Level Log/);
    const ok = makeBackup([b], [r], { unit: 'ft', theme: 'auto' }, 't');
    expect(() => validateBackup({ ...ok, version: 99 })).toThrow(/newer/);
    expect(() => validateBackup({ ...ok, readings: [{ ...r, boreholeId: 'Z' }] })).toThrow(/unknown borehole/);
    expect(() => validateBackup({ ...ok, readings: [{ ...r, depthFt: -1 }] })).toThrow(/bad depth/);
    expect(() => validateBackup({ ...ok, readings: [r, r] })).toThrow(/duplicate/);
  });
  it('drops depth from dry readings', () => {
    const ok = makeBackup([b], [{ ...r, status: 'dry', depthFt: 5 }], { unit: 'ft', theme: 'auto' }, 't');
    expect(validateBackup(ok).readings[0].depthFt).toBeUndefined();
  });
});
