import { useState } from 'react';
import { useStore } from '../store';
import { inDateRange, todayLocal } from '../lib/math';
import { csvFilename, readingsCsv } from '../lib/csv';
import { saveFile } from '../lib/share';
import ReadingsTable from '../ReadingsTable';

export default function ReadingsList() {
  const { boreholes, bhMap, derived, settings } = useStore();
  const u = settings.unit;
  const [bh, setBh] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [msg, setMsg] = useState('');
  const bhOk = !bh || bhMap.has(bh) ? bh : '';
  const rows = derived.filter((d) => (!bhOk || d.borehole === bhOk) && inDateRange(d.datetime, from, to));
  async function exportCsv() {
    const res = await saveFile(readingsCsv(rows, u, settings.columns), csvFilename(bhOk || 'all', todayLocal()), 'text/csv');
    setMsg(res === 'cancelled' ? '' : `Exported ${rows.length} reading(s).`);
  }
  return (
    <section>
      <h2>All readings</h2>
      <div className="filters">
        <label>Borehole Name
          <select value={bhOk} onChange={(e) => setBh(e.target.value)} data-testid="flt-bh">
            <option value="">All boreholes</option>
            {boreholes.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
        </label>
        <div className="row gap">
          <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="flt-from" /></label>
          <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="flt-to" /></label>
        </div>
        {(bhOk || from || to) && <button className="small" onClick={() => { setBh(''); setFrom(''); setTo(''); }}>Clear filters</button>}
      </div>
      <button className="primary wide" onClick={exportCsv} disabled={!rows.length} data-testid="export-csv">Export {rows.length} reading(s) to CSV</button>
      {msg && <p className="ok" role="status">{msg}</p>}
      {from && to && from > to && <p className="warn">"From" is after "To".</p>}
      {rows.length > 0 && <ReadingsTable rows={rows} unit={u} columns={settings.columns} testid="readings-table" />}
      {!rows.length && <p className="empty">No readings match.</p>}
    </section>
  );
}
