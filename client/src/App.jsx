import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import Detail from './components/Detail.jsx';
import Assessment from './components/Assessment.jsx';
import Aid from './components/Aid.jsx';
import Ledger from './components/Ledger.jsx';
import Globe from './components/Globe.jsx';
import FloodMap from './components/FloodMap.jsx';
import Hotspots from './components/Hotspots.jsx';
import Water from './components/Water.jsx';
import LiveFloods from './components/LiveFloods.jsx';
import { nearestDistrict, day } from './geo.js';
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

function CountUp({ value }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 1800);
      setN(Math.round(value * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{n}</>;
}

function Counter({ value, label, sub, hot }) {
  return (
    <div className={`counter ${hot ? 'warn' : ''}`}>
      <div className="counter-n">{value == null ? '–' : <CountUp value={value} />}</div>
      <div className="counter-l">{label}</div>
      <div className="counter-s">{sub}</div>
    </div>
  );
}

function Stepper({ d, pledgeCount }) {
  const steps = [
    { k: 'PLEDGE' },
    { k: 'WATCH' },
    { k: 'TRIGGER', alert: true },
    { k: 'RELEASE' },
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
        </div>
      ))}
    </div>
  );
}

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, '');
  const [a, id] = h.split('/');
  if (a === 'alerts') return id ? { page: 'area', id } : { page: 'alerts' };
  if (a === 'district' && id) return { page: 'district', id };
  if (a === 'ledger') return { page: 'ledger' };
  return { page: 'home' };
}
function useRoute() {
  const [r, setR] = useState(parseHash);
  useEffect(() => {
    const on = () => { const n = parseHash(); setR(n); if (n.page !== 'home') window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
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
  const [floods, setFloods] = useState(null);
  const route = useRoute();
  const nearestId = (() => {
    if (route.page !== 'area' || !floods || !snap) return null;
    const ev = floods.events.find((e) => String(e.id) === route.id);
    return ev ? nearestDistrict(snap.districts, ev)?.district.id ?? null : null;
  })();
  useEffect(() => { if (nearestId) setSelected(nearestId); }, [nearestId, route.id]);
  useEffect(() => { if (route.page === 'district') setSelected(route.id); }, [route.page, route.id]);
  useEffect(() => {
    let dead = false;
    const load = () => api.floods().then((f) => { if (!dead) setFloods(f); }).catch((e) => { if (!dead) setFloods((x) => x ?? { events: [], error: e.message }); });
    load();
    const t = setInterval(load, 10 * 60 * 1000);
    return () => { dead = true; clearInterval(t); };
  }, []);

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
        if (q.get('register') && q.get('district')) { setSelected(q.get('district')); setRegisterToken(q.get('register')); window.location.hash = `#/district/${q.get('district')}`; }
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

  const ev = floods?.events;
  const floodStats = [
    { value: ev ? ev.length : null, label: 'Active floods', sub: 'GDACS, live' },
    { value: ev ? new Set(ev.map((e) => e.country)).size : null, label: 'Countries affected', sub: 'with a current flood' },
    { value: ev ? ev.filter((e) => e.alert === 'Orange' || e.alert === 'Red').length : null, label: 'Flood warnings', sub: 'Orange and Red alerts', hot: true },
    { value: ev ? ev.filter((e) => e.alert === 'Green').length : null, label: 'Watch level', sub: 'Green alerts' },
    { value: snap.districts.filter((x) => x.status === 'WATCHING').length, label: 'Districts watched', sub: `of ${snap.districts.length} Floodgate districts` },
  ];

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

  const openEvent = (e) => { window.location.hash = `#/alerts/${e.id}`; };
  const areaEvent = route.page === 'area' ? floods?.events?.find((e) => String(e.id) === route.id) : null;
  const areaNear = areaEvent ? nearestDistrict(snap.districts, areaEvent) : null;

  const detailView = (
    <>
      <div className="area-filter" role="group" aria-label="Pledge district">
        {snap.districts.map((x) => (
          <button type="button" key={x.id} className={selected === x.id ? 'on' : ''} aria-pressed={selected === x.id} onClick={() => setSelected(x.id)}>{x.shortName ?? x.name}</button>
        ))}
      </div>
      <div className="section-head"><h2>{d.name}</h2><span className="sub">{d.kind === 'live' ? 'Live event · direct aid' : `${d.river} · direct aid to verified households`}</span></div>
      <Detail district={d} forecast={fc} config={config} busy={busy} actions={actions} onRefreshForecast={() => loadForecast(selected, true)} />
      <Assessment district={d} licenseKey={config.bryntumLicenseKey} />
      <Aid district={d} config={config} api={api} busy={busy} run={run} toast={toast} webhooks={snap.webhooks} registerToken={registerToken && d.id === selected ? registerToken : null} clearRegister={() => setRegisterToken(null)} />
    </>
  );

  return (
    <>
      {route.page === 'home' ? (
        <section className="landing" id="top">
          <header className="topline"><a className="bookman" href="#top">Floodgate</a></header>

          <div className="hero-row">
            <div className="landing-body">
              <h1 className="land-title">Relief before<br />the flood.</h1>
              <a className="cta-main" href="#/ledger">Ledger <span className="arrow">↗</span></a>
            </div>
            <div className="globe-wrap"><Globe events={floods?.events} /></div>
          </div>

          <div className="water-zone">
            <Water />
            <div className="counters">
              {floodStats.map((x) => <Counter key={x.label} {...x} />)}
            </div>
          </div>
        </section>
      ) : (
        <header className="subbar"><a className="bookman" href="#/">Floodgate</a></header>
      )}

      <main>
        {route.page === 'home' && (
          <>
            <div id="map" style={{ height: 40 }} />
            <LiveFloods floods={floods} districts={snap.districts} forecasts={forecasts} />

            <div id="board" className="section-head center"><a className="alerts-link" href="#/alerts"><h2>Highest flood alerts worldwide <span>↗</span></h2></a></div>
            <Hotspots events={floods?.events} error={floods?.error} limit={4} onOpen={openEvent} />

            <Aid compact district={d} config={config} api={api} busy={busy} run={run} toast={toast} webhooks={snap.webhooks} registerToken={null} clearRegister={() => {}} />
          </>
        )}

        {route.page === 'ledger' && (
          <>
            <a className="back" href="#/">← Back</a>
            <div className="section-head center"><h2>Ledger</h2></div>
            <Ledger rows={snap.ledger} api={api} onError={toastError} />
          </>
        )}

        {route.page === 'alerts' && (
          <>
            <a className="back" href="#/">← Back</a>
            <div className="section-head center"><h2>Flood alerts worldwide</h2></div>
            <div className="panel map-wide"><FloodMap events={floods?.events} /></div>
            <div style={{ height: 20 }} />
            <Hotspots events={floods?.events} error={floods?.error} limit={999} onOpen={openEvent} />
          </>
        )}

        {route.page === 'area' && (
          <>
            <a className="back" href="#/alerts">← All flood alerts</a>
            {areaEvent ? (
              <div className="area-head">
                <h1>{areaEvent.name}</h1>
                <div className="area-facts">
                  <span className={`alert-pill ${areaEvent.alert.toLowerCase()}`}>{areaEvent.alert} alert</span>
                  <span>{areaEvent.severityText || 'Severity not rated'}</span>
                  <span>Since {day(areaEvent.from)}</span>
                  <span className="mono">{areaEvent.lat.toFixed(2)}, {areaEvent.lng.toFixed(2)}</span>
                  {areaNear && <span>Nearest district: {areaNear.district.name} · {Math.round(areaNear.km)} km</span>}
                </div>
              </div>
            ) : <div className="empty">{floods ? 'This flood alert is no longer active.' : 'Loading…'}</div>}
            {detailView}
          </>
        )}

        {route.page === 'district' && (
          <>
            <a className="back" href="#/">← Back</a>
            {detailView}
          </>
        )}
      </main>

      <footer><p>Sandbox demo · sample data · no real money moves. Forecasts: Open-Meteo GloFAS. <button type="button" className="link-btn" onClick={reset} disabled={busy === 'reset'}>Reset demo</button></p></footer>

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
