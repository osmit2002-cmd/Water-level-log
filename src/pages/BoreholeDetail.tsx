import { localCopyName, makeLocalCopy, saveBorehole, setHidden, shareBorehole } from '../lib/db';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useState } from 'react';
import { scopeOf } from '../lib/types';
import { ScopeBadge } from '../Scope';
import { useSync } from '../sync/useSync';
import { useStore } from '../store';
import { fmtLen, todayLocal } from '../lib/math';
import { csvFilename, readingsCsv } from '../lib/csv';
import { saveFile } from '../lib/share';
import TrendChart from '../TrendChart';
import ReadingsTable from '../ReadingsTable';

export default function BoreholeDetail() {
  const { name = '' } = useParams();
  const { bhMap, derived, settings, reload } = useStore();
  const u = settings.unit;
  const b = bhMap.get(name);
  const nav = useNavigate();
  const { config } = useSync();
  const [dlg, setDlg] = useState<'' | 'share' | 'copy'>('');
  const [copyName, setCopyName] = useState('');
  const [hide, setHide] = useState(true);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (!b) return <p>Borehole not found. <Link to="/">Back</Link></p>;
  const rows = derived.filter((d) => d.borehole === name);
  const scope = scopeOf(b);
  const syncOn = config.enabled && !!config.url;
  const open = (d: typeof dlg) => { setErr(''); setMsg(''); setDlg(d); if (d === 'copy') { setCopyName(localCopyName(bhMap.keys(), name)); setHide(true); } };
  const doShare = async () => {
    setBusy(true);
    try { const n = await shareBorehole(name); await reload(); setDlg(''); setMsg(`${name} is now Shared. ${n} reading(s) ${syncOn ? 'are uploading' : 'will upload when sync is turned on'}.`); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const doCopy = async () => {
    const nn = copyName.trim();
    if (!nn) return setErr('Copy name is required');
    if (bhMap.has(nn)) return setErr(`A borehole named "${nn}" already exists.`);
    setBusy(true);
    try { await makeLocalCopy(name, nn, hide); await reload(); setDlg(''); nav(`/borehole/${encodeURIComponent(nn)}`); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const exportCsv = () => saveFile(readingsCsv(rows, u, settings.columns), csvFilename(name, todayLocal()), 'text/csv');
  return (
    <section>
      <div className="row between">
        <h2>{b.name}</h2>
        <Link className="btn small" to={`/borehole/${encodeURIComponent(name)}/edit`} data-testid="bh-edit">Edit</Link>
      </div>
      <p className="scope-row" data-testid="bh-scope"><ScopeBadge scope={scope} long /></p>
      {b.hidden && (
        <div className="flag" role="status" data-testid="bh-hidden">
          <p>This Shared borehole is hidden on this phone. It still syncs; nothing was deleted.</p>
          <button type="button" className="small" data-testid="bh-unhide" onClick={async () => { await setHidden(name, false); await reload(); }}>Show again</button>
        </div>
      )}
      {msg && <p className="ok" role="status" data-testid="conv-msg">{msg}</p>}
      {b.flag && (
        <div className="flag" role="status" data-testid="bh-flag">
          <p>⚑ {b.flag}</p>
          <button type="button" className="small" data-testid="bh-flag-clear" onClick={async () => { await saveBorehole({ ...b, flag: '', updatedAt: new Date().toISOString() }, b.name); await reload(); }}>Mark checked</button>
        </div>
      )}
      <dl className="facts">
        <dt>Reference point</dt><dd>{b.referencePoint}</dd>
        <dt>Reference elev.</dt><dd>{fmtLen(b.refElevationFt, u)} {u}</dd>
      </dl>
      <div className="row gap">
        <Link className="btn primary grow" to={`/reading/new?bh=${encodeURIComponent(name)}`} data-testid="add-reading">+ Reading</Link>
        <button className="grow" onClick={exportCsv} disabled={!rows.length} data-testid="export-bh-csv">Export CSV</button>
      </div>
      {!dlg && (scope === 'local'
        ? <button className="wide" onClick={() => open('share')} data-testid="conv-share">Share this borehole…</button>
        : <button className="wide" onClick={() => open('copy')} data-testid="conv-copy">Make a local copy…</button>)}
      {dlg === 'share' && (
        <div className="confirm" role="dialog" aria-label="Share this borehole" data-testid="conv-share-dlg">
          <p><b>Share {name}?</b></p>
          <p>The borehole and all {rows.length} reading(s) will be uploaded to the team sheet {syncOn ? 'now' : 'when sync is turned on'}, and everyone on the team will see them.</p>
          <p className="muted small">To keep a private version later, use "Make a local copy". Shared data can't be un-shared from the sheet.</p>
          {err && <p className="error" role="alert">{err}</p>}
          <div className="row gap">
            <button className="primary grow" disabled={busy} onClick={doShare} data-testid="conv-share-ok">Share</button>
            <button className="grow" disabled={busy} onClick={() => setDlg('')} data-testid="conv-cancel">Cancel</button>
          </div>
        </div>
      )}
      {dlg === 'copy' && (
        <div className="confirm" role="dialog" aria-label="Make a local copy" data-testid="conv-copy-dlg">
          <p><b>Make a Local copy of {name}</b></p>
          <p>Copies the borehole and its {rows.length} reading(s) into a new Local borehole on this phone. The Shared one stays on the team sheet and keeps syncing; nothing is deleted.</p>
          <label>Copy name<input value={copyName} onChange={(e) => setCopyName(e.target.value)} data-testid="conv-copy-name" /></label>
          <label className="check"><input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} data-testid="conv-copy-hide" /> Hide the Shared one on this phone</label>
          {err && <p className="error" role="alert" data-testid="conv-err">{err}</p>}
          <div className="row gap">
            <button className="primary grow" disabled={busy} onClick={doCopy} data-testid="conv-copy-ok">Make copy</button>
            <button className="grow" disabled={busy} onClick={() => setDlg('')} data-testid="conv-cancel">Cancel</button>
          </div>
        </div>
      )}
      <TrendChart readings={rows} unit={u} />
      <ReadingsTable rows={rows} unit={u} columns={settings.columns} testid="history" />
      {!rows.length && <p className="empty">No readings yet.</p>}
      <p className="muted small">Lengths in {u}. Tap the first cell of a row to edit or delete a reading. Columns follow Settings → Report columns.</p>
    </section>
  );
}
