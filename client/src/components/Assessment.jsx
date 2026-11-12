import React, { Suspense, lazy } from 'react';

const Schedule = lazy(() => import('./Schedule.jsx'));

export default function Assessment({ district: d, licenseKey }) {
  const ev = d.trigger ? { ...(d.lastEvaluation || { valid: true }), assessment: d.trigger.assessment, simulated: d.trigger.simulated } : d.lastEvaluation;
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

  return (
    <div className="assess">
      <div className="panel">
        <div className="panel-head">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="panel-title">Risk assessment</span>
            <span className={`sev ${a.severity}`}>{a.severity}</span>
            {ev.simulated ? <span className="tag-sim">Scenario</span> : <span className="tag-live">Live forecast</span>}
          </div>
        </div>
        <div className="panel-pad">
          <p className="rationale" style={{ marginTop: 0 }}>{a.rationale}</p>
          <div className="alerts">
            <div className="alert-box"><div className="eyebrow">Alert · English</div><p>{a.alertEnglish}</p></div>
            <div className="alert-box local" lang={d.language.code} dir={d.language.dir || 'ltr'}><div className="eyebrow">Alert · {d.language.name}</div><p>{a.alertLocal}</p></div>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><span className="panel-title">Response and payment schedule</span><span className="muted" style={{ fontSize: 12 }}>Bryntum Scheduler</span></div>
        {licenseKey && d.trigger ? (
          <Suspense fallback={<div className="muted" style={{ padding: 18 }}><span className="spinner" /> Loading schedule…</div>}>
            <Schedule district={d} assessment={a} licenseKey={licenseKey} />
          </Suspense>
        ) : (
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
        )}
      </div>
    </div>
  );
}
