import React from 'react';
import { usd, ratio, ago } from '../format.js';

export function statusOf(d, fc) {
  if (d.status === 'TRIGGERED') return { key: 'triggered', label: 'Triggered' };
  if (d.status === 'RELEASED') return { key: 'released', label: 'Released' };
  if (fc && !fc.live?.series && fc.live?.error) return { key: 'unavailable', label: 'Data unavailable' };
  return { key: 'watching', label: 'Watching' };
}

export function effectiveEval(d, fc) {
  if (d.trigger) return { ev: d.trigger.evaluation, sim: d.trigger.simulated };
  if (fc?.simulated) return { ev: fc.simulated.evaluation, sim: true };
  return { ev: fc?.live?.evaluation ?? null, sim: false };
}

export default function Board({ districts, forecasts, selected, onSelect }) {
  return (
    <div className="board">
      {districts.map((d) => {
        const fc = forecasts[d.id];
        const st = statusOf(d, fc);
        const { ev, sim } = effectiveEval(d, fc);
        const r = ev?.ratio;
        const scaleMax = Math.max(d.threshold * 1.45, (r ?? 0) * 1.05);
        const pct = r != null ? Math.min(100, (r / scaleMax) * 100) : 0;
        const markPct = (d.threshold / scaleMax) * 100;
        return (
          <button key={d.id} type="button" className={`card ${selected === d.id ? 'selected' : ''}`} onClick={() => onSelect(d.id)} aria-pressed={selected === d.id}>
            <div className="card-top">
              <div style={{ minWidth: 0 }}>
                <div className="card-name">{d.name}</div>
                <div className="card-meta">{d.region}, {d.country} · {d.river}</div>
              </div>
              <span className={`status ${st.key}`}>{st.label}</span>
            </div>
            <div>
              <div className="ratio-row">
                {fc === undefined ? <span className="skeleton" style={{ width: 80, height: 28, display: 'inline-block' }} />
                  : <span className="ratio" style={{ color: ev?.trigger ? 'var(--danger)' : undefined }}>{ratio(r)}</span>}
                <span className="ratio-unit">peak / 30-day median</span>
                {sim && <span className="tag-sim" style={{ marginLeft: 'auto' }}>Scenario</span>}
              </div>
              <div className="gauge" style={{ marginTop: 8 }} aria-hidden="true">
                <div className={`gauge-fill ${sim ? 'sim' : ev?.trigger ? 'hot' : ''}`} style={{ width: `${pct}%` }} />
                <div className="gauge-mark" style={{ left: `${markPct}%` }} title={`Danger threshold ${d.threshold}`} />
              </div>
            </div>
            <div className="card-figures">
              <span className="l">Danger threshold</span><span className="v">{d.threshold.toFixed(2)}×</span>
              <span className="l">Held (authorized)</span><span className="v">{usd(d.totals.heldCents)}</span>
              <span className="l">Captured</span><span className="v">{usd(d.totals.capturedCents)}</span>
            </div>
            <div className="card-foot">
              <span>{fc?.live?.fetchedAt ? `Forecast ${ago(fc.live.fetchedAt)}${fc.live.stale ? ' (stale)' : ''}` : fc?.live?.error ? 'Forecast unavailable' : 'Loading forecast'}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
