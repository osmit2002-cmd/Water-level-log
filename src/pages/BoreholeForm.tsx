import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useStore } from '../store';
import { deleteBorehole, findName, getBoreholeByUid, saveBorehole } from '../lib/db';
import { applyMine, staleBorehole, type Stale } from '../lib/conflict';
import type { Borehole } from '../lib/types';
import { fmt2, fromUnit, parseDecimal, toUnit } from '../lib/math';

/** Like ReadingForm: keeps the version it opened with and checks it on Save (fix #6). */
export default function BoreholeForm() {
  const { name: editName } = useParams();
  const { bhMap, ready } = useStore();
  const live = editName ? bhMap.get(editName) : undefined;
  const [base, setBase] = useState<Borehole | undefined>(live);
  useEffect(() => { if (!base && live) setBase(live); }, [base, live]);
  if (editName && !base) return ready ? <p>Borehole not found.</p> : null;
  return <Form key={base ? `${base.uid}@${base.updatedAt}` : 'new'} old={base} rebase={setBase} />;
}

function Form({ old, rebase }: { old?: Borehole; rebase: (b: Borehole) => void }) {
  const { bhMap, readings, settings, reload } = useStore();
  const u = settings.unit;
  const nav = useNavigate();
  const [conflict, setConflict] = useState<{ st: NonNullable<Stale>; cur?: Borehole; mine: Pick<Borehole, 'name' | 'referencePoint' | 'refElevationFt'> }>();
  const n2 = (ft?: number) => (ft == null ? '' : fmt2(toUnit(ft, u)));
  const [f, setF] = useState({ name: old?.name ?? '', referencePoint: old?.referencePoint ?? 'top of casing', elev: n2(old?.refElevationFt) });
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const count = old ? readings.filter((r) => r.borehole === old.name).length : 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    const name = f.name.trim();
    if (!name) return setErr('Borehole Name is required');
    const elev = parseDecimal(f.elev);
    if (!Number.isFinite(elev)) return setErr('Reference elevation must be a number');
    // Keep exact stored feet if the displayed value was not changed (avoids unit round-trip drift).
    const refElevationFt = old && f.elev === n2(old.refElevationFt) ? old.refElevationFt : fromUnit(elev, u);
    const mine = { name, referencePoint: f.referencePoint.trim() || 'top of casing', refElevationFt };
    if (old) {
      const cur = old.uid ? await getBoreholeByUid(old.uid) : bhMap.get(old.name);
      const st = staleBorehole(old, cur);
      if (st) return setConflict({ st, cur, mine });
    }
    await commit(mine);
  }
  async function commit(mine: Pick<Borehole, 'name' | 'referencePoint' | 'refElevationFt'>, cur?: Borehole) {
    setErr('');
    const clash = findName(bhMap.keys(), mine.name);
    const curName = cur?.name ?? old?.name;
    if (clash && clash !== curName) return setErr(`A borehole named ${clash} already exists`);
    const now = new Date().toISOString();
    // On top of a newer version: only the fields changed in this form overwrite it. After a delete: re-create with the same uid.
    const next = cur && old ? applyMine(old, cur, mine) : { ...old, ...mine };
    setSaving(true);
    try {
      await saveBorehole({ ...next, createdAt: old?.createdAt ?? now, updatedAt: now }, conflict?.st.kind === 'deleted' ? undefined : curName);
    } catch (x) { setSaving(false); return setErr((x as Error).message); }
    await reload();
    nav(`/borehole/${encodeURIComponent(next.name)}`, { replace: true });
  }

  async function remove() {
    if (!confirm(`Delete borehole ${old!.name} and its ${count} reading(s)? This cannot be undone.`)) return;
    await deleteBorehole(old!.name);
    await reload();
    nav('/', { replace: true });
  }

  return (
    <form onSubmit={save} className="form">
      <h2>{old ? `Edit ${old.name}` : 'New borehole'}</h2>
      <label>Borehole Name *<input value={f.name} onChange={set('name')} autoCapitalize="characters" data-testid="bh-name" required /></label>
      {old && f.name.trim() !== old.name && <p className="muted small" data-testid="bh-rename-note">Renaming also updates the Borehole Name on its {count} reading(s).</p>}
      <label>Reference Point<input value={f.referencePoint} onChange={set('referencePoint')} list="refpoints" data-testid="bh-refpoint" /></label>
      <datalist id="refpoints"><option value="top of casing" /><option value="collar" /><option value="ground surface" /></datalist>
      <label>Reference Elevation ({u}) *<input inputMode="decimal" value={f.elev} onChange={set('elev')} data-testid="bh-elev" required /></label>
      {old && <p className="muted small">Changing the reference point or elevation affects new readings only. Past readings keep the values they were taken with.</p>}
      {err && <p className="error" role="alert">{err}</p>}
      {conflict && (
        <div className="conflict" role="alertdialog" aria-labelledby="bcf-h" data-testid="bh-conflict">
          <p id="bcf-h"><strong>{conflict.st.kind === 'deleted' ? 'This borehole was deleted on another phone while you were editing.' : 'This borehole was changed on another phone while you were editing.'}</strong></p>
          {conflict.cur && (
            <dl className="small" data-testid="bh-conflict-newer">
              <dt>Name</dt><dd>{conflict.cur.name}</dd>
              <dt>Reference Point</dt><dd>{conflict.cur.referencePoint}</dd>
              <dt>Reference Elevation</dt><dd>{n2(conflict.cur.refElevationFt)} {u}</dd>
              {conflict.cur.flag && <><dt>Flag</dt><dd>{conflict.cur.flag}</dd></>}
            </dl>
          )}
          <p className="small">{conflict.cur ? 'Save mine changes only the fields you edited.' : 'Restoring brings it back on every phone, flagged.'}</p>
          <button type="button" className="primary" data-testid="bh-conflict-mine" onClick={() => { void commit(conflict.mine, conflict.cur).then(() => setConflict(undefined)); }}>
            {conflict.st.kind === 'deleted' ? 'Restore it with my values' : 'Save mine'}
          </button>
          <button type="button" data-testid="bh-conflict-theirs" onClick={() => {
            const c = conflict; setConflict(undefined);
            if (c.cur) rebase(c.cur); else nav('/', { replace: true });
          }}>{conflict.st.kind === 'deleted' ? 'Leave it deleted' : 'Keep the newer values'}</button>
        </div>
      )}
      <button type="submit" className="primary" data-testid="bh-save" disabled={saving || !!conflict}>Save borehole</button>
      {old && <button type="button" className="danger" onClick={remove}>Delete borehole</button>}
    </form>
  );
}
