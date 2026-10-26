import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useStore } from '../store';
import { deleteReading, putReading, uid as newUid } from '../lib/db';
import { WARN_CHANGE_FT, fmt2, fmtLen, fromUnit, nowLocal, parseDecimal, previewChange, round2, toUnit } from '../lib/math';
import { STATUSES, STATUS_LABEL, type Reading, type ReadingStatus } from '../lib/types';
import { Change } from '../ui';

const LAST_BH = 'wll-last-borehole';
const LAST_READER = 'wll-last-reader';

export default function ReadingForm() {
  const { uid } = useParams();
  const [qs] = useSearchParams();
  const { boreholes, bhMap, readings, settings, reload } = useStore();
  const u = settings.unit;
  const nav = useNavigate();
  const old = uid ? readings.find((r) => r.uid === uid) : undefined;
  const initialBh = old?.boreholeId ?? qs.get('bh') ?? localStorage.getItem(LAST_BH) ?? '';
  const [bh, setBh] = useState(bhMap.has(initialBh) ? initialBh : boreholes[0]?.id ?? '');
  const [status, setStatus] = useState<ReadingStatus>(old?.status ?? 'ok');
  const [depth, setDepth] = useState(old?.depthFt != null ? fmt2(toUnit(old.depthFt, u)) : '');
  const [dt, setDt] = useState(old?.datetime ?? nowLocal());
  const [reader, setReader] = useState(old?.reader ?? localStorage.getItem(LAST_READER) ?? '');
  const [notes, setNotes] = useState(old?.notes ?? '');
  const [err, setErr] = useState('');
  const [confirmBig, setConfirmBig] = useState(false);
  const [saving, setSaving] = useState(false);

  const b = bhMap.get(bh);
  const depthNum = parseDecimal(depth);
  // Two-decimal depth in the display unit, stored in feet. Unchanged depth on edit keeps the exact stored value.
  const depthFt = old?.depthFt != null && depth === fmt2(toUnit(old.depthFt, u)) ? old.depthFt : Number.isFinite(depthNum) ? fromUnit(round2(depthNum), u) : undefined;
  const refFt = old ? old.refElevationFt : b?.refElevationFt;
  const refPoint = old ? old.referencePoint : b?.referencePoint ?? '';
  const candidate: Reading | undefined = b && refFt != null ? {
    uid: old?.uid ?? '__new__', boreholeId: bh, datetime: dt, status, depthFt: status === 'ok' ? depthFt : undefined,
    refElevationFt: refFt, referencePoint: refPoint, reader: reader.trim() || undefined, notes: notes.trim() || undefined,
    createdAt: old?.createdAt ?? '9999', updatedAt: ''
  } : undefined;
  const okDepth = status !== 'ok' || (depthFt != null && depthFt >= 0);
  const change = useMemo(() => (candidate && status === 'ok' && okDepth ? previewChange(readings, candidate) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readings, uid, bh, dt, status, depthFt, refFt]);
  const big = change != null && Math.abs(change) > WARN_CHANGE_FT;
  const beyondTd = status === 'ok' && depthFt != null && b?.totalDepthFt != null && depthFt > b.totalDepthFt;

  if (uid && !old) return <p>Reading not found. <Link to="/readings">Back</Link></p>;
  if (!boreholes.length) return <p className="empty">Add a borehole first. <Link to="/new-borehole">+ Borehole</Link></p>;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setErr('');
    if (!b || !candidate) return setErr('Pick a borehole');
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dt)) return setErr('Enter a valid date and time');
    if (status === 'ok') {
      if (!depth.trim() || !Number.isFinite(depthNum)) return setErr('Enter the depth to water');
      if (depthNum < 0) return setErr('Depth to water cannot be negative');
    }
    if (big && !confirmBig) { setConfirmBig(true); return; }
    if (saving) return;
    setSaving(true);
    const now = new Date().toISOString();
    await putReading({ ...candidate, uid: old?.uid ?? newUid(), createdAt: old?.createdAt ?? now, updatedAt: now });
    localStorage.setItem(LAST_BH, bh);
    if (reader.trim()) localStorage.setItem(LAST_READER, reader.trim());
    await reload();
    nav(`/borehole/${encodeURIComponent(bh)}`, { replace: !!old });
  }
  async function remove() {
    if (!confirm('Delete this reading? This cannot be undone.')) return;
    await deleteReading(old!.uid);
    await reload();
    nav(`/borehole/${encodeURIComponent(old!.boreholeId)}`, { replace: true });
  }

  return (
    <form onSubmit={save} className="form">
      <h2>{old ? 'Edit reading' : 'New reading'}</h2>
      <label>Borehole
        <select value={bh} onChange={(e) => { setBh(e.target.value); setConfirmBig(false); }} disabled={!!old} data-testid="rd-borehole">
          {boreholes.map((x) => <option key={x.id} value={x.id}>{x.id}{x.name !== x.id ? ` · ${x.name}` : ''}</option>)}
        </select>
      </label>
      {b && <p className="muted small">Measured from {refPoint || 'reference point'} at {fmtLen(refFt, u)} {u}{old && old.refElevationFt !== b.refElevationFt ? ' (elevation at the time of this reading)' : ''}</p>}
      <fieldset className="seg" aria-label="Status">
        {STATUSES.map((s) => (
          <button type="button" key={s} className={status === s ? 'on' : ''} aria-pressed={status === s} onClick={() => { setStatus(s); setConfirmBig(false); }} data-testid={`rd-status-${s}`}>{STATUS_LABEL[s]}</button>
        ))}
      </fieldset>
      {status === 'ok' && (
        <label>Depth to water ({u} below {refPoint || 'reference'})
          <input className="huge" inputMode="decimal" value={depth} onChange={(e) => { setDepth(e.target.value); setConfirmBig(false); }} placeholder="0.00" autoFocus={!old} data-testid="rd-depth" />
        </label>
      )}
      {status === 'ok' && candidate?.depthFt != null && okDepth && (
        <div className="calc" data-testid="rd-calc">
          <div>Water elevation <b>{fmtLen(refFt! - candidate.depthFt, u)} {u}</b></div>
          <div>Change from previous <Change ft={change} unit={u} /></div>
        </div>
      )}
      {status !== 'ok' && <p className="muted">{STATUS_LABEL[status]}: no depth or elevation is recorded, and change is skipped for this reading.</p>}
      {big && <p className="warn" role="alert">Change of {fmt2(toUnit(Math.abs(change!), u))} {u} from the previous reading is more than {fmt2(toUnit(WARN_CHANGE_FT, u))} {u}. Check the depth{confirmBig ? ', then tap Save anyway.' : '.'}</p>}
      {beyondTd && <p className="warn">Depth is greater than the borehole's total depth ({fmtLen(b!.totalDepthFt, u)} {u}).</p>}
      <label>Date and time<input type="datetime-local" value={dt} onChange={(e) => { setDt(e.target.value); setConfirmBig(false); }} data-testid="rd-dt" required /></label>
      <label>Reader<input value={reader} onChange={(e) => setReader(e.target.value)} autoComplete="name" /></label>
      <label>Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></label>
      {err && <p className="error" role="alert">{err}</p>}
      <button type="submit" className="primary" data-testid="rd-save" disabled={saving}>{big && confirmBig ? 'Save anyway' : 'Save reading'}</button>
      {old && <button type="button" className="danger" onClick={remove}>Delete reading</button>}
    </form>
  );
}
