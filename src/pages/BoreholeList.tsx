import { displayId } from '../lib/ids';
import { Link } from 'react-router-dom';
import { useStore } from '../store';
import { fmtLen, latestPerBorehole } from '../lib/math';

export default function BoreholeList() {
  const { boreholes, derived, settings } = useStore();
  const u = settings.unit;
  const latest = latestPerBorehole(derived);
  return (
    <section>
      <div className="row between">
        <h2>Boreholes ({boreholes.length})</h2>
        <Link className="btn" to="/new-borehole" data-testid="add-borehole">+ Borehole</Link>
      </div>
      {boreholes.length === 0 && <p className="empty">No boreholes yet. Add one, or import a boreholes CSV under <Link to="/settings">Settings</Link>.</p>}
      <ul className="cards" data-testid="borehole-list">
        {boreholes.map((b) => {
          const l = latest.get(b.name);
          return (
            <li key={b.name}>
              <Link to={`/borehole/${encodeURIComponent(b.name)}`} className="card">
                <div className="row between"><strong>{b.name}{b.flag && <span className="flag-dot" title={b.flag} data-testid="bh-flag-dot"> ⚑</span>}</strong><span className="muted small">{b.referencePoint} {fmtLen(b.refElevationFt, u)} {u}</span></div>
                {l ? (
                  <div className="row between big">
                    <span>{fmtLen(l.waterElevFt, u)} {u}</span>
                    <span className="muted small">depth {fmtLen(l.depthFt, u)}</span>
                  </div>
                ) : <div className="muted">No water level yet</div>}
                <div className="muted small">{l ? `Reading ${displayId(l)} · ${l.datetime.replace('T', ' ')}` : ''}</div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
