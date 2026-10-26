import { _putBorehole, _rw, _tombstone, CURSOR, findName, fromBRec, toBRec, toRRec, type Tx } from '../lib/db';
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

/**
 * Apply what the server sent. Order: boreholes (field-by-field merge, renames, same-name merges), then readings
 * (new ones added, edits newest-wins, reference values never changed), then tombstones (deletes; never undone).
 * Anything already tombstoned on this phone is ignored, so deleted records never come back.
 */
export async function applyPull(p: PullResult): Promise<{ changed: number }> {
  const tx = await _rw([...ALL]);
  let changed = 0;
  try {
    const dead = new Set((await tx.objectStore('tombstones').getAllKeys()) as string[]);
    const incomingDead = new Map<string, TombRec>(p.tombstones.map((t) => [t.uid, t]));
    const bs = tx.objectStore('boreholes');

    for (const inc of p.boreholes) {
      if (dead.has(inc.uid) || (incomingDead.has(inc.uid))) continue;
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
    for (const inc of p.readings) {
      if (dead.has(inc.uid) || incomingDead.has(inc.uid)) continue;
      const bh = await byUid(tx, inc.boreholeUid);
      if (!bh) continue; // its borehole was deleted here; the server will send the reading's tombstone
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

    for (const t of p.tombstones) {
      if (t.kind === 'reading') {
        const local = await rs.index('byUid').get(t.uid);
        if (local) { await rs.delete(local.id); changed++; }
      } else {
        const local = await byUid(tx, t.uid);
        if (local) {
          const target = t.mergedInto ? await byUid(tx, t.mergedInto) : undefined;
          if (target) await absorb(tx, local, target);
          else {
            for (const r of await rs.index('byBorehole').getAll(local.name)) await rs.delete(r.id);
            await bs.delete(local.name);
          }
          changed++;
        }
      }
      await _tombstone(tx, t, false);
    }
    await meta.put({ key: CURSOR, value: p.cursor });
    await tx.done;
  } catch (e) { try { tx.abort(); } catch { /* done */ } throw e; }
  return { changed };
}
