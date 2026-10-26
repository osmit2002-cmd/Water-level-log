import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useStore } from '../store';
import { deleteBorehole, findName, saveBorehole } from '../lib/db';
import { fmt2, fromUnit, parseDecimal, toUnit } from '../lib/math';

export default function BoreholeForm() {
  const { name: editName } = useParams();
  const { bhMap, readings, settings, reload } = useStore();
  const u = settings.unit;
  const nav = useNavigate();
  const old = editName ? bhMap.get(editName) : undefined;
  const n2 = (ft?: number) => (ft == null ? '' : fmt2(toUnit(ft, u)));
  const [f, setF] = useState({ name: old?.name ?? '', referencePoint: old?.referencePoint ?? 'top of casing', elev: n2(old?.refElevationFt) });
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  if (editName && !old) return <p>Borehole not found.</p>;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const count = old ? readings.filter((r) => r.borehole === old.name).length : 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    const name = f.name.trim();
    if (!name) return setErr('Borehole Name is required');
    const clash = findName(bhMap.keys(), name);
    if (clash && clash !== old?.name) return setErr(`A borehole named ${clash} already exists`);
    const elev = parseDecimal(f.elev);
    if (!Number.isFinite(elev)) return setErr('Reference elevation must be a number');
    const now = new Date().toISOString();
    // Keep exact stored feet if the displayed value was not changed (avoids unit round-trip drift).
    const refElevationFt = old && f.elev === n2(old.refElevationFt) ? old.refElevationFt : fromUnit(elev, u);
    setSaving(true);
    try {
      await saveBorehole({ name, referencePoint: f.referencePoint.trim() || 'top of casing', refElevationFt, createdAt: old?.createdAt ?? now, updatedAt: now }, old?.name);
    } catch (x) { setSaving(false); return setErr((x as Error).message); }
    await reload();
    nav(`/borehole/${encodeURIComponent(name)}`, { replace: true });
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
      <button type="submit" className="primary" data-testid="bh-save" disabled={saving}>Save borehole</button>
      {old && <button type="button" className="danger" onClick={remove}>Delete borehole</button>}
    </form>
  );
}
