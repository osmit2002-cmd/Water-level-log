import { Link } from 'react-router-dom';
import { useStore } from '../store';
import { fmtLen, latestPerBorehole } from '../lib/math';
import { STATUS_LABEL } from '../lib/types';
import { Change } from '../ui';

export default function BoreholeList() {
  const { boreholes, derived, settings } = useStore();
  const u = settings.unit;
  const latest = latestPerBorehole(derived);
  const lastAny = new Map(derived.map((d) => [d.boreholeId, d]));
  return (
    <section>
      <div className="row between">
        <h2>Boreholes ({boreholes.length})</h2>
        <Link className="btn" to="/new-borehole" data-testid="add-borehole">+ Borehole</Link>
      </div>
      {boreholes.length === 0 && <p className="empty">No boreholes yet. Add one, or import a boreholes CSV under <Link to="/settings">Data</Link>.</p>}
      <ul className="cards" data-testid="borehole-list">
        {boreholes.map((b) => {
          const l = latest.get(b.id);
          const any = lastAny.get(b.id);
          return (
            <li key={b.id}>
              <Link to={`/borehole/${encodeURIComponent(b.id)}`} className="card">
                <div className="row between"><strong>{b.id}</strong><span className="muted">{b.name !== b.id ? b.name : ''}</span></div>
                {l ? (
                  <div className="row between big">
                    <span>{fmtLen(l.waterElevFt, u)} {u}</span>
                    <Change ft={l.changeFt} unit={u} />
                  </div>
                ) : <div className="muted">No water level yet</div>}
                <div className="muted small">
                  {l ? `Last level ${l.datetime.replace('T', ' ')}` : ''}
                  {any && any !== l ? ` · latest: ${STATUS_LABEL[any.status]} ${any.datetime.replace('T', ' ')}` : ''}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
