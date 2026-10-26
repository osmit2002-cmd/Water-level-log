import { Link } from 'react-router-dom';
import type { Columns, Unit } from './lib/types';
import { columnLabel, enabledColumns } from './lib/csv';
import { fmtLen, type DerivedReading } from './lib/math';

/** Readings table showing only the columns switched on in Settings. Tap a row's first cell to edit. */
export default function ReadingsTable({ rows, unit: u, columns, testid }: { rows: DerivedReading[]; unit: Unit; columns: Columns; testid: string }) {
  const keys = enabledColumns(columns);
  const cell = (r: DerivedReading, c: (typeof keys)[number]) => {
    switch (c) {
      case 'readingId': return `#${r.id}`;
      case 'boreholeName': return r.borehole;
      case 'date': return r.datetime.slice(0, 10);
      case 'time': return r.datetime.slice(11, 16);
      case 'referencePoint': return r.referencePoint;
      case 'refElevation': return fmtLen(r.refElevationFt, u);
      case 'depth': return fmtLen(r.depthFt, u);
      case 'waterElevation': return <b>{fmtLen(r.waterElevFt, u)}</b>;
      case 'notes': return r.notes ?? '';
    }
  };
  return (
    <div className="tablewrap">
      <table data-testid={testid}>
        <thead><tr>{keys.map((c) => <th key={c} data-col={c}>{columnLabel(c, u)}</th>)}</tr></thead>
        <tbody>
          {[...rows].reverse().map((r) => (
            <tr key={r.id} data-reading-id={r.id}>
              {keys.map((c, i) => (
                <td key={c} className={c === 'notes' ? 'notes' : undefined}>
                  {i === 0 ? <Link to={`/reading/${r.id}`} aria-label={`Edit reading #${r.id}`}>{cell(r, c) || '✎'}</Link> : cell(r, c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
