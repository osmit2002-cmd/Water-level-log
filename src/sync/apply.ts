import { _putBorehole, _queue, _rw, _tombstone, CURSOR, findName, fromBRec, toBRec, toRRec, type Tx } from '../lib/db';
import type { Borehole, Reading } from '../lib/types';
import { mergeBorehole, mergeFlag, mergeReading } from './merge';
import type { PullResult, TombRec } from './types';

const ALL = ['boreholes', 'readings', 'meta', 'outbox', 'tombstones'] as const;

async function byUid(tx: Tx, uid: string) { return tx.objectStore('boreholes').index('byUid').get(uid); }

/** Move every reading of `from` onto `to` and delete `from` (local side of a same-name merge). */
async function absorb(tx: Tx, from: Borehole, to: Borehole) {
  const rs = tx.objectStore('readings');
  for (const r of await rs.index('byBorehole').getAll(from.name)) {
    const moved = { ...r, borehole: to.name, boreholeUid: to.uid };
    await rs.put(moved);
    // Re-queue only if it was still waiting, so the server sees the new borehole link.
    if (await tx.objectStore('outbox').getKey(`r:${r.uid}`)) await tx.objectStore('outbox').put({ key: `r:${r.uid}`, kind: 'reading', rec: toRRec(moved), ver: `${Date.now()}-m` });
  }
  if (from.name !== to.name) await tx.objectStore('boreholes').delete(from.name);
  await tx.objectStore('outbox').delete(`b:${from.uid}`);
  await _tombstone(tx, { uid: from.uid!, kind: 'borehole', deletedAt: new Date().toISOString(), mergedInto: to.uid }, false);
}

/** A time after `iso` (now, unless the clock is behind it). */
const after = (iso: string) => { const n = new Date().toISOString(); return n > iso ? n : new Date(Date.parse(iso) + 1).toISOString(); };
const keptFlag = (n: number) => `Deleted on another phone, but ${n} reading(s) on this phone were kept`;

/**
 * Apply what the server sent (0.4.1 rules: no reading is ever deleted without its own tombstone). Order: boreholes (field-by-field merge, renames, same-name merges), then readings
 * (new ones added, edits newest-wins, reference values never changed), then tombstones, reading deletes first.
 * - A record deleted here comes back only if the server's copy was edited AFTER the delete (tombstone dropped).
 * - A reading delete loses to a local edit made after it (kept and re-sent; the sheet restores it and flags the borehole).
 * - A borehole delete never removes readings: if it still has readings here (taken offline, or not yet seen by the
 *   deleting phone), or was edited after the delete, it is kept, flagged, and re-sent so the sheet restores it.
 * Returns `queued` = number of items this put in the outbox (the engine pushes them in the same sync).
 */
export async function applyPull(p: PullResult): Promise<{ changed: number; queued: number }> {
  const tx = await _rw([...ALL]);
  let changed = 0, queued = 0;
  try {
    const tombs = tx.objectStore('tombstones');
    const ob = tx.objectStore('outbox');
    const incomingDead = new Map<string, TombRec>(p.tombstones.filter((t) => !t.restoredAt).map((t) => [t.uid, t]));
    const bs = tx.objectStore('boreholes');
    /** False if deleted here and the incoming copy is not newer than that delete; drops the local delete otherwise. */
    const alive = async (uid: string, updatedAt: string) => {
      const t = await tombs.get(uid);
      if (!t) return true;
      if (!(updatedAt > t.deletedAt) && !p.tombstones.some((x) => x.uid === uid && x.restoredAt)) return false;
      await tombs.delete(uid); await ob.delete(`t:${uid}`);
      return true;
    };

    for (const inc of p.boreholes) {
      if (incomingDead.has(inc.uid) || !(await alive(inc.uid, inc.updatedAt))) continue;
      const local = await byUid(tx, inc.uid);
      const merged = fromBRec(local ? mergeBorehole(toBRec(local), inc) : inc);
      const clashName = findName(await bs.getAllKeys(), merged.name);
      const clash = clashName ? await bs.get(clashName) : undefined;
      if (clash && clash.uid !== inc.uid) {
        // Another borehole here has the same name: the server's record wins the uid, ours folds into it.
        const m2 = fromBRec(mergeBorehole(toBRec(merged), toBRec(clash)));
        const flagged: Borehole = { ...m2, uid: inc.uid, flag: m2.flag || mergeFlag(new Date().toISOString()), fieldTimes: { ...m2.fieldTimes, flag: new Date().toISOString() } };
        if (local && local.name !== clash.name) await bs.delete(local.name);
        await _putBorehole(tx, flagged);
        await absorb(tx, clash, flagged);
        if (local && local.name !== flagged.name) {
          const rs = tx.objectStore('readings');
          for (const r of await rs.index('byBorehole').getAll(local.name)) await rs.put({ ...r, borehole: flagged.name, boreholeUid: flagged.uid });
        }
        await tx.objectStore('outbox').put({ key: `b:${flagged.uid}`, kind: 'borehole', rec: toBRec(flagged), ver: `${Date.now()}-f` });
        changed++;
        continue;
      }
      if (local && JSON.stringify(toBRec(local)) === JSON.stringify(toBRec(merged))) continue;
      await _putBorehole(tx, merged, local?.name);
      changed++;
    }

    const rs = tx.objectStore('readings');
    const meta = tx.objectStore('meta');
    let waitForBorehole = false; // a reading arrived before its borehole: don't move the cursor past it
    for (const inc of p.readings) {
      if (incomingDead.has(inc.uid) || !(await alive(inc.uid, inc.updatedAt))) continue;
      const bh = await byUid(tx, inc.boreholeUid);
      if (!bh) { // deleted here (the server sends the reading's tombstone or restores it), or not on the sheet yet
        if (!(await tombs.get(inc.boreholeUid))) waitForBorehole = true;
        continue;
      }
      const local = await rs.index('byUid').get(inc.uid);
      if (local) {
        const m = mergeReading(toRRec(local), { ...inc, boreholeName: bh.name });
        const next: Reading = { ...local, borehole: bh.name, boreholeUid: bh.uid, depthFt: m.depthFt, notes: m.notes || undefined, updatedAt: m.updatedAt };
        if (JSON.stringify(next) === JSON.stringify(local)) continue;
        await rs.put(next);
      } else {
        let id = ((await meta.get('nextReadingId'))?.value as number | undefined) ?? 1;
        while (await rs.getKey(id)) id++;
        await rs.add({ id, uid: inc.uid, seq: inc.seq, borehole: bh.name, boreholeUid: bh.uid, datetime: inc.datetime, userCode: inc.userCode,
          referencePoint: inc.referencePoint, refElevationFt: inc.refElevationFt, depthFt: inc.depthFt, notes: inc.notes || undefined, createdAt: inc.createdAt, updatedAt: inc.updatedAt });
        await meta.put({ key: 'nextReadingId', value: id + 1 });
      }
      changed++;
    }

    const order = [...incomingDead.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'reading' ? -1 : 1));
    for (const t of order) {
      if (t.kind === 'reading') {
        const local = await rs.index('byUid').get(t.uid);
        if (local && local.updatedAt > t.deletedAt) {
          // Edited here after it was deleted elsewhere: keep it and send it again (the sheet restores it, flagged).
          await _queue(tx, 'reading', toRRec(local)); queued++;
          continue;
        }
        if (local) { await rs.delete(local.id); changed++; }
        await ob.delete(`r:${t.uid}`);
        await _tombstone(tx, t, false);
        continue;
      }
      const local = await byUid(tx, t.uid);
      if (local && t.mergedInto) {
        // Same-name merge: follow the chain to the surviving borehole.
        let to = t.mergedInto;
        for (let i = 0; i < 20; i++) {
          const nxt = incomingDead.get(to)?.mergedInto ?? (await tombs.get(to))?.mergedInto;
          if (!nxt || (await byUid(tx, to))) break;
          to = nxt;
        }
        const target = await byUid(tx, to);
        if (target) { await absorb(tx, local, target); changed++; continue; }
      }
      if (local) {
        const left = await rs.index('byBorehole').getAll(local.name);
        if (left.length || local.updatedAt > t.deletedAt) {
          // Never delete readings with a borehole delete. Keep it, flagged, and re-send it and its readings.
          const now = after(t.deletedAt);
          const kept = left.length ? { ...local, flag: keptFlag(left.length), updatedAt: now, fieldTimes: { ...local.fieldTimes, flag: now } } : local;
          if (kept !== local) await _putBorehole(tx, kept);
          await _queue(tx, 'borehole', toBRec(kept)); queued++;
          for (const r of left) { if ((await ob.get(`r:${r.uid}`))?.failed) continue; /* stays failed until Retry */ await _queue(tx, 'reading', toRRec(r)); queued++; }
          changed++;
          continue;
        }
        await bs.delete(local.name);
        changed++;
      }
      await ob.delete(`b:${t.uid}`);
      await _tombstone(tx, t, false);
    }
    if (!waitForBorehole) await meta.put({ key: CURSOR, value: p.cursor });
    await tx.done;
  } catch (e) { try { tx.abort(); } catch { /* done */ } throw e; }
  return { changed, queued };
}
