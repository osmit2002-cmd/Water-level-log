import { adoptRemoteIds, queueEverything, resetCursor } from '../lib/db';
import type { SyncAdapter } from './types';

/**
 * Turning sync on (fix #8): read everything on the sheet first and give matching local records the sheet's ids
 * (natural keys; see adoptRemoteIds), so data restored from an old backup is not uploaded a second time.
 * Then queue all local data and reset the cursor so the first sync pulls everything.
 */
export async function prepareEnable(adapter: SyncAdapter) {
  const p = await adapter.pull(0);
  const matched = await adoptRemoteIds(p);
  await queueEverything();
  await resetCursor();
  return matched;
}
