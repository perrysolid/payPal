import React from 'react';

export default function Assessment({ district: d }) {
  const ev = d.trigger ? { ...d.lastEvaluation, assessment: d.trigger.assessment, simulated: d.trigger.simulated } : d.lastEvaluation;
  if (!ev) return null;
  if (!ev.valid) {
    return <div className="panel" style={{ marginTop: 16 }}><div className="inline-error">Evaluation could not run: {ev.issues?.join('; ')}. No trigger decision was made and no money moved.</div></div>;
  }
  const a = ev.assessment;
  if (!a) return null;
  const steps = [...a.responseSteps].sort((x, y) => x.startHourOffset - y.startHourOffset);
  const minH = Math.min(0, ...steps.map((s) => s.startHourOffset));
  const maxH = Math.max(24, ...steps.map((s) => s.startHourOffset + s.durationHours));
  const span = maxH - minH;
  const offline = a.source !== 'claude';
  const totalW = d.households.reduce((acc, h) => acc + (a.zoneWeights[h.zone] ?? 0) * h.members, 0);

  return (
    <div className="assess">
      <div className="panel">
        <div className="panel-head">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="panel-title">Risk assessment</span>
            <span className={`sev ${a.severity}`}>{a.severity}</span>
            {ev.simulated ? <span className="tag-sim">SIMULATED FORECAST</span> : <span className="tag-live">LIVE FORECAST</span>}
          </div>
          <span className={`source-line ${offline ? 'offline' : ''}`} title={a.fallbackReason || ''}>{a.sourceLabel}</span>
        </div>
        <div className="panel-pad">
          <p className="rationale" style={{ marginTop: 0 }}>{a.rationale}</p>
          {offline && a.fallbackReason && <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>Reason: {a.fallbackReason}</p>}
          <div className="alerts">
            <div className="alert-box"><div className="eyebrow">Alert · English</div><p>{a.alertEnglish}</p></div>
            <div className="alert-box local" lang={d.language.code}><div className="eyebrow">Alert · {d.language.name}</div><p>{a.alertLocal}</p></div>
          </div>
          <div style={{ marginTop: 14 }}>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Suggested zone weights (code computes the amounts)</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {['A', 'B', 'C'].map((z) => {
                const members = d.households.filter((h) => h.zone === z).reduce((s, h) => s + h.members, 0);
                const share = totalW ? ((a.zoneWeights[z] * members) / totalW) * 100 : 0;
                return (
                  <div key={z} className="alert-box" style={{ flex: '1 1 120px' }}>
                    <span className={`zone-pill ${z}`}>Zone {z}</span>
                    <div className="mono" style={{ fontSize: 16, marginTop: 4 }}>{a.zoneWeights[z].toFixed(2)}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>{members} people · {share.toFixed(1)}% of funds</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><span className="panel-title">Response timeline</span><span className="muted" style={{ fontSize: 12 }}>hours from assessment</span></div>
        <div className="timeline">
          <div className="tl-axis">{[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f}>{Math.round(minH + f * span)}h</span>)}</div>
          {steps.map((s, i) => (
            <div className="tl-row" key={i}>
              <div className="tl-label">{s.title}<div className="o">{s.owner}</div></div>
              <div className="tl-track">
                <div className="tl-bar" style={{ left: `${((s.startHourOffset - minH) / span) * 100}%`, width: `${Math.max(1.5, (s.durationHours / span) * 100)}%`, background: i === 0 ? 'var(--danger)' : undefined }} title={`+${s.startHourOffset}h for ${s.durationHours}h`} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
