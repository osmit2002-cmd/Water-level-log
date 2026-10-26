import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useStore } from '../store';
import { deleteBorehole, putBorehole } from '../lib/db';
import { fmt2, fromUnit, parseDecimal, toUnit } from '../lib/math';

export default function BoreholeForm() {
  const { id: editId } = useParams();
  const { bhMap, readings, settings, reload } = useStore();
  const u = settings.unit;
  const nav = useNavigate();
  const old = editId ? bhMap.get(editId) : undefined;
  const n2 = (ft?: number) => (ft == null ? '' : fmt2(toUnit(ft, u)));
  const [f, setF] = useState({
    id: old?.id ?? '', name: old?.name ?? '', referencePoint: old?.referencePoint ?? 'top of casing',
    elev: n2(old?.refElevationFt), td: n2(old?.totalDepthFt), location: old?.location ?? '', notes: old?.notes ?? '',
    lat: old?.lat?.toString() ?? '', lon: old?.lon?.toString() ?? ''
  });
  const [err, setErr] = useState('');
  if (editId && !old) return <p>Borehole not found.</p>;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const id = f.id.trim();
    if (!id) return setErr('ID is required');
    if (!old && bhMap.has(id)) return setErr(`A borehole with ID ${id} already exists`);
    const elev = parseDecimal(f.elev);
    if (!Number.isFinite(elev)) return setErr('Reference elevation must be a number');
    const optional = (s: string, label: string, min: number, max: number) => {
      if (!s.trim()) return undefined;
      const n = parseDecimal(s);
      if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} is invalid`);
      return n;
    };
    let td, lat, lon;
    try {
      td = optional(f.td, 'Total depth', 0, Infinity);
      lat = optional(f.lat, 'Latitude', -90, 90);
      lon = optional(f.lon, 'Longitude', -180, 180);
    } catch (x) { return setErr((x as Error).message); }
    const now = new Date().toISOString();
    // Keep exact stored feet if the displayed value was not changed (avoids unit round-trip drift).
    const keep = (input: string, ft: number | undefined, v: number | undefined) => (old && ft != null && input === n2(ft) ? ft : v == null ? undefined : fromUnit(v, u));
    await putBorehole({
      id, name: f.name.trim() || id, referencePoint: f.referencePoint.trim() || 'top of casing',
      refElevationFt: keep(f.elev, old?.refElevationFt, elev)!, totalDepthFt: keep(f.td, old?.totalDepthFt, td),
      location: f.location.trim() || undefined, notes: f.notes.trim() || undefined, lat, lon,
      createdAt: old?.createdAt ?? now, updatedAt: now
    });
    await reload();
    nav(`/borehole/${encodeURIComponent(id)}`, { replace: true });
  }

  async function remove() {
    const n = readings.filter((r) => r.boreholeId === old!.id).length;
    if (!confirm(`Delete borehole ${old!.id} and its ${n} reading(s)? This cannot be undone.`)) return;
    await deleteBorehole(old!.id);
    await reload();
    nav('/', { replace: true });
  }

  return (
    <form onSubmit={save} className="form">
      <h2>{old ? `Edit ${old.id}` : 'New borehole'}</h2>
      <label>ID *<input value={f.id} onChange={set('id')} disabled={!!old} autoCapitalize="characters" data-testid="bh-id" required /></label>
      {old && <p className="muted small">The ID can't change because readings are linked to it.</p>}
      <label>Name<input value={f.name} onChange={set('name')} data-testid="bh-name" /></label>
      <label>Reference point<input value={f.referencePoint} onChange={set('referencePoint')} list="refpoints" data-testid="bh-refpoint" /></label>
      <datalist id="refpoints"><option value="top of casing" /><option value="collar" /><option value="ground surface" /></datalist>
      <label>Reference elevation ({u}) *<input inputMode="decimal" value={f.elev} onChange={set('elev')} data-testid="bh-elev" required /></label>
      {old && <p className="muted small">Changing the elevation affects new readings only. Past readings keep the elevation they were taken with.</p>}
      <label>Total depth ({u})<input inputMode="decimal" value={f.td} onChange={set('td')} data-testid="bh-td" /></label>
      <label>Location<input value={f.location} onChange={set('location')} /></label>
      <div className="row gap">
        <label>Latitude<input inputMode="decimal" value={f.lat} onChange={set('lat')} /></label>
        <label>Longitude<input inputMode="decimal" value={f.lon} onChange={set('lon')} /></label>
      </div>
      <label>Notes<textarea value={f.notes} onChange={set('notes')} rows={2} /></label>
      {err && <p className="error" role="alert">{err}</p>}
      <button type="submit" className="primary" data-testid="bh-save">Save borehole</button>
      {old && <button type="button" className="danger" onClick={remove}>Delete borehole</button>}
    </form>
  );
}
