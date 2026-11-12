import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import Board from './components/Board.jsx';
import Detail from './components/Detail.jsx';
import Assessment from './components/Assessment.jsx';
import Aid from './components/Aid.jsx';
import Ledger from './components/Ledger.jsx';
import { usd, ratio } from './format.js';

function Mark() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="7" fill="#163b56" />
      <path d="M6 21c3 0 3-3 6-3s3 3 6 3 3-3 6-3 2 2 2 2" stroke="#7fc4d8" strokeWidth="2.4" fill="none" strokeLinecap="round" />
      <path d="M9 8v8M23 8v8" stroke="#f4f2ec" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function Stepper({ d, pledgeCount }) {
  const steps = [
    { k: 'PLEDGE', d: 'Donor authorizes a hold. Not charged.' },
    { k: 'WATCH', d: 'River discharge vs 30-day median.' },
    { k: 'TRIGGER', d: 'Threshold met: capture and pay out.', alert: true },
    { k: 'RELEASE', d: 'No trigger: holds voided.' },
  ];
  const state = (k) => {
    if (!d) return '';
    if (k === 'PLEDGE') return pledgeCount ? 'done' : d.status === 'WATCHING' ? 'active' : '';
    if (k === 'WATCH') return d.status === 'WATCHING' ? (pledgeCount ? 'active' : '') : 'done';
    if (k === 'TRIGGER') return d.status === 'TRIGGERED' ? 'active' : '';
    if (k === 'RELEASE') return d.status === 'RELEASED' ? 'active' : '';
    return '';
  };
  return (
    <div className="stepper" aria-label={`Workflow stage for ${d?.shortName ?? 'district'}`}>
      {steps.map((s, i) => (
        <div key={s.k} className={`step ${state(s.k)} ${s.alert ? 'alert' : ''}`}>
          <div className="k">0{i + 1}</div>
          <div className="t">{s.k}</div>
          <div className="d">{s.d}</div>
        </div>
      ))}
    </div>
  );
}

let toastSeq = 0;

export default function App() {
  const [config, setConfig] = useState(null);
  const [snap, setSnap] = useState(null);
  const [forecasts, setForecasts] = useState({});
  const [selected, setSelected] = useState('sylhet');
  const [area, setArea] = useState('All');
  const [registerToken, setRegisterToken] = useState(null);
  const [busy, setBusy] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [fatal, setFatal] = useState(null);
  const detailRef = useRef(null);

  const toast = useCallback((msg, kind = 'info', ms = 6500) => {
    const id = ++toastSeq;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ms);
  }, []);
  const toastError = useCallback((e) => toast(e.message || String(e), 'error', 9000), [toast]);
  // eslint-disable-next-line no-inner-declarations
  function alertError(m) { toast(`PayPal sign-in: ${m}`, 'error', 10000); }

  const loadState = useCallback(async () => {
    try { setSnap(await api.state()); } catch (e) { setFatal(e.message); }
  }, []);

  const loadForecast = useCallback(async (id, refresh = false) => {
    try {
      const f = await api.forecast(id, refresh);
      setForecasts((m) => ({ ...m, [id]: f }));
    } catch (e) {
      setForecasts((m) => ({ ...m, [id]: { live: { error: e.message, series: null } } }));
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [c, s] = await Promise.all([api.config(), api.state()]);
        setConfig(c);
        setSnap(s);
        s.districts.forEach((d) => loadForecast(d.id));
        const q = new URLSearchParams(window.location.search);
        if (q.get('register') && q.get('district')) { setSelected(q.get('district')); setRegisterToken(q.get('register')); }
        if (q.get('register_error')) setFatal(null), setTimeout(() => alertError(q.get('register_error')), 0);
        if (q.toString()) window.history.replaceState(null, '', '/');
      } catch (e) {
        setFatal(e.message);
      }
    })();
  }, [loadForecast]);

  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) loadState(); }, 5000);
    return () => clearInterval(t);
  }, [loadState]);

  const run = useCallback(async (key, fn) => {
    setBusy(key);
    try { return await fn(); } catch (e) { toastError(e); return null; } finally { setBusy(null); await loadState(); }
  }, [loadState, toastError]);

  if (fatal && !snap) return <div className="empty" style={{ padding: 80 }}>Floodgate could not load: {fatal}</div>;
  if (!config || !snap) return <div className="empty" style={{ padding: 80 }}><span className="spinner" /> Loading Floodgate…</div>;

  const d = snap.districts.find((x) => x.id === selected);
  const fc = forecasts[selected];
  const isMock = config.paymentMode !== 'paypal';
  const pledgeCount = snap.pledges.filter((p) => p.districtId === selected && !['CREATED', 'CANCELLED', 'AUTH_FAILED'].includes(p.status)).length;
  const totals = snap.districts.reduce((a, x) => ({ held: a.held + x.totals.heldCents, cap: a.cap + x.totals.capturedCents }), { held: 0, cap: 0 });

  const actions = {
    mockPledge: (body) => run('pledge', async () => {
      const o = await api.createPledge(body);
      const a = await api.authorize(o.orderId);
      toast(`Pledge authorized: ${usd(Math.round(Number(a.amount) * 100))} held for ${d.shortName}.`);
    }),
    createPledge: async (body) => {
      try { return await api.createPledge(body); } catch (e) { toastError(e); throw e; }
    },
    authorizePledge: (orderId) => run('pledge', async () => {
      const a = await api.authorize(orderId);
      toast(`Pledge authorized: ${usd(Math.round(Number(a.amount) * 100))} held for ${d.shortName}. You will only be charged if the trigger is met.`);
    }),
    paypalError: (e) => { toastError(new Error(`PayPal: ${e.message}`)); loadState(); },
    paypalCancel: () => toast('PayPal approval was cancelled. No authorization was created.'),
    scenario: (active) => run('scenario', async () => {
      const r = await api.scenario(selected, active);
      setForecasts((m) => ({ ...m, [selected]: r.forecast }));
      toast(active ? `Flood scenario applied to ${d.shortName}.` : 'Scenario cleared.');
    }),
    evaluate: () => run('evaluate', async () => {
      const r = await api.evaluate(selected);
      const sim = r.district.trigger?.simulated || r.district.lastEvaluation?.simulated;
      const tag = sim ? ' (scenario)' : '';
      if (r.outcome === 'TRIGGERED') {
        toast(`${d.shortName} triggered${tag}. ${usd(r.district.aid.capturedCents)} captured into the aid pool; household registration is open.`, 'info', 9000);
      } else if (r.outcome === 'BELOW_THRESHOLD') {
        toast(`${d.shortName}: ${ratio(r.district.lastEvaluation.evaluation.ratio)} is below the ${d.threshold.toFixed(2)}× threshold${tag}. Pledges remain held.`);
      } else if (r.outcome === 'ALREADY_TRIGGERED') {
        toast(`${d.shortName} has already triggered. Settlement re-checked; nothing was charged twice.`);
      } else {
        toast(`Forecast data unavailable: ${r.issues?.join('; ')}. No funds were moved.`, 'error');
      }
    }),
    release: () => run('release', async () => {
      const r = await api.release(selected);
      toast(r.outcome === 'RELEASED' ? `${d.shortName} released. ${usd(r.district.release.voidedCents)} in holds voided.` : `Released with ${r.failures.length} void failure(s); those pledges remain held.`, r.failures.length ? 'error' : 'info');
    }),
  };

  const reset = () => run('reset', async () => {
    const r = await api.reset();
    snap.districts.forEach((x) => loadForecast(x.id));
    toast(r.note);
  });

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand"><Mark /><span className="brand-name">Floodgate</span><span className="brand-tag">Relief that moves before the flood arrives</span></div>
          <div className="top-spacer" />
          <div className="chips">
            <span className={`chip ${isMock ? 'warn' : ''}`}>{isMock ? 'Mock payments' : 'PayPal Sandbox'}</span>
          </div>
          <button type="button" className="btn-reset" onClick={reset} disabled={busy === 'reset'} title="Clears Floodgate records and restores the initial district data. PayPal transactions are not reversed.">Reset</button>
        </div>
      </header>
      {isMock && <div className="mock-banner">Mock payment mode: no PayPal requests are made.</div>}

      <main>
        <section className="hero">
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>Direct disaster aid · see exactly whom you helped</div>
            <h1>Give before the disaster. See exactly whom you helped.</h1>
            <p>Pledge to an at-risk area with a PayPal hold. When the river forecast crosses the danger line, or a GDACS alert confirms an earthquake, wildfire or cyclone, the money goes straight to verified households who sign in with PayPal: no intermediary, 0% fee, every payment on a public ledger. If nothing happens, your hold is released.</p>
            <p className="muted mono" style={{ fontSize: 12, marginTop: 10 }}>Across all districts: {usd(totals.held)} held · {usd(totals.cap)} captured</p>
          </div>
          <Stepper d={d} pledgeCount={pledgeCount} />
        </section>

        <div className="section-head"><h2>District board</h2><span className="sub">{snap.districts.length} districts · {new Set(snap.districts.map((x) => x.country)).size} countries · select a district</span></div>
        <div className="area-filter" role="group" aria-label="Filter by region">
          {['All', ...new Set(snap.districts.map((x) => x.area))].map((a) => (
            <button type="button" key={a} className={area === a ? 'on' : ''} aria-pressed={area === a} onClick={() => setArea(a)}>
              {a}<span className="n">{a === 'All' ? snap.districts.length : snap.districts.filter((x) => x.area === a).length}</span>
            </button>
          ))}
        </div>
        <Board districts={area === 'All' ? snap.districts : snap.districts.filter((x) => x.area === area)} forecasts={forecasts} selected={selected} onSelect={(id) => { setSelected(id); detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} />

        <div ref={detailRef} className="section-head" style={{ scrollMarginTop: 70 }}><h2>District detail</h2><span className="sub">{d.kind === 'live' ? 'Live event · direct aid' : `${d.river} · direct aid to verified households`}</span></div>
        <Detail district={d} forecast={fc} config={config} busy={busy} actions={actions} onRefreshForecast={() => loadForecast(selected, true)} />
        <Assessment district={d} licenseKey={config.bryntumLicenseKey} />
        <Aid district={d} config={config} api={api} busy={busy} run={run} toast={toast} webhooks={snap.webhooks} registerToken={registerToken && d.id === selected ? registerToken : null} clearRegister={() => setRegisterToken(null)} />

        <div className="section-head"><h2>Financial ledger</h2><span className="sub">Every authorization, capture, void, payout and allocation</span></div>
        <Ledger rows={snap.ledger} api={api} onError={toastError} />
      </main>

      <footer>
        <div className="eyebrow">Notes</div>
        <ul>{config.disclaimers.map((x) => <li key={x}>{x}</li>)}</ul>
        <p>Forecast data: Open-Meteo Flood API (GloFAS v4).</p>
      </footer>

      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span>{t.msg}</span>
            <button type="button" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>×</button>
          </div>
        ))}
      </div>
    </>
  );
}
