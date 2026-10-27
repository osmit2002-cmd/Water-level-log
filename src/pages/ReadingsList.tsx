import { useState } from 'react';
import { useStore } from '../store';
import { inDateRange, todayLocal } from '../lib/math';
import { csvFilename, readingsCsv } from '../lib/csv';
import { saveFile } from '../lib/share';
import ReadingsTable from '../ReadingsTable';
import { inScope, LIST_SCOPE, loadScope, saveScope, ScopeSwitch, type ScopeFilter } from '../Scope';

export default function ReadingsList() {
  const { boreholes, bhMap, derived, settings } = useStore();
  const u = settings.unit;
  const [bh, setBh] = useState('');
  // 0.5.0: Local / Shared / All, remembered on this phone. Boreholes hidden on this phone are left out.
  const [scope, setScopeState] = useState<ScopeFilter>(() => loadScope(LIST_SCOPE, ['local', 'shared', 'all'] as const, 'all'));
  const setScope = (v: ScopeFilter) => { setScopeState(v); saveScope(LIST_SCOPE, v); };
  const shown = boreholes.filter((b) => inScope(b, scope));
  const shownNames = new Set(shown.map((b) => b.name));
  const visible = new Set(boreholes.filter((b) => !b.hidden).map((b) => b.name));
  const count = (f: ScopeFilter) => derived.filter((d) => visible.has(d.borehole) && (f === 'all' || d.scope === f)).length;
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [msg, setMsg] = useState('');
  const bhOk = bh && bhMap.has(bh) && shownNames.has(bh) ? bh : '';
  const rows = derived.filter((d) => shownNames.has(d.borehole) && (!bhOk || d.borehole === bhOk) && inDateRange(d.datetime, from, to));
  const hidden = boreholes.filter((b) => b.hidden).length;
  async function exportCsv() {
    const res = await saveFile(readingsCsv(rows, u, settings.columns), csvFilename(bhOk || (scope === 'all' ? 'all' : scope), todayLocal()), 'text/csv');
    setMsg(res === 'cancelled' ? '' : `Exported ${rows.length} reading(s).`);
  }
  return (
    <section>
      <h2>All readings</h2>
      <div className="filters">
        <ScopeSwitch label="Show readings from" value={scope} options={['local', 'shared', 'all'] as const} onChange={setScope} testid="flt-scope"
          counts={{ local: count('local'), shared: count('shared'), all: count('all') }} />
        <label>Borehole Name
          <select value={bhOk} onChange={(e) => setBh(e.target.value)} data-testid="flt-bh">
            <option value="">All boreholes</option>
            {shown.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          </select>
        </label>
        <div className="row gap">
          <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="flt-from" /></label>
          <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="flt-to" /></label>
        </div>
        {(bhOk || from || to) && <button className="small" onClick={() => { setBh(''); setFrom(''); setTo(''); }}>Clear filters</button>}
      </div>
      <p className="muted small" data-testid="readings-total">{rows.length} of {derived.length} reading(s) on this phone{hidden ? ` · ${hidden} hidden borehole(s) left out` : ''}.</p>
      <button className="primary wide" onClick={exportCsv} disabled={!rows.length} data-testid="export-csv">Export {rows.length} reading(s) to CSV</button>
      {msg && <p className="ok" role="status">{msg}</p>}
      {from && to && from > to && <p className="warn">"From" is after "To".</p>}
      {rows.length > 0 && <ReadingsTable rows={rows} unit={u} columns={settings.columns} testid="readings-table" />}
      {!rows.length && <p className="empty">No readings match.</p>}
    </section>
  );
}
