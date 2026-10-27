import type { BoreholeRec, ReadingRec } from './types';

const FIELDS = [['name', 'nameAt'], ['referencePoint', 'referencePointAt'], ['refElevationFt', 'refElevationAt'], ['flag', 'flagAt']] as const;

/**
 * Field-by-field last-writer-wins for boreholes. Each field keeps the value with the newest edit time
 * (client clocks; ties broken by comparing values so every phone and the server pick the same winner).
 */
export function mergeBorehole(a: BoreholeRec, b: BoreholeRec): BoreholeRec {
  const out = { ...a };
  for (const [f, at] of FIELDS) {
    const ta = a[at] || '', tb = b[at] || '';
    const takeB = tb > ta || (tb === ta && String(b[f]) > String(a[f]));
    if (takeB) (out as Record<string, unknown>)[f] = b[f], (out as Record<string, unknown>)[at] = tb;
  }
  out.createdAt = a.createdAt < b.createdAt ? a.createdAt || b.createdAt : b.createdAt || a.createdAt;
  out.updatedAt = a.updatedAt > b.updatedAt ? a.updatedAt : b.updatedAt;
  return out;
}

/**
 * Readings: the newer edit (updatedAt) wins for depth and notes. 0.6.0: date/time, reference point/elevation, User Code and the
 * Reading ID number always come from the sheet (phones never change them; Odin can fix them there).
 * The borehole link follows the incoming record (a server-side merge can move readings).
 */
export function mergeReading(local: ReadingRec, inc: ReadingRec): ReadingRec {
  const newer = inc.updatedAt > local.updatedAt;
  return {
    ...local,
    boreholeUid: inc.boreholeUid, boreholeName: inc.boreholeName,
    // 0.6.0: the sheet is the authority for these (a hand fix in the sheet reaches every phone).
    datetime: inc.datetime, referencePoint: inc.referencePoint, refElevationFt: inc.refElevationFt, userCode: inc.userCode, num: inc.num ?? local.num,
    depthFt: newer ? inc.depthFt : local.depthFt,
    notes: newer ? inc.notes : local.notes,
    updatedAt: newer ? inc.updatedAt : local.updatedAt
  };
}

export const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
export const mergeFlag = (at: string) => `Same Borehole Name was created on two phones; records merged ${at.slice(0, 10)}. Check the reference values.`;
