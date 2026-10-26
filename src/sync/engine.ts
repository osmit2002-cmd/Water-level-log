import { getCursor, outboxAck, outboxAll, outboxFail, outboxLinkFailures } from '../lib/db';
import type { BoreholeRec, ItemNote, ReadingRec, TombRec } from './types';
import type { SyncAdapter } from './types';
import { applyPull } from './apply';

export interface SyncRun { pushed: number; acked: number; pulled: number; changed: number; rejected: ItemNote[]; held: ItemNote[] }

/** Max items per push request. Code.gs refuses more than 250, so one request stays far below the 6-minute limit. */
export const PUSH_CHUNK = 100;
/** A pull can queue changes (e.g. a borehole kept because of local readings); push those in the same sync. */
const MAX_ROUNDS = 3;

/**
 * One sync: push the outbox (reading deletes, borehole deletes, boreholes, readings) in chunks, drop only what the server
 * acknowledged, mark what it rejected as failed (kept, never dropped), then pull and merge. Items marked failed are not
 * resent until the user taps Retry. Safe to repeat at any point: every push is an idempotent upsert keyed by uid.
 */
export async function syncOnce(adapter: SyncAdapter): Promise<SyncRun> {
  const run: SyncRun = { pushed: 0, acked: 0, pulled: 0, changed: 0, rejected: [], held: [] };
  const syncId = `${Date.now()}-${Math.random()}`;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    await outboxLinkFailures();
    const items = (await outboxAll()).filter((x) => !x.failed);
    const rank = (x: (typeof items)[number]) => (x.kind === 'tombstone' ? ((x.rec as TombRec).kind === 'reading' ? 0 : 1) : x.kind === 'borehole' ? 2 : 3);
    items.sort((a, b) => rank(a) - rank(b));
    for (let i = 0; i < items.length; i += PUSH_CHUNK) {
      const chunk = items.slice(i, i + PUSH_CHUNK);
      const res = await adapter.push({
        tombstones: chunk.filter((x) => x.kind === 'tombstone').map((x) => x.rec as TombRec),
        boreholes: chunk.filter((x) => x.kind === 'borehole').map((x) => x.rec as BoreholeRec),
        readings: chunk.filter((x) => x.kind === 'reading').map((x) => x.rec as ReadingRec)
      });
      await outboxAck(chunk, res.acked);
      if (res.rejected?.length) { await outboxFail(chunk, res.rejected); await outboxLinkFailures(); }
      run.acked += res.acked.length;
      run.rejected.push(...(res.rejected ?? []));
      run.held.push(...(res.held ?? []));
    }
    run.pushed += items.length;
    const p = await adapter.pull(await getCursor());
    const { changed, queued } = await applyPull(p, syncId);
    run.pulled += p.boreholes.length + p.readings.length + p.tombstones.length;
    run.changed += changed;
    if (!queued) break;
  }
  // Report only what is still waiting after the last round, once per item.
  const left = new Set((await outboxAll()).filter((x) => !x.failed).map((x) => x.key));
  run.held = [...new Map(run.held.filter((h) => left.has(h.key)).map((h) => [h.key, h])).values()];
  return run;
}
