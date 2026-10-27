import { displayId } from '../lib/ids';
import { Link } from 'react-router-dom';
import { useStore } from '../store';
import { fmtLen, latestPerBorehole } from '../lib/math';
import { useState } from 'react';
import { scopeOf } from '../lib/types';
import { ScopeBadge } from '../Scope';

export default function BoreholeList() {
  const { boreholes, derived, settings } = useStore();
  const u = settings.unit;
  const latest = latestPerBorehole(derived);
  const [showHidden, setShowHidden] = useState(false);
  const hiddenN = boreholes.filter((b) => b.hidden).length;
  const list = boreholes.filter((b) => showHidden || !b.hidden);
  return (
    <section>
      <div className="row between">
        <h2>Boreholes ({list.length})</h2>
        <Link className="btn" to="/new-borehole" data-testid="add-borehole">+ Borehole</Link>
      </div>
      {boreholes.length === 0 && <p className="empty">No boreholes yet. Add one, or import a boreholes CSV under <Link to="/settings">Settings</Link>.</p>}
      <ul className="cards" data-testid="borehole-list">
        {list.map((b) => {
          const l = latest.get(b.name);
          return (
            <li key={b.name}>
              <Link to={`/borehole/${encodeURIComponent(b.name)}`} className="card">
                <div className="row between"><strong>{b.name}{b.flag && <span className="flag-dot" title={b.flag} data-testid="bh-flag-dot"> ⚑</span>}</strong><span className="muted small"><ScopeBadge scope={scopeOf(b)} />{b.hidden ? ' hidden' : ''} {b.referencePoint} {fmtLen(b.refElevationFt, u)} {u}</span></div>
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
      {hiddenN > 0 && <button className="wide" onClick={() => setShowHidden(!showHidden)} data-testid="show-hidden">{showHidden ? 'Hide hidden boreholes' : `Show hidden (${hiddenN})`}</button>}
    </section>
  );
}
