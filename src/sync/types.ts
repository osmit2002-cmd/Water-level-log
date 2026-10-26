/** Wire format shared by every sync backend (Google Sheet today, OneDrive Excel later). Lengths in feet. */
export interface BoreholeRec {
  uid: string;
  name: string;
  referencePoint: string;
  refElevationFt: number;
  flag: string;
  /** Per-field edit times (ISO, client clock). Newest wins field by field. */
  nameAt: string;
  referencePointAt: string;
  refElevationAt: string;
  flagAt: string;
  createdAt: string;
  updatedAt: string;
}
export interface ReadingRec {
  uid: string;
  displayId: string;
  boreholeUid: string;
  boreholeName: string;
  datetime: string; // local "YYYY-MM-DDTHH:mm"
  userCode: string;
  seq: number;
  /** Snapshotted at save; never changed by sync. */
  referencePoint: string;
  refElevationFt: number;
  depthFt: number;
  notes: string;
  createdAt: string;
  updatedAt: string;
}
export interface TombRec {
  uid: string;
  kind: 'borehole' | 'reading';
  deletedAt: string;
  /** Borehole merged into another one with the same name (its readings moved there). */
  mergedInto?: string;
  /** Set by the server when the delete was undone (an edit newer than the delete, or readings the deleting phone had not seen). */
  restoredAt?: string;
}
export interface PushBatch { boreholes: BoreholeRec[]; readings: ReadingRec[]; tombstones: TombRec[] }
/** acked: keys "b:uid", "r:uid", "t:uid" the server has stored (or deliberately ignored). Unacked items stay queued. */
export interface ItemNote { key: string; reason: string }
export interface PushResult {
  acked: string[];
  /** Invalid items: never accepted as sent. Shown as "failed" with the reason; retry or discard. */
  rejected?: ItemNote[];
  /** Valid but not stored yet (e.g. its borehole is not on the sheet yet): stays waiting. */
  held?: ItemNote[];
}
export interface PullResult { cursor: number; boreholes: BoreholeRec[]; readings: ReadingRec[]; tombstones: TombRec[] }
export interface AdapterStatus { ok: boolean; message: string }

/**
 * A sync backend. push() must be idempotent (re-sending the same record is harmless);
 * pull(since) returns everything changed after the opaque server cursor `since` (0 = everything).
 */
export interface SyncAdapter {
  readonly kind: string;
  push(batch: PushBatch): Promise<PushResult>;
  pull(since: number): Promise<PullResult>;
  status(): Promise<AdapterStatus>;
}
