import { getCursor, outboxAck, outboxAll } from '../lib/db';
import type { BoreholeRec, ReadingRec, TombRec } from './types';
import type { SyncAdapter } from './types';
import { applyPull } from './apply';

export interface SyncRun { pushed: number; acked: number; pulled: number; changed: number }

/** Max items per push request (keeps Apps Script requests small). */
export const PUSH_CHUNK = 200;

/**
 * One sync: push the outbox (tombstones, then boreholes, then readings), drop only what the server acknowledged,
 * then pull everything after our cursor and merge it in. Safe to repeat at any point: pushes are idempotent upserts.
 */
export async function syncOnce(adapter: SyncAdapter): Promise<SyncRun> {
  const items = await outboxAll();
  const rank = { tombstone: 0, borehole: 1, reading: 2 } as const;
  items.sort((a, b) => rank[a.kind] - rank[b.kind]);
  let acked = 0;
  for (let i = 0; i < items.length; i += PUSH_CHUNK) {
    const chunk = items.slice(i, i + PUSH_CHUNK);
    const res = await adapter.push({
      tombstones: chunk.filter((x) => x.kind === 'tombstone').map((x) => x.rec as TombRec),
      boreholes: chunk.filter((x) => x.kind === 'borehole').map((x) => x.rec as BoreholeRec),
      readings: chunk.filter((x) => x.kind === 'reading').map((x) => x.rec as ReadingRec)
    });
    await outboxAck(chunk, res.acked);
    acked += res.acked.length;
  }
  const p = await adapter.pull(await getCursor());
  const { changed } = await applyPull(p);
  return { pushed: items.length, acked, pulled: p.boreholes.length + p.readings.length + p.tombstones.length, changed };
}
