import React, { useEffect, useState } from 'react';
import { nearestDistrict, topAlerts, day, daysBetween } from '../geo.js';

// Story text is assembled only from GDACS fields and Floodgate's own forecast data.
function story(ev, districts, forecasts) {
  const n = daysBetween(ev.from, ev.to);
  const near = nearestDistrict(districts, ev);
  const paras = [
    `GDACS lists a ${ev.alert.toLowerCase()}-level flood alert for ${ev.country}, centred near ${ev.lat.toFixed(2)}°, ${ev.lng.toFixed(2)}°. The event began on ${day(ev.from)} and is tracked through ${day(ev.to)}${n ? `, ${n} day${n > 1 ? 's' : ''} in all` : ''}.`,
    `Reported severity: ${ev.severityText || 'not rated'}. Alert score ${ev.score != null ? ev.score.toFixed(1) : 'n/a'} on the GDACS scale.`,
  ];
  if (near && near.km < 1500) {
    const r = forecasts?.[near.district.id]?.live?.evaluation?.ratio;
    paras.push(`The nearest Floodgate river district is ${near.district.name}, ${Math.round(near.km)} km away.${r != null ? ` Its GloFAS forecast peak stands at ${r.toFixed(2)}× the 30-day median against a ${near.district.threshold.toFixed(2)}× danger threshold.` : ''}`);
  } else {
    paras.push('No Floodgate river district lies within 1,500 km of this event.');
  }
  return { head: ev.name, deck: `${ev.alert} alert · ${ev.severityText || 'severity not rated'}`, paras };
}

export default function LiveFloods({ floods, districts, forecasts }) {
  const events = topAlerts(floods?.events ?? []);
  const [i, setI] = useState(0);
  useEffect(() => {
    if (events.length < 2) return undefined;
    const t = setInterval(() => setI((x) => (x + 1) % events.length), 7000);
    return () => clearInterval(t);
  }, [events.length]);

  if (floods?.error) return <div className="empty">Flood feed unavailable.</div>;
  if (!floods) return <div className="lf-grid"><div className="skeleton" style={{ height: 600, borderRadius: 22 }} /><div className="skeleton" style={{ height: 600, borderRadius: 12 }} /></div>;
  if (!events.length) return <div className="empty">No active floods reported.</div>;
  const ev = events[i % events.length];
  const s = story(ev, districts, forecasts);

  return (
    <div className="lf-grid">
      <div className="lf-left">
        <h2 className="lf-title">Live floods</h2>
        <div className="ladder" role="list">
          {events.map((e, k) => (
            <button type="button" key={e.id} role="listitem" className={`rung ${k === i ? 'on' : ''}`} onClick={() => setI(k)}>
              <i className={`fl-dot ${e.alert.toLowerCase()}`} />
              <span>{e.country}</span>
            </button>
          ))}
        </div>
      </div>

      <article className="gazette" key={ev.id}>
        <header>
          <div className="gz-name">The Flood Gazette</div>
          <div className="gz-meta"><span>{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span><span>Source: GDACS</span></div>
        </header>
        <div className="gz-flash"><span className="gz-live">Live</span> Flood watch · {i + 1} of {events.length}</div>
        <h3>{s.head}</h3>
        <div className="gz-deck">{s.deck}</div>
        <div className="gz-body">{s.paras.map((p) => <p key={p.slice(0, 24)}>{p}</p>)}</div>
        <footer>Updated {floods.fetchedAt ? new Date(floods.fetchedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}{floods.stale ? ' (stale)' : ''}</footer>
      </article>
    </div>
  );
}
