import React, { useEffect, useRef, useState } from 'react';
import Chart from './Chart.jsx';
import PayPalButtons from './PayPalButtons.jsx';
import { statusOf } from './Board.jsx';
import { usd, m3s, ratio, ago, shortDate } from '../format.js';

const PRESETS = ['10.00', '25.00', '50.00', '100.00'];

export default function Detail({ district: d, forecast: fc, config, busy, actions, onRefreshForecast }) {
  const st = statusOf(d, fc);
  const hasSim = Boolean(fc?.simulated);
  const atTrigger = d.trigger;
  const [view, setView] = useState('auto');
  useEffect(() => setView('auto'), [d.id]);
  const effectiveView = view === 'auto' ? (atTrigger ? 'trigger' : hasSim ? 'sim' : 'live') : view;

  let series = fc?.live?.series ?? null;
  let simSeries = null;
  let ev = fc?.live?.evaluation ?? null;
  let isSim = false;
  if (effectiveView === 'sim' && hasSim) { simSeries = fc.simulated.series; ev = fc.simulated.evaluation; isSim = true; }
  if (effectiveView === 'trigger' && atTrigger) {
    if (atTrigger.simulated) { series = fc?.live?.series ?? atTrigger.series; simSeries = atTrigger.series; isSim = true; }
    else series = atTrigger.series;
    ev = atTrigger.evaluation;
  }
  const baseline = ev?.baseline ?? fc?.live?.evaluation?.baseline;

  return (
    <div className="detail">
      <div className="panel">
        <div className="panel-head">
          <div style={{ minWidth: 0 }}>
            <div className="eyebrow">{d.basin} basin · {d.region}, {d.country}</div>
            <h3 className="detail-title">{d.name}</h3>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {isSim ? <span className="tag-sim">Scenario</span> : series ? <span className="tag-live">Live forecast</span> : null}
            <span className={`status ${st.key}`}>{st.label}</span>
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 18px 0', gap: 10, flexWrap: 'wrap' }}>
          <div className="chart-tabs" role="tablist" aria-label="Forecast view">
            <button type="button" className={effectiveView === 'live' ? 'on' : ''} onClick={() => setView('live')} disabled={!fc?.live?.series}>Live forecast</button>
            <button type="button" className={effectiveView === 'sim' ? 'on' : ''} onClick={() => setView('sim')} disabled={!hasSim}>Scenario</button>
            <button type="button" className={effectiveView === 'trigger' ? 'on' : ''} onClick={() => setView('trigger')} disabled={!atTrigger}>At trigger</button>
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {fc?.live?.fetchedAt ? <>Open-Meteo GloFAS · refreshed {ago(fc.live.fetchedAt)} · grid {fc.live.grid.lat.toFixed(3)}, {fc.live.grid.lon.toFixed(3)} </> : null}
            <button type="button" className="btn secondary" style={{ width: 'auto', padding: '3px 8px', fontSize: 12, marginLeft: 6 }} onClick={onRefreshForecast}>Refresh</button>
          </div>
        </div>

        {fc?.live?.error && <div className="inline-error">{fc.live.error} {fc.live.series ? '' : 'No forecast values are shown because none were received; Floodgate never fabricates live data.'}</div>}

        <div className="chart-wrap">
          {series ? (
            <Chart live={series} simulated={simSeries ? { forecast: simSeries.forecast } : null} showSim={Boolean(simSeries)} baseline={baseline} threshold={d.threshold} />
          ) : fc === undefined ? <div className="skeleton" style={{ height: 280 }} /> : <div className="empty">Forecast data unavailable for this district.</div>}
        </div>
        <div className="chart-legend">
          <span className="lg"><i style={{ borderColor: '#0e1b2a' }} />Observed (30 days)</span>
          <span className="lg"><i style={{ borderColor: '#1e6a8d', borderTopStyle: 'dashed' }} />Live forecast (7 days)</span>
          {simSeries && <span className="lg"><i style={{ borderColor: '#6a3fae', borderTopWidth: 3 }} />Scenario forecast</span>}
          <span className="lg"><i style={{ borderColor: '#667180', borderTopStyle: 'dashed' }} />Baseline (median)</span>
          <span className="lg"><i style={{ borderColor: '#b0411e' }} />Danger threshold</span>
        </div>

        <div className="kpis">
          <div className="kpi"><div className="l">30-day median baseline</div><div className="v">{m3s(ev?.baseline)}</div></div>
          <div className="kpi"><div className="l">7-day forecast peak {ev?.peakDate ? `(${shortDate(ev.peakDate)})` : ''}</div><div className="v">{m3s(ev?.peak)}</div></div>
          <div className="kpi"><div className="l">Ratio {isSim && <span className="tag-sim" style={{ fontSize: 9 }}>Scenario</span>}</div><div className={`v ${ev?.trigger ? 'hot' : ''}`}>{ratio(ev?.ratio)}</div></div>
          <div className="kpi"><div className="l">Danger threshold</div><div className="v">{d.threshold.toFixed(2)}×</div></div>
        </div>
      </div>

      <ActionPanel d={d} fc={fc} config={config} busy={busy} actions={actions} />
    </div>
  );
}

function ActionPanel({ d, fc, config, busy, actions }) {
  const [amount, setAmount] = useState('25.00');
  const [donor, setDonor] = useState('');
  const pledgeRef = useRef();
  pledgeRef.current = { districtId: d.id, amount, donorName: donor };
  const open = d.status === 'WATCHING';
  const amountValid = /^\d{1,4}(\.\d{1,2})?$/.test(amount) && Number(amount) >= 1 && Number(amount) <= 1000;
  const isMock = config.paymentMode !== 'paypal';
  const anyBusy = Boolean(busy);

  return (
    <div className="panel actions" style={{ gap: 0 }}>
      <div className="action-block">
        <div className="action-title"><span><span className="eyebrow" style={{ marginRight: 6 }}>01</span>Pledge</span><span className="muted mono" style={{ fontSize: 11.5 }}>Held {usd(d.totals.heldCents)}</span></div>
        <p className="action-help">Your pledge is <b>authorized, not charged</b>. It is captured only if {d.shortName} crosses its danger threshold; otherwise it is voided.</p>
        {open ? (
          <>
            <div className="amounts" role="group" aria-label="Pledge amount">
              {PRESETS.map((p) => <button type="button" key={p} className={amount === p ? 'on' : ''} onClick={() => setAmount(p)}>${p.replace('.00', '')}</button>)}
            </div>
            <div className="field">
              <label htmlFor="amt">Amount (USD 1.00 to 1,000.00)</label>
              <div className="input-prefix"><span>USD</span><input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim())} onBlur={() => amountValid && setAmount(Number(amount).toFixed(2))} /></div>
            </div>
            <div className="field">
              <label htmlFor="donor">Display name (optional)</label>
              <input id="donor" maxLength={60} placeholder="Anonymous donor" value={donor} onChange={(e) => setDonor(e.target.value)} />
            </div>
            {isMock ? (
              <button type="button" className="btn" disabled={!amountValid || anyBusy} onClick={() => actions.mockPledge(pledgeRef.current)}>
                {busy === 'pledge' ? <span className="spinner" /> : null} Approve pledge (mock)
              </button>
            ) : (
              <PayPalButtons
                clientId={config.paypalClientId}
                disabled={!amountValid || anyBusy}
                getPledge={() => pledgeRef.current}
                onCreate={actions.createPledge}
                onApproved={actions.authorizePledge}
                onError={actions.paypalError}
                onCancel={actions.paypalCancel}
              />
            )}
          </>
        ) : (
          <div className="closed-note">Pledging is closed: this watch window has {d.status === 'TRIGGERED' ? 'triggered' : 'been released'}.</div>
        )}
      </div>

      <div className="action-block">
        <div className="action-title"><span><span className="eyebrow" style={{ marginRight: 6 }}>02</span>Flood scenario</span>{d.scenario && <span className="tag-sim">Active</span>}</div>
        <p className="action-help">Overlays a flood surge on the current forecast, peaking at {d.scenario?.targetRatio ?? 2.35}× the 30-day median, to rehearse the trigger and settlement. The live forecast is unchanged.</p>
        {open ? (
          <button type="button" className={`btn sim ${d.scenario ? 'on' : ''}`} disabled={anyBusy || !fc?.live?.series} onClick={() => actions.scenario(!d.scenario)}>
            {busy === 'scenario' ? <span className="spinner" /> : null}{d.scenario ? 'Clear scenario' : 'Run flood scenario'}
          </button>
        ) : (
          <div className="closed-note">{d.trigger?.simulated ? 'Triggered under a scenario. Use Reset to run it again.' : 'Scenarios are available while the district is watching.'}</div>
        )}
      </div>

      <div className="action-block">
        <div className="action-title"><span><span className="eyebrow" style={{ marginRight: 6 }}>03</span>Evaluate trigger</span></div>
        <p className="action-help">Compares the forecast peak with the 30-day median. At {d.threshold.toFixed(2)}× or above, held pledges are captured, the relief partner is paid and a risk assessment is issued.</p>
        <button type="button" className="btn" disabled={d.status === 'RELEASED' || anyBusy} onClick={actions.evaluate}>
          {busy === 'evaluate' ? <span className="spinner" /> : null}{d.status === 'TRIGGERED' ? 'Re-check settlement' : 'Evaluate now'}
        </button>
        {busy === 'evaluate' && (
          <ul className="progress-list" aria-live="polite">
            <li className="on"><span className="spinner" />Checking forecast against threshold</li>
            <li>Capturing held authorizations if triggered</li>
            <li>Initiating relief-partner payout</li>
            <li>Preparing risk assessment</li>
          </ul>
        )}
      </div>

      <div className="action-block">
        <div className="action-title"><span><span className="eyebrow" style={{ marginRight: 6 }}>04</span>Release pledges</span></div>
        <p className="action-help">Closes the watch window without a trigger. All held authorizations for {d.shortName} only are voided and donors are not charged. Watch window ends {new Date(d.watchEndsAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}.</p>
        <button type="button" className="btn secondary" disabled={!open || anyBusy} onClick={actions.release}>
          {busy === 'release' ? <span className="spinner" /> : null}Release and void held pledges
        </button>
      </div>
    </div>
  );
}
