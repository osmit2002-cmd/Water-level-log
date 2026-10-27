import { displayId } from '../lib/ids';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useStore } from '../store';
import { addReading, deleteReading, getReading, updateReading } from '../lib/db';
import { staleReading, type Stale } from '../lib/conflict';
import type { Reading, Scope } from '../lib/types';
import { scopeOf } from '../lib/types';
import { inScope, loadScope, RD_SCOPE, saveScope, ScopeBadge, ScopeSwitch } from '../Scope';
import UserCodeSheet from '../UserCodeSheet';
import { fmt2, fmtLen, fromUnit, nowLocal, parseDecimal, round2, toUnit } from '../lib/math';

const LAST_BH = 'wll-last-borehole';

/**
 * The form keeps the version of the reading it opened with (`old`). A sync may change or delete the record while the
 * form is open (fix #6): the form keeps what the user started from, and Save checks it against what is stored now.
 */
export default function ReadingForm() {
  const { id: idParam } = useParams();
  const { readings, ready } = useStore();
  const live = idParam ? readings.find((r) => String(r.id) === idParam) : undefined;
  const [base, setBase] = useState<Reading | undefined>(live);
  useEffect(() => { if (!base && live) setBase(live); }, [base, live]);
  if (idParam && !base) return ready ? <p>Reading not found. <Link to="/readings">Back</Link></p> : null;
  return <Form key={base ? `${base.uid}@${base.updatedAt}` : 'new'} old={base} rebase={setBase} />;
}

function Form({ old, rebase }: { old?: Reading; rebase: (r: Reading) => void }) {
  const [qs] = useSearchParams();
  const { boreholes, bhMap, settings, setSettings, reload } = useStore();
  const [askCode, setAskCode] = useState(false);
  const u = settings.unit;
  const nav = useNavigate();
  const [conflict, setConflict] = useState<{ st: NonNullable<Stale>; cur?: Reading }>();
  const asked = old?.borehole ?? qs.get('bh') ?? '';
  // 0.5.0: Local / Shared selector. Opening from a borehole (or editing) follows that borehole; otherwise the last choice.
  const [scope, setScopeState] = useState<Scope>(bhMap.has(asked) ? scopeOf(bhMap.get(asked)) : loadScope(RD_SCOPE, ['local', 'shared'] as const, 'shared'));
  const choices = boreholes.filter((x) => inScope(x, scope) || x.name === asked);
  const pick = (list: typeof boreholes, prefer: string[]) => prefer.find((n) => list.some((x) => x.name === n)) ?? list[0]?.name ?? '';
  const [bh, setBh] = useState(() => pick(choices, [asked, localStorage.getItem(LAST_BH) ?? '']));
  const setScope = (v: Scope) => {
    setScopeState(v); saveScope(RD_SCOPE, v);
    setBh(pick(boreholes.filter((x) => inScope(x, v)), [localStorage.getItem(LAST_BH) ?? '']));
  };
  const [depth, setDepth] = useState(old ? fmt2(toUnit(old.depthFt, u)) : '');
  const [notes, setNotes] = useState(old?.notes ?? '');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const committing = useRef(false);
  const [clock, setClock] = useState(nowLocal());
  useEffect(() => { if (old) return; const t = setInterval(() => setClock(nowLocal()), 5000); return () => clearInterval(t); }, [old]);

  const b = bhMap.get(bh);
  const depthNum = parseDecimal(depth);
  // Two-decimal depth in the display unit, stored in feet. Unchanged depth on edit keeps the exact stored value.
  const depthFt = old && depth === fmt2(toUnit(old.depthFt, u)) ? old.depthFt : Number.isFinite(depthNum) ? fromUnit(round2(depthNum), u) : undefined;
  const refFt = old ? old.refElevationFt : b?.refElevationFt;
  const refPoint = old ? old.referencePoint : b?.referencePoint ?? '';
  const okDepth = depthFt != null && depthFt >= 0;

  if (!boreholes.length) return <p className="empty">Add a borehole first. <Link to="/new-borehole">+ Borehole</Link></p>;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setErr('');
    if (!b && !old) return setErr('Pick a borehole');
    if (!depth.trim() || !Number.isFinite(depthNum)) return setErr('Enter the depth to top of water');
    if (depthNum < 0) return setErr('Depth to top of water cannot be negative');
    // New readings need this phone's User Code; ask for it without leaving (or clearing) the form.
    if (!old && !settings.userCode) return setAskCode(true);
    if (old) {
      const cur = await getReading(old.id);
      const st = staleReading(old, cur?.uid === old.uid ? cur : undefined);
      if (st) return setConflict({ st, cur: cur?.uid === old.uid ? cur : undefined });
    }
    await commit(settings.userCode);
  }
  async function commit(userCode: string, onto?: Reading) {
    if (committing.current) return;
    committing.current = true;
    setSaving(true);
    const now = new Date();
    try {
      if (old) {
        await updateReading({ ...(onto ?? old), depthFt: depthFt!, notes: notes.trim() || undefined, updatedAt: now.toISOString() });
      } else {
        // Date and time come from the phone clock at the moment of saving; reference values are snapshotted.
        await addReading({ borehole: bh, datetime: nowLocal(now), referencePoint: b!.referencePoint, refElevationFt: b!.refElevationFt,
          depthFt: depthFt!, userCode, notes: notes.trim() || undefined, createdAt: now.toISOString(), updatedAt: now.toISOString() });
        localStorage.setItem(LAST_BH, bh);
      }
    } catch (x) { committing.current = false; setSaving(false); return setErr(`Could not save: ${(x as Error).message}`); }
    await reload();
    nav(`/borehole/${encodeURIComponent(old?.borehole ?? bh)}`, { replace: !!old });
  }
  async function remove() {
    if (!confirm(`Delete reading ${displayId(old!)}? This cannot be undone. Its Reading ID will not be reused.`)) return;
    await deleteReading(old!.id);
    await reload();
    nav(`/borehole/${encodeURIComponent(old!.borehole)}`, { replace: true });
  }

  return (
    <form onSubmit={save} className="form">
      <h2>{old ? `Edit reading ${displayId(old)}` : 'New reading'}</h2>
      <ScopeSwitch label="Borehole scope" value={scope} options={['local', 'shared'] as const} onChange={setScope} disabled={!!old} testid="rd-scope"
        counts={old ? undefined : { local: boreholes.filter((x) => inScope(x, 'local')).length, shared: boreholes.filter((x) => inScope(x, 'shared')).length }} />
      <p className="muted small" data-testid="rd-scope-note">{scope === 'local' ? 'Local: saved on this phone only, never uploaded.' : 'Shared: uploaded to the team sheet when sync is on.'}</p>
      {!old && !choices.length ? (
        boreholes.some((x) => x.hidden && scopeOf(x) === scope)
          ? <p className="empty" data-testid="rd-scope-empty">All {scope === 'local' ? 'Local' : 'Shared'} boreholes are hidden on this phone. <Link to="/">Boreholes → Show hidden</Link></p>
          : <p className="empty" data-testid="rd-scope-empty">No {scope === 'local' ? 'Local' : 'Shared'} boreholes yet. <Link to={`/new-borehole?scope=${scope}`}>+ {scope === 'local' ? 'Local' : 'Shared'} borehole</Link></p>
      ) : (
      <label>Borehole Name
        <select value={bh} onChange={(e) => setBh(e.target.value)} disabled={!!old} data-testid="rd-borehole">
          {old && !bhMap.has(old.borehole) && <option value={old.borehole}>{old.borehole}</option>}
          {choices.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
        </select>
      </label>
      )}
      {refFt != null && <p className="muted small" data-testid="rd-ref">Reference Point: {refPoint || '—'} · Reference Elevation {fmtLen(refFt, u)} {u}{old && b && old.refElevationFt !== b.refElevationFt ? ' (as recorded for this reading)' : ''} {b && <ScopeBadge scope={scopeOf(b)} />}</p>}
      <label>Depth to Top of Water ({u} below {refPoint || 'reference point'})
        <input className="huge" inputMode="decimal" value={depth} onChange={(e) => setDepth(e.target.value)} placeholder="0.00" autoFocus={!old} data-testid="rd-depth" />
      </label>
      {okDepth && refFt != null && (
        <div className="calc" data-testid="rd-calc">Water Elevation <b>{fmtLen(refFt - depthFt!, u)} {u}</b></div>
      )}
      <label>Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} data-testid="rd-notes" /></label>
      <div className="stamp small" data-testid="rd-stamp">
        {old
          ? <>Recorded <b>{old.datetime.slice(0, 10)}</b> at <b>{old.datetime.slice(11, 16)}</b> (phone clock). Date and time can't be edited.</>
          : <>Date and time are taken from this phone's clock when you tap Save (now {clock.replace('T', ' ')}).</>}
        <br />{old
          ? <>User Code: <b data-testid="rd-code">{old.userCode || '—'}</b> (as recorded).</>
          : <>User Code: <b data-testid="rd-code">{settings.userCode || 'not set'}</b>{settings.userCode ? ' (from Settings)' : ' — you will be asked on Save'}.</>}
      </div>
      {err && <p className="error" role="alert">{err}</p>}
      {conflict && (
        <div className="conflict" role="alertdialog" aria-labelledby="cf-h" data-testid="rd-conflict">
          <p id="cf-h"><strong>{conflict.st.kind === 'deleted' ? 'This reading was deleted on another phone while you were editing.' : 'This reading was changed on another phone while you were editing.'}</strong></p>
          {conflict.cur && (
            <dl className="small" data-testid="rd-conflict-newer">
              <dt>Newer depth</dt><dd>{fmt2(toUnit(conflict.cur.depthFt, u))} {u}</dd>
              <dt>Newer notes</dt><dd>{conflict.cur.notes || '—'}</dd>
              <dt>Changed</dt><dd>{new Date(conflict.cur.updatedAt).toLocaleString()}</dd>
            </dl>
          )}
          <p className="small">Yours: {depth} {u}{notes.trim() ? `, notes "${notes.trim()}"` : ''}.</p>
          <button type="button" className="primary" data-testid="rd-conflict-mine" onClick={() => { const c = conflict; setConflict(undefined); void commit(settings.userCode, c.cur); }}>
            {conflict.st.kind === 'deleted' ? 'Restore it with my values' : 'Save mine (replace newer)'}
          </button>
          <button type="button" data-testid="rd-conflict-theirs" onClick={() => {
            const c = conflict; setConflict(undefined);
            if (!c.cur) { nav(`/borehole/${encodeURIComponent(old!.borehole)}`, { replace: true }); return; }
            rebase(c.cur);
          }}>{conflict.st.kind === 'deleted' ? 'Leave it deleted' : 'Keep the newer values'}</button>
        </div>
      )}
      <button type="submit" className="primary" data-testid="rd-save" disabled={saving || !!conflict}>Save reading</button>
      {old && <button type="button" className="danger" onClick={remove}>Delete reading</button>}
      {askCode && <UserCodeSheet onCancel={() => setAskCode(false)} onSave={(code) => { setSettings({ ...settings, userCode: code }); setAskCode(false); void commit(code); }} />}
    </form>
  );
}
