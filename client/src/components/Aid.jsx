import React, { useEffect, useState } from 'react';
import { usd, time } from '../format.js';
import AidCarousel from './AidCarousel.jsx';

const FLAG_LABEL = {
  LOCATION_CLUSTER: 'Many registrations at this spot: held for review',
  MANUAL_LOCATION_SANDBOX: 'Sandbox: location set manually',
  COUNTRY_MISMATCH_SANDBOX: 'Sandbox: account country differs',
};

export default function Aid({ compact, district: d, config, api, busy, run, toast, registerToken, clearRegister, webhooks }) {
  const t = d.trigger;
  const rules = config.aidRules;
  const a = d.aid;
  const [supplies, setSupplies] = useState(null);

  useEffect(() => {
    let live = true;
    setSupplies(null);
    if (config.suppliesEnabled) api.essentials(d.id).then((r) => live && setSupplies(r)).catch(() => live && setSupplies({ items: [] }));
    return () => { live = false; };
  }, [d.id, config.suppliesEnabled, api]);

  const items = t ? t.payouts.flatMap((b) => b.items.map((i) => ({ ...i, batchId: b.payoutBatchId, batchStatus: b.batchStatus }))) : [];

  const cards = [
    {
      key: 'register',
      node: (
        <>
          <div className="aid-card-t">Register with PayPal</div>
          <p>{d.registration.open ? 'Verified residents sign in and receive an equal share.' : d.registration.reason}</p>
          {d.registration.open && <a className="aid-btn" href={`/api/auth/paypal/start?district=${encodeURIComponent(d.id)}`}>Register</a>}
        </>
      ),
    },
    ...(t ? [
      {
        key: 'round',
        node: (
          <>
            <div className="aid-card-t">Payment round</div>
            <p>Split the pool equally among verified households.</p>
            <button type="button" className="aid-btn" disabled={Boolean(busy) || !a.eligibleUnpaid} onClick={() => run('aid', async () => { const r = await api.disburse(d.id); toast(`Round ${r.round.no}: ${r.round.households} household(s), ${usd(r.round.perHouseholdCents)} each; ${usd(r.round.part1Cents)} paid now.`); })}>{busy === 'aid' ? 'Paying…' : 'Run round'}</button>
          </>
        ),
      },
      {
        key: 'second',
        node: (
          <>
            <div className="aid-card-t">Second payments</div>
            <p>Release the reviewed second part of each payment.</p>
            <button type="button" className="aid-btn" disabled={Boolean(busy)} onClick={() => run('aid2', async () => { await api.releaseSecond(d.id); toast('Second payments released.'); })}>Release</button>
          </>
        ),
      },
    ] : []),
    ...((supplies?.items ?? []).map((x) => ({
      key: `s-${x.need}`,
      node: (
        <a className="aid-supply" href={x.url} target="_blank" rel="noreferrer sponsored">
          {x.image && <img src={x.image} alt="" loading="lazy" />}
          <div className="aid-card-t">{x.need}</div>
          <p>{x.title}</p>
          <span className="mono">{usd(x.priceCents)}</span>
        </a>
      ),
    }))),
  ];

  return (
    <div className="aid">
      <div className="aid-head">
        <h2>Direct aid</h2>
        <p>{t ? (t.simulated ? 'Scenario' : t.live ? 'Live event' : 'Live trigger') : 'Pre-registration'} · No intermediary · 0% fee</p>
      </div>

      {registerToken && <RegisterForm d={d} token={registerToken} api={api} run={run} toast={toast} onDone={clearRegister} />}

      <AidCarousel cards={cards} />

      {!compact && (<>
      <div className="wh-line">
        <span className={`wh-dot ${webhooks?.enabled ? '' : 'off'}`} />
        <span><b>Rules (locked):</b> equal split per round, up to {usd(rules.capPerHouseholdCents)} per household · {Math.round(rules.firstPartShare * 100)}% now, the rest after a {rules.reviewHoldHours}-hour review · verified PayPal accounts only, one per account · within {d.radiusKm} km · registration {rules.registrationHours} h after trigger. {webhooks?.enabled ? 'Payout status from verified PayPal webhooks.' : 'Payout status polled from PayPal.'}</span>
      </div>

      <div className="settle-grid">
        <div>
          <div className="eyebrow" style={{ padding: '12px 18px 6px' }}>Whom donations helped</div>
          {d.registrants.length ? (
            <table className="alloc">
              <thead><tr><th>Household</th><th>Size</th><th>Distance</th><th>Status</th><th className="n">Aid</th></tr></thead>
              <tbody>{d.registrants.map((r) => (
                <tr key={r.id}>
                  <td className="mono">{r.id}{r.flags.map((f) => <div key={f} className="muted" style={{ fontSize: 11 }}>{FLAG_LABEL[f] || f}</div>)}</td>
                  <td>{r.householdSize}</td>
                  <td>{r.distanceKm} km</td>
                  <td>{r.status === 'REVIEW' ? 'Review' : r.entitlementCents ? (r.part2Paid ? 'Paid in full' : `Part 1 paid · part 2 ${time(r.part2DueAt)}`) : 'Verified'}</td>
                  <td className="n mono">{r.entitlementCents ? usd(r.entitlementCents) : '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <p className="muted" style={{ padding: '0 18px 14px', fontSize: 13 }}>No households registered yet. Residents sign in with PayPal; IDs shown here are anonymous.</p>}
        </div>
        <div>
          <div className="eyebrow" style={{ padding: '12px 18px 6px' }}>PayPal payout items</div>
          {items.length ? (
            <table className="alloc payout">
              <thead><tr><th>Recipient</th><th>Part</th><th>Item ID</th><th className="n">Amount</th></tr></thead>
              <tbody>{items.map((i) => (
                <tr key={i.senderItemId}>
                  <td className="mono">{i.registrantId}<div className="muted" style={{ fontSize: 11 }}>{i.receiver} · {i.status}</div></td>
                  <td>{i.part}/2</td>
                  <td className="mono" style={{ fontSize: 11 }}>{i.payoutItemId || '—'}</td>
                  <td className="n mono">{usd(i.amountCents)}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <p className="muted" style={{ padding: '0 18px 14px', fontSize: 13 }}>No payments yet.</p>}
        </div>
      </div>
      </>)}
    </div>
  );
}

function RegisterForm({ d, token, api, run, toast, onDone }) {
  const [info, setInfo] = useState(null);
  const [size, setSize] = useState('4');
  const [loc, setLoc] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api.session(token).then(setInfo).catch((e) => setErr(e.message)); }, [token, api]);
  const useDevice = () => {
    if (!navigator.geolocation) return setErr('This browser cannot share a location.');
    navigator.geolocation.getCurrentPosition(
      (p) => setLoc({ lat: p.coords.latitude, lon: p.coords.longitude, source: 'device' }),
      (e) => setErr(`Location unavailable: ${e.message}`),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };
  const submit = () => run('register', async () => {
    const r = await api.register(d.id, { token, householdSize: Number(size), location: loc });
    toast(`Registered as ${r.id} (${r.status === 'ELIGIBLE' ? 'verified' : 'held for review'}).`);
    onDone();
  });
  return (
    <div className="register-box">
      {err && <div className="inline-error">{err}</div>}
      {info && (
        <>
          <div><b>Signed in with PayPal</b> · {info.email} · {info.verified ? 'verified account' : 'not verified'}</div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'end', flexWrap: 'wrap', marginTop: 8 }}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="hh">Household size</label>
              <input id="hh" inputMode="numeric" value={size} onChange={(e) => setSize(e.target.value.replace(/\D/g, '').slice(0, 2))} style={{ width: 80 }} />
            </div>
            <button type="button" className="btn secondary" style={{ width: 'auto' }} onClick={useDevice}>Use my location</button>
            <button type="button" className="btn secondary" style={{ width: 'auto' }} onClick={() => setLoc({ lat: d.lat, lon: d.lon, source: 'manual' })}>Sandbox: use campaign location</button>
            <button type="button" className="btn" style={{ width: 'auto' }} disabled={!loc || !info.verified} onClick={submit}>Register household</button>
            <button type="button" className="btn secondary" style={{ width: 'auto' }} onClick={onDone}>Cancel</button>
          </div>
          {loc && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>Location set ({loc.source === 'manual' ? 'manual, Sandbox only' : 'device'}). Only the distance to {d.shortName} is published.</div>}
        </>
      )}
    </div>
  );
}
