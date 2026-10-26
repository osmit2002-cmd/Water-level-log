export type Unit = 'ft' | 'm';
export type ReadingStatus = 'ok' | 'dry' | 'no_reading';
export const STATUSES: ReadingStatus[] = ['ok', 'dry', 'no_reading'];
export const STATUS_LABEL: Record<ReadingStatus, string> = { ok: 'OK', dry: 'Dry', no_reading: 'No reading' };

/** All lengths are stored in feet. */
export interface Borehole {
  id: string; // user-facing ID, primary key, immutable after creation
  name: string;
  referencePoint: string; // e.g. "top of casing", "collar"
  refElevationFt: number;
  totalDepthFt?: number;
  location?: string;
  notes?: string;
  lat?: number;
  lon?: number;
  createdAt: string;
  updatedAt: string;
}

export interface Reading {
  uid: string;
  boreholeId: string;
  datetime: string; // local ISO "YYYY-MM-DDTHH:mm"
  status: ReadingStatus;
  depthFt?: number; // only when status === 'ok'
  refElevationFt: number; // snapshot at time of reading
  referencePoint: string; // snapshot
  reader?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Settings {
  unit: Unit;
  theme: 'auto' | 'light' | 'dark';
}
export const DEFAULT_SETTINGS: Settings = { unit: 'ft', theme: 'auto' };
