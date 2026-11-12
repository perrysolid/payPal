import { describe, it, expect, beforeEach } from 'vitest';
import { createEngine } from '../server/engine.js';
import { createMockProvider } from '../server/payments/mock.js';
import { computeTrigger, applyReplaySurge, splitSeries } from '../server/forecast.js';
import { apportion, parseAmountToCents, centsToString } from '../server/money.js';
import { computeAllocations } from '../server/allocation.js';
import { validateLedgerQuery, keywordLedgerQuery, templateAssessment } from '../server/ai.js';
import { buildDistricts } from '../server/data/districts.js';

function series(baseline = 1000, forecastValue = 800) {
  const past = Array.from({ length: 30 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, value: baseline }));
  const forecast = Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, '0')}`, value: forecastValue }));
  return { past, forecast };
}

function fakeForecast({ fail = false } = {}) {
  return {
    getForecast: async (d) => {
      if (fail) return { live: false, series: null, evaluation: null, error: 'Open-Meteo request timed out' };
      const s = series();
      return { live: true, fetchedAt: new Date().toISOString(), series: s, evaluation: computeTrigger(s, d.threshold), error: null };
    },
    clear() {},
  };
}

const ai = { enabled: false, assess: async ({ district, evaluation, simulated }) => ({ ...templateAssessment({ district, evaluation, simulated }), source: 'template', sourceLabel: 'AI OFFLINE — TEMPLATE RESPONSE' }) };

function makeEngine(opts = {}) {
  const providerFactory = opts.providerFactory ?? (() => createMockProvider());
  return createEngine({ providerFactory, forecast: opts.forecast ?? fakeForecast(), ai, config: { payoutRecipientOverride: null }, log: { warn() {} } });
}

async function pledge(engine, districtId, amount) {
  const p = await engine.createPledge({ districtId, amount });
  await engine.authorizePledge(p.orderId);
  return p;
}

describe('money', () => {
  it('parses and formats exact cents', () => {
    expect(parseAmountToCents('25.5')).toBe(2550);
    expect(parseAmountToCents('0.10')).toBe(10);
    expect(centsToString(1005)).toBe('10.05');
    expect(() => parseAmountToCents('1.005')).toThrow();
    expect(() => parseAmountToCents('-1')).toThrow();
  });
  it('apportions to the exact total', () => {
    for (const total of [0, 1, 99, 2550, 333333]) {
      const parts = apportion(total, [1.7, 2.3, 0.1, 5, 1, 1, 1]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(parts.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
    }
    expect(apportion(100, [0, 0, 0]).reduce((a, b) => a + b)).toBe(100);
  });
});

describe('trigger engine', () => {
  it('computes median baseline, peak and ratio deterministically', () => {
    const s = series(1000, 1900);
    const e = computeTrigger(s, 1.8);
    expect(e.baseline).toBe(1000);
    expect(e.peak).toBe(1900);
    expect(e.ratio).toBeCloseTo(1.9);
    expect(e.trigger).toBe(true);
    expect(computeTrigger(series(1000, 1700), 1.8).trigger).toBe(false);
  });
  it('rejects zero baselines and missing data', () => {
    expect(computeTrigger(series(0, 100), 1.8)).toMatchObject({ valid: false, trigger: false });
    const s = series();
    s.forecast = s.forecast.map((p) => ({ ...p, value: null }));
    expect(computeTrigger(s, 1.8)).toMatchObject({ valid: false, trigger: false });
  });
  it('replay surge never mutates live data', () => {
    const s = series();
    const before = JSON.stringify(s);
    const sim = applyReplaySurge(s.forecast, 1000, 2.35);
    expect(JSON.stringify(s)).toBe(before);
    expect(computeTrigger({ past: s.past, forecast: sim }, 1.8).trigger).toBe(true);
  });
  it('splits past and forecast around today', () => {
    const r = splitSeries(['2026-11-10', '2026-11-11', '2026-11-12'], [1, 2, 3], '2026-11-12');
    expect(r.past).toHaveLength(2);
    expect(r.forecast).toHaveLength(1);
  });
});

describe('financial invariants', () => {
  let engine;
  beforeEach(() => { engine = makeEngine(); });

  it('authorizes a pledge only once (idempotent)', async () => {
    const p = await engine.createPledge({ districtId: 'sylhet', amount: '10.00' });
    const a1 = await engine.authorizePledge(p.orderId);
    const a2 = await engine.authorizePledge(p.orderId);
    expect(a1.idempotent).toBe(false);
    expect(a2.idempotent).toBe(true);
    expect(a2.pledge.authorization.id).toBe(a1.pledge.authorization.id);
  });

  it('does not trigger below threshold', async () => {
    await pledge(engine, 'sylhet', '10.00');
    const r = await engine.evaluate('sylhet');
    expect(r.outcome).toBe('BELOW_THRESHOLD');
    expect(engine.districtSummary('sylhet').totals.heldCents).toBe(1000);
  });

  it('triggers once, captures once, payout never exceeds captured, allocations reconcile', async () => {
    await pledge(engine, 'sylhet', '10.00');
    await pledge(engine, 'sylhet', '15.55');
    await pledge(engine, 'kurigram', '7.00');
    engine.setScenario('sylhet', true);
    const results = await Promise.all([engine.evaluate('sylhet'), engine.evaluate('sylhet'), engine.evaluate('sylhet')]);
    expect(results.filter((r) => r.outcome === 'TRIGGERED')).toHaveLength(1);
    const d = engine.districtSummary('sylhet');
    expect(d.trigger.simulated).toBe(true);
    expect(d.totals.capturedCents).toBe(2555);
    expect(d.trigger.payouts).toHaveLength(1);
    expect(d.trigger.payouts[0].amountCents).toBe(2555);
    expect(d.trigger.allocationTotalCents).toBe(2555);
    // Other district untouched
    expect(engine.districtSummary('kurigram').totals.heldCents).toBe(700);
    expect(engine.districtSummary('kurigram').status).toBe('WATCHING');
    // Re-evaluate: no new payout
    await engine.evaluate('sylhet');
    expect(engine.districtSummary('sylhet').trigger.payouts).toHaveLength(1);
  });

  it('release voids only that district and cannot follow a trigger', async () => {
    await pledge(engine, 'saptari', '20.00');
    await pledge(engine, 'darbhanga', '30.00');
    const r = await engine.release('saptari');
    expect(r.outcome).toBe('RELEASED');
    expect(engine.districtSummary('saptari').totals.voidedCents).toBe(2000);
    expect(engine.districtSummary('darbhanga').totals.heldCents).toBe(3000);
    await expect(engine.evaluate('saptari')).rejects.toThrow(/released/);
    engine.setScenario('darbhanga', true);
    await engine.evaluate('darbhanga');
    await expect(engine.release('darbhanga')).rejects.toThrow(/triggered/);
  });

  it('rejects pledges outside limits and on closed districts', async () => {
    await expect(engine.createPledge({ districtId: 'sylhet', amount: '0.50' })).rejects.toThrow();
    await expect(engine.createPledge({ districtId: 'sylhet', amount: '5000' })).rejects.toThrow();
    await expect(engine.createPledge({ districtId: 'nowhere', amount: '5' })).rejects.toThrow();
    await engine.release('majuli');
    await expect(engine.createPledge({ districtId: 'majuli', amount: '5' })).rejects.toThrow(/closed/);
  });

  it('failed captures and payouts are not recorded as success, and retry idempotently', async () => {
    let failCapture = true;
    let failPayout = true;
    const eng = makeEngine({
      providerFactory: () => {
        const m = createMockProvider();
        return {
          ...m,
          captureAuthorization: async (a) => { if (failCapture) throw Object.assign(new Error('PayPal capture failed (503)'), { status: 503 }); return m.captureAuthorization(a); },
          createPayout: async (a) => { if (failPayout) throw Object.assign(new Error('PayPal Payouts POST failed (500)'), { status: 500 }); return m.createPayout(a); },
        };
      },
    });
    await pledge(eng, 'sylhet', '12.34');
    eng.setScenario('sylhet', true);
    await eng.evaluate('sylhet');
    let d = eng.districtSummary('sylhet');
    expect(d.status).toBe('TRIGGERED');
    expect(d.totals.capturedCents).toBe(0);
    expect(d.trigger.payouts).toHaveLength(0);
    expect(d.trigger.settlement).toBe('NEEDS_RETRY');

    failCapture = false;
    await eng.evaluate('sylhet');
    d = eng.districtSummary('sylhet');
    expect(d.totals.capturedCents).toBe(1234);
    expect(d.trigger.payouts[0].createState).toBe('REQUEST_FAILED');
    expect(d.totals.payoutInitiatedCents).toBe(0);
    expect(d.totals.payoutCompletedCents).toBe(0);

    failPayout = false;
    await eng.evaluate('sylhet');
    d = eng.districtSummary('sylhet');
    expect(d.trigger.payouts).toHaveLength(1);
    expect(d.trigger.payouts[0].createState).toBe('CREATED');
    expect(d.trigger.payouts[0].amountCents).toBe(1234);
  });

  it('forecast failure never triggers or moves money', async () => {
    const eng = makeEngine({ forecast: fakeForecast({ fail: true }) });
    await pledge(eng, 'sylhet', '10.00');
    const r = await eng.evaluate('sylhet');
    expect(r.outcome).toBe('DATA_UNAVAILABLE');
    expect(eng.districtSummary('sylhet').totals.heldCents).toBe(1000);
  });

  it('reset restores seed data', async () => {
    await pledge(engine, 'sylhet', '10.00');
    engine.setScenario('sylhet', true);
    await engine.evaluate('sylhet');
    engine.reset();
    const s = engine.snapshot();
    expect(s.pledges).toHaveLength(0);
    expect(s.ledger).toHaveLength(0);
    expect(s.districts.every((d) => d.status === 'WATCHING' && !d.scenario)).toBe(true);
    expect(s.districts).toHaveLength(6);
  });
});

describe('allocations and AI guards', () => {
  it('allocates by zone weight x members to the exact captured total', () => {
    const d = buildDistricts().find((x) => x.id === 'sylhet');
    const rows = computeAllocations(d.households, { A: 3, B: 2, C: 1 }, 10001);
    expect(rows.reduce((a, r) => a + r.amountCents, 0)).toBe(10001);
    const a = rows.find((r) => r.zone === 'A');
    const c = rows.find((r) => r.zone === 'C' && r.members === a.members);
    if (c) expect(a.amountCents).toBeGreaterThan(c.amountCents);
  });
  it('ledger query validator rejects unknown columns and operators', () => {
    const r = validateLedgerQuery({
      filters: [
        { column: 'district', operator: 'equals', value: 'sylhet' },
        { column: 'constructor', operator: 'equals', value: 'x' },
        { column: 'amount', operator: 'eval', value: '1' },
        { column: 'zone', operator: 'equals', value: 'Z' },
      ],
      sort: { column: '__proto__', direction: 'asc' },
      explanation: 'test',
    });
    expect(r.filterModel).toEqual({ district: { filterType: 'text', type: 'equals', filter: 'Sylhet' } });
    expect(r.sort).toBeNull();
    expect(r.rejected.length).toBe(4);
  });
  it('keyword fallback parses the example question', () => {
    const r = keywordLedgerQuery('Show unpaid pledges in zone B in Sylhet');
    expect(r.filterModel.district.filter).toBe('Sylhet');
    expect(r.filterModel.type.filter).toBe('Pledge');
    expect(r.filterModel.zone.filter).toBe('B');
  });
});
