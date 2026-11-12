import React from 'react';
import { topAlerts, day, daysBetween } from '../geo.js';

// Flood alert cards. Clicking a card (or its Pledge button) opens that area's page.
export default function Hotspots({ events, error, limit = 4, onOpen }) {
  if (error) return <div className="empty">Flood feed unavailable.</div>;
  if (!events) return <div className="hot-grid">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 230, borderRadius: 12 }} />)}</div>;
  const list = topAlerts(events, limit);
  if (!list.length) return <div className="empty">No active floods reported.</div>;
  return (
    <div className="hot-grid">
      {list.map((e, i) => (
        <article key={e.id} className={`hot ${e.alert.toLowerCase()}`} role="button" tabIndex={0} onClick={() => onOpen(e)} onKeyDown={(k) => { if (k.key === 'Enter') onOpen(e); }}>
          <div className="hot-top"><span className="hot-rank mono">0{i + 1}</span><span className={`alert-pill ${e.alert.toLowerCase()}`}>{e.alert} alert</span></div>
          <h3>{e.country}</h3>
          <div className="hot-name">{e.name}</div>
          <dl>
            <div><dt>Severity</dt><dd>{e.severityText || '–'}</dd></div>
            <div><dt>Alert score</dt><dd className="mono">{e.score != null ? e.score.toFixed(1) : '–'}</dd></div>
            <div><dt>Since</dt><dd>{day(e.from)}</dd></div>
            <div><dt>Duration</dt><dd>{daysBetween(e.from, e.to) ? `${daysBetween(e.from, e.to)} days` : '–'}</dd></div>
            <div><dt>Location</dt><dd className="mono">{e.lat.toFixed(2)}, {e.lng.toFixed(2)}</dd></div>
          </dl>
          <button type="button" className="hot-cta" onClick={(k) => { k.stopPropagation(); onOpen(e); }}>Pledge / Donate →</button>
        </article>
      ))}
    </div>
  );
}
