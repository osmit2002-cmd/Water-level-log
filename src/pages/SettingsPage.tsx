import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { boreholesCsv, columnLabel, csvFilename, parseBoreholesCsv, readingsCsv } from '../lib/csv';
import { discardFailed, findName, getDiscarded, getNextReadingId, outboxStats, replaceAll, retryFailed, upsertBoreholes, type OutboxItem } from '../lib/db';
import { makeBackup, validateBackup } from '../lib/backup';
import { saveFile } from '../lib/share';
import { todayLocal } from '../lib/math';
import { useSync } from '../sync/useSync';
import { COLUMNS, USER_CODE_MAX, normalizeUserCode, userCodeError, type ColumnKey, type Settings } from '../lib/types';

export default function SettingsPage() {
  const { boreholes, bhMap, readings, derived, settings, setSettings, reload, persisted } = useStore();
  const u = settings.unit;
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string; details?: string[] }>();
  const csvIn = useRef<HTMLInputElement>(null);
  const jsonIn = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState(settings.userCode);
  useEffect(() => setCode(settings.userCode), [settings.userCode]);
  const [codeMsg, setCodeMsg] = useState<{ kind: 'ok' | 'error'; text: string }>();
  function saveCode() {
    const c = normalizeUserCode(code);
    const e = userCodeError(c);
    if (e) return setCodeMsg({ kind: 'error', text: e });
    set({ userCode: c }); setCode(c);
    setCodeMsg({ kind: 'ok', text: `Saved. New readings on this phone will record ${c}.` });
  }
  const sync = useSync();
  const [surl, setSurl] = useState(sync.config.url);
  const [steam, setSteam] = useState(sync.config.team);
  const [syncMsg, setSyncMsg] = useState<{ kind: 'ok' | 'error'; text: string }>();
  const [checking, setChecking] = useState(false);
  async function turnOn() {
    setChecking(true); setSyncMsg(undefined);
    try {
      const e = await sync.enable(surl, steam);
      setSyncMsg(e ? { kind: 'error', text: e } : { kind: 'ok', text: 'Sync is on. This phone now shares readings with the team sheet.' });
    } finally { setChecking(false); }
  }
  const describeItem = (f: OutboxItem) => {
    const r = f.rec as { displayId?: string; name?: string; kind?: string };
    return f.kind === 'reading' ? `Reading ${r.displayId}` : f.kind === 'borehole' ? `Borehole ${r.name}` : `Delete of a ${r.kind}`;
  };
  async function retryOne(key: string) { await retryFailed(key); await sync.refresh(); await sync.syncNow(); }
  async function discardOne(f: OutboxItem) {
    if (!confirm(`Discard this change: ${describeItem(f)}?\n\nIt will not be sent to the team sheet. The record stays on this phone as it is, and a copy of the change is kept in your backups.`)) return;
    await discardFailed(f.key);
    await sync.refresh();
    setSyncMsg({ kind: 'ok', text: `Discarded: ${describeItem(f)}. A copy is kept in backups.` });
  }
  function turnOff() {
    if (!confirm('Turn sync off on this phone? Your data stays on this phone. New changes wait here and are sent if you turn sync back on.')) return;
    sync.disable();
    setSyncMsg({ kind: 'ok', text: 'Sync is off.' });
  }
  const fmtTime = (iso?: string) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Never';
  const onCount = COLUMNS.filter((c) => settings.columns[c]).length;

  async function importCsv(file: File) {
    const res = parseBoreholesCsv(await file.text(), u);
    if (!res.rows.length) return setMsg({ kind: 'error', text: 'No boreholes imported.', details: res.errors.map((e) => `Line ${e.line}: ${e.message}`) });
    const newOnes = res.rows.filter((r) => !findName(bhMap.keys(), r.name)).length;
    if (!confirm(`Import ${res.rows.length} borehole(s): ${newOnes} new, ${res.rows.length - newOnes} updated (matched by Borehole Name)?${res.errors.length ? `\n${res.errors.length} row problem(s) will be listed.` : ''}`)) return;
    const { added, updated } = await upsertBoreholes(res.rows);
    await reload();
    setMsg({ kind: res.errors.length ? 'error' : 'ok', text: `Imported ${added} new and updated ${updated} borehole(s).`, details: res.errors.map((e) => `Line ${e.line}: ${e.message}`) });
  }
  async function restore(file: File) {
    let r;
    try { r = validateBackup(JSON.parse(await file.text())); } catch (e) { return setMsg({ kind: 'error', text: `Restore failed: ${(e as Error).message}` }); }
    const b = r.backup;
    if (sync.config.enabled && r.fromVersion < 4) return setMsg({ kind: 'error', text: `This is an older (v${r.fromVersion}) backup without sync IDs. Restoring it while sync is on would add a second copy of every record to the team sheet. Turn off sync first, or restore a backup saved by 0.4.0 or later.` });
    const note = r.fromVersion === 1 ? `\n\nThis is an older (v1) backup. It will be converted: Reading IDs assigned by date/time${r.skipped ? `, ${r.skipped} Dry/No-reading entr${r.skipped === 1 ? 'y' : 'ies'} without a depth dropped` : ''}.` : '';
    if (!confirm(`Replace ALL data on this device (${boreholes.length} boreholes, ${readings.length} readings) with the backup from ${b.exportedAt.slice(0, 10) || 'unknown date'} (${b.boreholes.length} boreholes, ${b.readings.length} readings)?${note}${sync.config.enabled ? '\n\nSync is on: the restored data will be sent to the team sheet. Nothing is deleted from the sheet, and data from other phones comes back on the next sync.' : ''}`)) return;
    await replaceAll(b.boreholes, b.readings, b.nextReadingId);
    // The User Code belongs to this phone, not the backup: keep the current one.
    setSettings({ ...b.settings, userCode: settings.userCode });
    await reload();
    setMsg({ kind: 'ok', text: `Restored ${b.boreholes.length} boreholes and ${b.readings.length} readings${r.fromVersion === 1 ? ' (converted from v1)' : ''}.` });
  }
  async function backup() {
    const next = await getNextReadingId();
    const unsynced = { failed: (await outboxStats()).failed, discarded: await getDiscarded() };
    const r = await saveFile(JSON.stringify(makeBackup(boreholes, readings, settings, next, `Water Level Log ${__APP_VERSION__}`, unsynced), null, 1), `waterlevels_backup_${todayLocal()}.json`, 'application/json');
    done('Backup')(r);
  }
  const set = (p: Partial<Settings>) => setSettings({ ...settings, ...p });
  const toggle = (c: ColumnKey) => set({ columns: { ...settings.columns, [c]: !settings.columns[c] } });
  const done = (what: string) => (r: string) => r !== 'cancelled' && setMsg({ kind: 'ok', text: `${what} ${r === 'shared' ? 'shared' : 'downloaded'}.` });

  return (
    <section className="form">
      <h2>Settings</h2>
      <label>User Code (this phone)
        <span className="ucrow">
          <input value={code} onChange={(e) => { setCode(e.target.value); setCodeMsg(undefined); }} maxLength={USER_CODE_MAX + 5} autoCapitalize="characters"
            autoCorrect="off" spellCheck={false} placeholder="e.g. OD-1" data-testid="uc-input" onKeyDown={(e) => { if (e.key === 'Enter') saveCode(); }} />
          <button type="button" className="primary" onClick={saveCode} disabled={normalizeUserCode(code) === settings.userCode} data-testid="uc-save">Save</button>
        </span>
      </label>
      <p className="muted small">Recorded on every new reading, like the date and time. Up to {USER_CODE_MAX} letters, numbers, - or _. Changing it does not alter earlier readings.</p>
      {codeMsg && <p className={codeMsg.kind === 'error' ? 'error' : 'ok'} role="status" data-testid="uc-msg">{codeMsg.text}</p>}
      <h2>Sync</h2>
      <div className="syncbox" data-testid="sync-section">
        {!sync.config.enabled ? (<>
          <p className="muted small">Share boreholes and readings with your team through a Google Sheet. Ask whoever set up the sheet for the web app URL and the team code (see SETUP-GOOGLE-SHEET.md).</p>
          <label>Web app URL
            <input value={surl} onChange={(e) => setSurl(e.target.value)} inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="https://script.google.com/macros/s/…/exec" data-testid="sync-url" />
          </label>
          <label>Team code
            <input value={steam} onChange={(e) => setSteam(e.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} autoComplete="off" data-testid="sync-team" />
          </label>
          <button type="button" className="wide primary" disabled={checking || !surl.trim() || !steam.trim()} onClick={() => void turnOn()} data-testid="sync-enable">{checking ? 'Checking…' : 'Turn on sync'}</button>
          {sync.pending > 0 && <p className="muted small">{sync.pending} change(s) on this phone will be sent when sync is on.</p>}
        </>) : (<>
          <dl>
            <dt>Status</dt><dd data-testid="sync-status">{sync.state === 'failed' ? `${sync.failed.length} failed${sync.pending ? `, ${sync.pending} waiting` : ''}` : sync.state === 'synced' ? 'All synced' : sync.state === 'syncing' ? 'Syncing…' : sync.state === 'offline' ? `Offline, ${sync.pending} waiting` : sync.state === 'error' ? `Error, ${sync.pending} waiting` : `${sync.pending} waiting`}</dd>
            <dt>Last synced</dt><dd data-testid="sync-last">{fmtTime(sync.config.lastSyncedAt)}</dd>
            <dt>Sheet</dt><dd className="small">{sync.config.url.replace(/^https:\/\//, '').slice(0, 60)}{sync.config.url.length > 68 ? '…' : ''}</dd>
          </dl>
          {sync.config.lastError && <p className="error" role="alert" data-testid="sync-error">{sync.config.lastError}</p>}
          {sync.held.length > 0 && sync.pending > 0 && <p className="muted small" data-testid="sync-held">{sync.held.length} change(s) still waiting: {[...new Set(sync.held.map((h) => h.reason))].join('; ')}.</p>}
          {sync.failed.length > 0 && (
            <div className="error failed-list" role="alert" data-testid="sync-failed">
              <p><strong>{sync.failed.length} change(s) failed.</strong> The team sheet refused them. They are still on this phone and are not sent again until you tap Retry.</p>
              <ul>
                {sync.failed.map((f) => (
                  <li key={f.key} data-testid="failed-item">
                    <span>{describeItem(f)}: <em data-testid="failed-reason">{f.failed}</em></span>
                    <span className="row-btns">
                      <button type="button" className="small" onClick={() => void retryOne(f.key)} data-testid="failed-retry">Retry</button>
                      <button type="button" className="small danger" onClick={() => void discardOne(f)} data-testid="failed-discard">Discard</button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <button type="button" className="wide primary" disabled={sync.busy} onClick={() => void sync.syncNow()} data-testid="sync-now">{sync.busy ? 'Syncing…' : 'Sync now'}</button>
          <button type="button" className="wide" onClick={turnOff} data-testid="sync-off">Turn off sync</button>
        </>)}
        {syncMsg && <p className={syncMsg.kind === 'error' ? 'error' : 'ok'} role="status" data-testid="sync-msg">{syncMsg.text}</p>}
      </div>

      <fieldset className="seg" aria-label="Units">
        <legend>Units</legend>
        {(['ft', 'm'] as const).map((x) => <button key={x} type="button" className={u === x ? 'on' : ''} aria-pressed={u === x} onClick={() => set({ unit: x })} data-testid={`unit-${x}`}>{x === 'ft' ? 'Feet' : 'Meters'}</button>)}
      </fieldset>
      <fieldset className="seg" aria-label="Theme">
        <legend>Theme</legend>
        {(['auto', 'light', 'dark'] as const).map((x) => <button key={x} type="button" className={settings.theme === x ? 'on' : ''} aria-pressed={settings.theme === x} onClick={() => set({ theme: x })}>{x === 'auto' ? 'Auto' : x === 'light' ? 'Sunlight' : 'Dark'}</button>)}
      </fieldset>

      <fieldset className="toggles" data-testid="columns">
        <legend>Report columns ({onCount} of {COLUMNS.length} on)</legend>
        <p className="muted small">Columns included in CSV exports and the readings tables, in this order. At least one must stay on.</p>
        {COLUMNS.map((c) => {
          const on = settings.columns[c];
          const last = on && onCount === 1;
          return (
            <label key={c} className="toggle">
              <span>{columnLabel(c, u)}</span>
              <input type="checkbox" role="switch" checked={on} disabled={last} onChange={() => toggle(c)} data-testid={`col-${c}`} aria-describedby={last ? 'col-last' : undefined} />
            </label>
          );
        })}
        {onCount === 1 && <p id="col-last" className="muted small">Turn another column on before turning this one off.</p>}
        {onCount < COLUMNS.length && <button type="button" className="small" onClick={() => set({ columns: Object.fromEntries(COLUMNS.map((c) => [c, true])) as Settings['columns'] })} data-testid="col-all">Turn all on</button>}
      </fieldset>

      <h2>Export</h2>
      <button className="wide" disabled={!readings.length} onClick={() => saveFile(readingsCsv(derived, u, settings.columns), csvFilename('all', todayLocal()), 'text/csv').then(done('Readings CSV'))}>Readings CSV (all)</button>
      <button className="wide" disabled={!boreholes.length} data-testid="export-boreholes" onClick={() => saveFile(boreholesCsv(boreholes, u), `boreholes_${todayLocal()}.csv`, 'text/csv').then(done('Boreholes CSV'))}>Boreholes CSV</button>

      <h2>Import boreholes</h2>
      <p className="muted small">CSV with a header row: Borehole Name, Reference Point, Reference Elevation (ft) or (m). Name and elevation are required. Existing names are updated; past readings keep their recorded values.</p>
      <button className="wide" onClick={() => csvIn.current?.click()}>Choose boreholes CSV…</button>
      <input ref={csvIn} type="file" accept=".csv,text/csv,text/plain" hidden data-testid="import-csv" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importCsv(f); }} />

      <h2>Backup</h2>
      <p className="muted small">iPhone can clear website storage. Save a backup to Files regularly.{persisted === true ? ' Persistent storage is granted.' : persisted === false ? ' Persistent storage was not granted.' : ''}</p>
      <button className="wide primary" onClick={() => void backup()} data-testid="backup">Save full backup (JSON)</button>
      <button className="wide" onClick={() => jsonIn.current?.click()}>Restore from backup…</button>
      <input ref={jsonIn} type="file" accept=".json,application/json" hidden data-testid="restore" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void restore(f); }} />

      {msg && (
        <div className={msg.kind} role="status" data-testid="data-msg">
          <p>{msg.text}</p>
          {msg.details && msg.details.length > 0 && <ul className="small">{msg.details.map((d) => <li key={d}>{d}</li>)}</ul>}
        </div>
      )}
      <p className="muted small">Water Level Log {__APP_VERSION__}. {sync.config.enabled ? 'Data is kept on this phone and shared with your team sheet.' : 'All data stays on this device; nothing is uploaded.'}</p>
    </section>
  );
}
