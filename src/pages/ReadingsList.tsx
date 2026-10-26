import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../store';
import { fmtLen, inDateRange, todayLocal } from '../lib/math';
import { STATUS_LABEL } from '../lib/types';
import { csvFilename, readingsCsv } from '../lib/csv';
import { saveFile } from '../lib/share';
import { Change } from '../ui';

export default function ReadingsList() {
  const { boreholes, bhMap, derived, settings } = useStore();
  const u = settings.unit;
  const [bh, setBh] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [msg, setMsg] = useState('');
  // Change is always computed over the full history; filters only choose which rows are shown/exported.
  const rows = derived.filter((d) => (!bh || d.boreholeId === bh) && inDateRange(d.datetime, from, to));
  async function exportCsv() {
    const res = await saveFile(readingsCsv(rows, bhMap, u), csvFilename(bh || 'all', todayLocal()), 'text/csv');
    setMsg(res === 'cancelled' ? '' : `Exported ${rows.length} reading(s).`);
  }
  return (
    <section>
      <h2>All readings</h2>
      <div className="filters">
        <label>Borehole
          <select value={bh} onChange={(e) => setBh(e.target.value)} data-testid="flt-bh">
            <option value="">All boreholes</option>
            {boreholes.map((b) => <option key={b.id} value={b.id}>{b.id}</option>)}
          </select>
        </label>
        <div className="row gap">
          <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="flt-from" /></label>
          <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="flt-to" /></label>
        </div>
        {(bh || from || to) && <button className="small" onClick={() => { setBh(''); setFrom(''); setTo(''); }}>Clear filters</button>}
      </div>
      <button className="primary wide" onClick={exportCsv} disabled={!rows.length} data-testid="export-csv">Export {rows.length} reading(s) to CSV</button>
      {msg && <p className="ok" role="status">{msg}</p>}
      {from && to && from > to && <p className="warn">"From" is after "To".</p>}
      <ul className="cards">
        {[...rows].reverse().map((r) => (
          <li key={r.uid}>
            <Link to={`/reading/${encodeURIComponent(r.uid)}`} className="card">
              <div className="row between"><strong>{r.boreholeId}</strong><span className="muted">{r.datetime.replace('T', ' ')}</span></div>
              {r.status === 'ok'
                ? <div className="row between"><span>Depth {fmtLen(r.depthFt, u)} · Elev <b>{fmtLen(r.waterElevFt, u)}</b> {u}</span><Change ft={r.changeFt} unit={u} /></div>
                : <span className="badge">{STATUS_LABEL[r.status]}</span>}
              {(r.reader || r.notes) && <div className="muted small">{[r.reader, r.notes].filter(Boolean).join(' · ')}</div>}
            </Link>
          </li>
        ))}
      </ul>
      {!rows.length && <p className="empty">No readings match.</p>}
    </section>
  );
}
