import { Link, useParams } from 'react-router-dom';
import { useStore } from '../store';
import { fmtLen, todayLocal } from '../lib/math';
import { csvFilename, readingsCsv } from '../lib/csv';
import { saveFile } from '../lib/share';
import TrendChart from '../TrendChart';
import ReadingsTable from '../ReadingsTable';

export default function BoreholeDetail() {
  const { name = '' } = useParams();
  const { bhMap, derived, settings } = useStore();
  const u = settings.unit;
  const b = bhMap.get(name);
  if (!b) return <p>Borehole not found. <Link to="/">Back</Link></p>;
  const rows = derived.filter((d) => d.borehole === name);
  const exportCsv = () => saveFile(readingsCsv(rows, u, settings.columns), csvFilename(name, todayLocal()), 'text/csv');
  return (
    <section>
      <div className="row between">
        <h2>{b.name}</h2>
        <Link className="btn small" to={`/borehole/${encodeURIComponent(name)}/edit`} data-testid="bh-edit">Edit</Link>
      </div>
      <dl className="facts">
        <dt>Reference point</dt><dd>{b.referencePoint}</dd>
        <dt>Reference elev.</dt><dd>{fmtLen(b.refElevationFt, u)} {u}</dd>
      </dl>
      <div className="row gap">
        <Link className="btn primary grow" to={`/reading/new?bh=${encodeURIComponent(name)}`} data-testid="add-reading">+ Reading</Link>
        <button className="grow" onClick={exportCsv} disabled={!rows.length} data-testid="export-bh-csv">Export CSV</button>
      </div>
      <TrendChart readings={rows} unit={u} />
      <ReadingsTable rows={rows} unit={u} columns={settings.columns} testid="history" />
      {!rows.length && <p className="empty">No readings yet.</p>}
      <p className="muted small">Lengths in {u}. Tap the first cell of a row to edit or delete a reading. Columns follow Settings → Report columns.</p>
    </section>
  );
}
