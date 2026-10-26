import { displayId } from '../lib/ids';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useStore } from '../store';
import { addReading, deleteReading, updateReading } from '../lib/db';
import UserCodeSheet from '../UserCodeSheet';
import { fmt2, fmtLen, fromUnit, nowLocal, parseDecimal, round2, toUnit } from '../lib/math';

const LAST_BH = 'wll-last-borehole';

export default function ReadingForm() {
  const { id: idParam } = useParams();
  const [qs] = useSearchParams();
  const { boreholes, bhMap, readings, settings, setSettings, reload } = useStore();
  const [askCode, setAskCode] = useState(false);
  const u = settings.unit;
  const nav = useNavigate();
  const old = idParam ? readings.find((r) => String(r.id) === idParam) : undefined;
  const initialBh = old?.borehole ?? qs.get('bh') ?? localStorage.getItem(LAST_BH) ?? '';
  const [bh, setBh] = useState(bhMap.has(initialBh) ? initialBh : boreholes[0]?.name ?? '');
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

  if (idParam && !old) return <p>Reading not found. <Link to="/readings">Back</Link></p>;
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
    await commit(settings.userCode);
  }
  async function commit(userCode: string) {
    if (committing.current) return;
    committing.current = true;
    setSaving(true);
    const now = new Date();
    try {
      if (old) {
        await updateReading({ ...old, depthFt: depthFt!, notes: notes.trim() || undefined, updatedAt: now.toISOString() });
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
      <label>Borehole Name
        <select value={bh} onChange={(e) => setBh(e.target.value)} disabled={!!old} data-testid="rd-borehole">
          {old && !bhMap.has(old.borehole) && <option value={old.borehole}>{old.borehole}</option>}
          {boreholes.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
        </select>
      </label>
      {refFt != null && <p className="muted small" data-testid="rd-ref">Reference Point: {refPoint || '—'} · Reference Elevation {fmtLen(refFt, u)} {u}{old && b && old.refElevationFt !== b.refElevationFt ? ' (as recorded for this reading)' : ''}</p>}
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
      <button type="submit" className="primary" data-testid="rd-save" disabled={saving}>Save reading</button>
      {old && <button type="button" className="danger" onClick={remove}>Delete reading</button>}
      {askCode && <UserCodeSheet onCancel={() => setAskCode(false)} onSave={(code) => { setSettings({ ...settings, userCode: code }); setAskCode(false); void commit(code); }} />}
    </form>
  );
}
