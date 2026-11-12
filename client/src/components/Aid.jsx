import React, { useEffect, useState } from 'react';
import { usd, time } from '../format.js';

const FLAG_LABEL = {
  LOCATION_CLUSTER: 'Many registrations at this spot: held for review',
  MANUAL_LOCATION_SANDBOX: 'Sandbox: location set manually',
  COUNTRY_MISMATCH_SANDBOX: 'Sandbox: account country differs',
};

export default function Aid({ district: d, config, api, busy, run, toast, registerToken, clearRegister, webhooks }) {
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

  return (
    <div className="panel settle" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="panel-title">Direct aid</span>
          {t ? (t.simulated ? <span className="tag-sim">Scenario</span> : <span className="tag-live">{t.live ? 'Live event' : 'Live trigger'}</span>) : <span className="muted" style={{ fontSize: 12 }}>Pre-registration</span>}
          <span className="muted" style={{ fontSize: 12 }}>No intermediary · Floodgate fee 0%</span>
        </div>
        {d.registration.open
          ? <a className="btn" style={{ width: 'auto', padding: '6px 14px', fontSize: 13 }} href={`/api/auth/paypal/start?district=${encodeURIComponent(d.id)}`}>Register with PayPal</a>
          : <span className="muted" style={{ fontSize: 12.5, maxWidth: 360 }}>{d.registration.reason}</span>}
      </div>

      {registerToken && <RegisterForm d={d} token={registerToken} api={api} run={run} toast={toast} onDone={clearRegister} />}

      <div className="flow">
        <div className="flow-step"><div className="l"><span>Pool (captured)</span></div><div className="v">{usd(a.capturedCents)}</div><div className="s">Held, not yet charged: {usd(d.totals.heldCents)}</div></div>
        <div className="flow-step"><div className="l"><span>Committed to households</span></div><div className="v">{usd(a.committedCents)}</div><div className="s">{a.registrants} registered · {a.eligibleUnpaid} awaiting a round</div></div>
        <div className="flow-step"><div className="l"><span>Paid via PayPal</span></div><div className="v">{usd(a.paidCents)}</div><div className="s">Completed: {usd(a.completedCents)}</div></div>
        <div className="flow-step"><div className="l"><span>Held for review</span></div><div className="v">{usd(a.reservedForReviewCents)}</div><div className="s">Unallocated: {usd(a.availableCents)}</div></div>
      </div>

      <div className="wh-line">
        <span className={`wh-dot ${webhooks?.enabled ? '' : 'off'}`} />
        <span><b>Rules (locked):</b> equal split per round, up to {usd(rules.capPerHouseholdCents)} per household · {Math.round(rules.firstPartShare * 100)}% now, the rest after a {rules.reviewHoldHours}-hour review · verified PayPal accounts only, one per account · within {d.radiusKm} km · registration {rules.registrationHours} h after trigger. {webhooks?.enabled ? 'Payout status from verified PayPal webhooks.' : 'Payout status polled from PayPal.'}</span>
      </div>

      {t && (
        <div style={{ display: 'flex', gap: 8, padding: '10px 18px', flexWrap: 'wrap', borderBottom: '1px solid var(--line-2)' }}>
          <button type="button" className="btn" style={{ width: 'auto' }} disabled={Boolean(busy) || !a.eligibleUnpaid} onClick={() => run('aid', async () => { const r = await api.disburse(d.id); toast(`Round ${r.round.no}: ${r.round.households} household(s), ${usd(r.round.perHouseholdCents)} each; ${usd(r.round.part1Cents)} paid now.`); })}>
            {busy === 'aid' ? <span className="spinner" /> : null}Run payment round
          </button>
          <button type="button" className="btn secondary" style={{ width: 'auto' }} disabled={Boolean(busy)} onClick={() => run('aid2', async () => { await api.releaseSecond(d.id); toast('Second payments released.'); })}>Release reviewed second payments</button>
        </div>
      )}

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

      {config.suppliesEnabled && (
        <div style={{ borderTop: '1px solid var(--line-2)' }}>
          <div className="eyebrow" style={{ padding: '12px 18px 6px' }}>What a household payment can cover · prices via Channel3</div>
          <div className="supplies">
            {!supplies ? <span className="muted" style={{ fontSize: 13 }}><span className="spinner" /> Loading prices…</span>
              : supplies.items.map((s) => (
                <a key={s.need} className="supply" href={s.url} target="_blank" rel="noreferrer sponsored">
                  {s.image && <img src={s.image} alt="" loading="lazy" />}
                  <div className="supply-need">{s.need}</div>
                  <div className="supply-title">{s.title}</div>
                  <div className="mono">{usd(s.priceCents)} <span className="muted">· {s.merchant}</span></div>
                  {s.commissionRate ? <div className="muted" style={{ fontSize: 11 }}>Referral link: merchant may pay up to {(s.commissionRate * 100).toFixed(1)}% to Channel3</div> : null}
                </a>
              ))}
          </div>
        </div>
      )}
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
