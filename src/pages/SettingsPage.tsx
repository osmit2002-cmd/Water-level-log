import { useRef, useState } from 'react';
import { useStore } from '../store';
import { boreholesCsv, csvFilename, parseBoreholesCsv, readingsCsv } from '../lib/csv';
import { replaceAll, upsertBoreholes } from '../lib/db';
import { makeBackup, validateBackup } from '../lib/backup';
import { saveFile } from '../lib/share';
import { todayLocal } from '../lib/math';
import type { Settings } from '../lib/types';

export default function SettingsPage() {
  const { boreholes, bhMap, readings, derived, settings, setSettings, reload, persisted } = useStore();
  const u = settings.unit;
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string; details?: string[] }>();
  const csvIn = useRef<HTMLInputElement>(null);
  const jsonIn = useRef<HTMLInputElement>(null);

  async function importCsv(file: File) {
    const res = parseBoreholesCsv(await file.text(), u);
    if (!res.rows.length) return setMsg({ kind: 'error', text: 'No boreholes imported.', details: res.errors.map((e) => `Line ${e.line}: ${e.message}`) });
    const newOnes = res.rows.filter((r) => !bhMap.has(r.id)).length;
    if (!confirm(`Import ${res.rows.length} borehole(s): ${newOnes} new, ${res.rows.length - newOnes} updated (matched by ID)?${res.errors.length ? `\n${res.errors.length} row problem(s) will be listed.` : ''}`)) return;
    const { added, updated } = await upsertBoreholes(res.rows);
    await reload();
    setMsg({ kind: res.errors.length ? 'error' : 'ok', text: `Imported ${added} new and updated ${updated} borehole(s).`, details: res.errors.map((e) => `Line ${e.line}: ${e.message}`) });
  }
  async function restore(file: File) {
    let b;
    try { b = validateBackup(JSON.parse(await file.text())); } catch (e) { return setMsg({ kind: 'error', text: `Restore failed: ${(e as Error).message}` }); }
    if (!confirm(`Replace ALL data on this device (${boreholes.length} boreholes, ${readings.length} readings) with the backup from ${b.exportedAt.slice(0, 10) || 'unknown date'} (${b.boreholes.length} boreholes, ${b.readings.length} readings)?`)) return;
    await replaceAll(b.boreholes, b.readings);
    setSettings({ ...settings, ...b.settings });
    await reload();
    setMsg({ kind: 'ok', text: `Restored ${b.boreholes.length} boreholes and ${b.readings.length} readings.` });
  }
  const set = (p: Partial<Settings>) => setSettings({ ...settings, ...p });
  const done = (what: string) => (r: string) => r !== 'cancelled' && setMsg({ kind: 'ok', text: `${what} ${r === 'shared' ? 'shared' : 'downloaded'}.` });

  return (
    <section className="form">
      <h2>Settings</h2>
      <fieldset className="seg" aria-label="Units">
        <legend>Units</legend>
        {(['ft', 'm'] as const).map((x) => <button key={x} type="button" className={u === x ? 'on' : ''} aria-pressed={u === x} onClick={() => set({ unit: x })} data-testid={`unit-${x}`}>{x === 'ft' ? 'Feet' : 'Meters'}</button>)}
      </fieldset>
      <fieldset className="seg" aria-label="Theme">
        <legend>Theme</legend>
        {(['auto', 'light', 'dark'] as const).map((x) => <button key={x} type="button" className={settings.theme === x ? 'on' : ''} aria-pressed={settings.theme === x} onClick={() => set({ theme: x })}>{x === 'auto' ? 'Auto' : x === 'light' ? 'Sunlight' : 'Dark'}</button>)}
      </fieldset>

      <h2>Export</h2>
      <button className="wide" disabled={!readings.length} onClick={() => saveFile(readingsCsv(derived, bhMap, u), csvFilename('all', todayLocal()), 'text/csv').then(done('Readings CSV'))}>Readings CSV (all)</button>
      <button className="wide" disabled={!boreholes.length} data-testid="export-boreholes" onClick={() => saveFile(boreholesCsv(boreholes, u), `boreholes_${todayLocal()}.csv`, 'text/csv').then(done('Boreholes CSV'))}>Boreholes CSV</button>

      <h2>Import boreholes</h2>
      <p className="muted small">CSV with a header row: borehole_id, reference_elevation_ft (or _m) required; optional borehole_name, reference_point, total_depth_ft, location, notes, latitude, longitude. Existing IDs are updated; past readings keep their elevations.</p>
      <button className="wide" onClick={() => csvIn.current?.click()}>Choose boreholes CSV…</button>
      <input ref={csvIn} type="file" accept=".csv,text/csv,text/plain" hidden data-testid="import-csv" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importCsv(f); }} />

      <h2>Backup</h2>
      <p className="muted small">iPhone can clear website storage. Save a backup to Files regularly.{persisted === true ? ' Persistent storage is granted.' : persisted === false ? ' Persistent storage was not granted.' : ''}</p>
      <button className="wide primary" onClick={() => saveFile(JSON.stringify(makeBackup(boreholes, readings, settings, `Water Level Log ${__APP_VERSION__}`), null, 1), `waterlevels_backup_${todayLocal()}.json`, 'application/json').then(done('Backup'))} data-testid="backup">Save full backup (JSON)</button>
      <button className="wide" onClick={() => jsonIn.current?.click()}>Restore from backup…</button>
      <input ref={jsonIn} type="file" accept=".json,application/json" hidden data-testid="restore" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void restore(f); }} />

      {msg && (
        <div className={msg.kind} role="status" data-testid="data-msg">
          <p>{msg.text}</p>
          {msg.details && msg.details.length > 0 && <ul className="small">{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
        </div>
      )}
      <p className="muted small">Water Level Log {__APP_VERSION__}. All data stays on this device; nothing is uploaded.</p>
    </section>
  );
}
