import { Link, useParams } from 'react-router-dom';
import { useStore } from '../store';
import { fmtLen, todayLocal } from '../lib/math';
import { STATUS_LABEL } from '../lib/types';
import { csvFilename, readingsCsv } from '../lib/csv';
import { saveFile } from '../lib/share';
import { Change } from '../ui';
import TrendChart from '../TrendChart';

export default function BoreholeDetail() {
  const { id = '' } = useParams();
  const { bhMap, derived, settings } = useStore();
  const u = settings.unit;
  const b = bhMap.get(id);
  if (!b) return <p>Borehole not found. <Link to="/">Back</Link></p>;
  const rows = derived.filter((d) => d.boreholeId === id);
  const exportCsv = () => saveFile(readingsCsv(rows, bhMap, u), csvFilename(id, todayLocal()), 'text/csv');
  return (
    <section>
      <div className="row between">
        <h2>{b.id}{b.name !== b.id ? ` · ${b.name}` : ''}</h2>
        <Link className="btn small" to={`/borehole/${encodeURIComponent(id)}/edit`}>Edit</Link>
      </div>
      <dl className="facts">
        <dt>{b.referencePoint} elev.</dt><dd>{fmtLen(b.refElevationFt, u)} {u}</dd>
        {b.totalDepthFt != null && <><dt>Total depth</dt><dd>{fmtLen(b.totalDepthFt, u)} {u}</dd></>}
        {b.location && <><dt>Location</dt><dd>{b.location}</dd></>}
        {b.lat != null && b.lon != null && <><dt>Lat/long</dt><dd>{b.lat}, {b.lon}</dd></>}
        {b.notes && <><dt>Notes</dt><dd>{b.notes}</dd></>}
      </dl>
      <div className="row gap">
        <Link className="btn primary grow" to={`/reading/new?bh=${encodeURIComponent(id)}`} data-testid="add-reading">+ Reading</Link>
        <button className="grow" onClick={exportCsv} disabled={!rows.length} data-testid="export-bh-csv">Export CSV</button>
      </div>
      <TrendChart readings={rows} unit={u} />
      <div className="tablewrap">
        <table data-testid="history">
          <thead><tr><th>Date</th><th>Depth</th><th>Water elev.</th><th>Change</th></tr></thead>
          <tbody>
            {[...rows].reverse().map((r) => (
              <tr key={r.uid}>
                <td><Link to={`/reading/${encodeURIComponent(r.uid)}`}>{r.datetime.replace('T', ' ')}</Link>{r.reader && <div className="muted small">{r.reader}</div>}</td>
                {r.status === 'ok' ? <><td>{fmtLen(r.depthFt, u)}</td><td>{fmtLen(r.waterElevFt, u)}</td></> : <td colSpan={2}><span className="badge">{STATUS_LABEL[r.status]}</span></td>}
                <td>{r.status === 'ok' ? <Change ft={r.changeFt} unit={u} /> : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p className="empty">No readings yet.</p>}
      </div>
      <p className="muted small">Lengths in {u}. Tap a date to edit or delete a reading.</p>
    </section>
  );
}
