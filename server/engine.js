// Floodgate financial state engine. In-memory, single process.
// All money is integer cents. Every state change goes through `transition`, and every
// district-level operation runs under a per-district lock so concurrent or repeated
// requests cannot double-capture, double-void or double-trigger.
import { randomUUID, createHash } from 'node:crypto';
import { buildDistricts } from './data/districts.js';
import { centsToString, parseAmountToCents, sumCents } from './money.js';
import { computeTrigger, applyReplaySurge } from './forecast.js';
import { computeAllocations } from './allocation.js';

export const MIN_PLEDGE_CENTS = 100;
export const MAX_PLEDGE_CENTS = 100_000;
const WATCH_WINDOW_MS = 7 * 24 * 3600 * 1000;
const REPLAY_TARGET_RATIO = 2.35;

const PLEDGE_TRANSITIONS = {
  CREATED: ['AUTHORIZING', 'CANCELLED'],
  AUTHORIZING: ['AUTHORIZED', 'CREATED', 'AUTH_FAILED'],
  AUTHORIZED: ['CAPTURING', 'VOIDING'],
  CAPTURING: ['CAPTURED', 'AUTHORIZED'],
  VOIDING: ['VOIDED', 'AUTHORIZED'],
  CAPTURED: [],
  VOIDED: [],
  AUTH_FAILED: [],
  CANCELLED: [],
};

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

function transition(pledge, to) {
  const allowed = PLEDGE_TRANSITIONS[pledge.status] || [];
  if (!allowed.includes(to)) {
    throw new HttpError(409, `Illegal pledge transition ${pledge.status} -> ${to} for ${pledge.id}`);
  }
  pledge.status = to;
  pledge.updatedAt = new Date().toISOString();
}

// ---------------- Direct-aid rules (public, locked per campaign) ----------------
export const AID_RULES = {
  capPerHouseholdCents: 10_000,      // USD 100 per household per campaign
  firstPartShare: 0.5,               // 50% paid immediately
  reviewHoldHours: Number(process.env.REVIEW_HOLD_HOURS || 48), // second 50% after review
  registrationHours: 72,             // registration window after a trigger
  minPayoutCents: 100,
  clusterLimit: 3,                   // more than 3 registrations within ~100 m are held for review
  districtRadiusKm: 60,
};

// Countries whose PayPal accounts can receive Payouts, per PayPal's Payouts country table
// (developer.paypal.com/payouts/supported-features). Countries absent from that table are not paid.
export const PAYOUT_COUNTRIES = new Set([
  'India', 'Indonesia', 'Philippines', 'Vietnam', 'Malaysia', 'China', 'Japan', 'Mexico', 'Colombia', 'Brazil', 'Peru',
  'Guatemala', 'Honduras', 'Dominican Republic', 'Jamaica', 'United States', 'Kenya', 'Mozambique', 'South Africa',
  'Germany', 'Italy', 'Spain', 'Greece', 'Turkey', 'Australia',
]);

export function distanceKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const toR = (x) => (x * Math.PI) / 180;
  const dLat = toR(bLat - aLat);
  const dLon = toR(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const COUNTRY_CODES = {
  India: 'IN', Bangladesh: 'BD', Nepal: 'NP', Pakistan: 'PK', Vietnam: 'VN', Philippines: 'PH', Nigeria: 'NG',
  Kenya: 'KE', Brazil: 'BR', Germany: 'DE', Mexico: 'MX', China: 'CN', 'United States': 'US', Panama: 'PA', Vanuatu: 'VU', Japan: 'JP', Indonesia: 'ID',
};

const anonId = (subject) => `R-${createHash('sha256').update(`floodgate:${subject}`).digest('hex').slice(0, 8).toUpperCase()}`;

const shortId = () => randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
const nowIso = () => new Date().toISOString();

function createLocks() {
  const tails = new Map();
  return async function withLock(key, fn) {
    const prev = tails.get(key) || Promise.resolve();
    let release;
    const next = new Promise((r) => { release = r; });
    const tail = prev.then(() => next);
    tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

export function createEngine({ providerFactory, forecast, ai, config, log = console }) {
  const withLock = createLocks();
  let provider;
  let state;
  const webhookStatus = { enabled: false, url: null, error: null };

  function reset() {
    provider = providerFactory();
    const seededAt = Date.now();
    state = {
      seededAt: new Date(seededAt).toISOString(),
      districts: new Map(buildDistricts().map((d) => [d.id, {
        ...d,
        status: 'WATCHING',
        watchEndsAt: new Date(seededAt + WATCH_WINDOW_MS).toISOString(),
        kind: 'forecast',
        countryCode: COUNTRY_CODES[d.country] || null,
        hazard: 'flood',
        radiusKm: AID_RULES.districtRadiusKm,
        payoutsSupported: PAYOUT_COUNTRIES.has(d.country),
        scenario: null,
        lastEvaluation: null,
        trigger: null,
        release: null,
        registrants: [],
      }])),
      pledges: new Map(),
      orderIndex: new Map(),
      webhookEvents: [],
    };
  }
  reset();

  const providerLabel = () => (provider.mode === 'paypal' ? 'PAYPAL SANDBOX' : 'MOCK');

  function getDistrict(id) {
    const d = state.districts.get(id);
    if (!d) throw new HttpError(404, `Unknown district "${id}"`);
    return d;
  }

  const pledgesFor = (districtId) => [...state.pledges.values()].filter((p) => p.districtId === districtId);
  const sumStatus = (districtId, statuses) => sumCents(pledgesFor(districtId).filter((p) => statuses.includes(p.status)).map((p) => p.amountCents));

  // ---------------- Forecast views ----------------

  async function forecastView(d, { force = false } = {}) {
    const live = await forecast.getForecast(d, { force });
    let simulated = null;
    if (d.scenario && live.series && live.evaluation?.baseline > 0) {
      const series = { past: live.series.past, forecast: applyReplaySurge(live.series.forecast, live.evaluation.baseline, d.scenario.targetRatio) };
      simulated = {
        label: 'SCENARIO',
        description: `Flood scenario peaking at ${d.scenario.targetRatio}x the 30-day median, overlaid on the live forecast.`,
        appliedAt: d.scenario.appliedAt,
        series,
        evaluation: computeTrigger(series, d.threshold),
      };
    }
    return { live, simulated };
  }

  // ---------------- Pledges ----------------

  async function createPledge({ districtId, amount, donorName }) {
    const d = getDistrict(districtId);
    if (d.status === 'RELEASED') throw new HttpError(409, `${d.shortName} was released; new pledges are closed for this watch window.`);
    let amountCents;
    try { amountCents = parseAmountToCents(String(amount)); } catch (e) { throw new HttpError(400, e.message); }
    if (amountCents < MIN_PLEDGE_CENTS || amountCents > MAX_PLEDGE_CENTS) {
      throw new HttpError(400, `Pledge must be between USD ${centsToString(MIN_PLEDGE_CENTS)} and USD ${centsToString(MAX_PLEDGE_CENTS)}`);
    }
    const donor = typeof donorName === 'string' ? donorName.replace(/[^\p{L}\p{N} .,'-]/gu, '').trim().slice(0, 60) : '';
    const id = `PLG-${shortId()}`;
    const order = await provider.createOrder({
      amount: centsToString(amountCents),
      districtId: d.id,
      referenceId: id,
      description: d.status === 'TRIGGERED' ? `Floodgate direct aid donation for ${d.name}` : `Floodgate conditional relief pledge for ${d.name}, ${d.country}`,
      requestId: `fg-order-${id}`,
    });
    const pledge = {
      id,
      districtId: d.id,
      amountCents,
      donorLabel: donor || 'Anonymous donor',
      provider: provider.mode,
      orderId: order.orderId,
      orderStatus: order.status,
      status: 'CREATED',
      authorization: null,
      capture: null,
      void: null,
      triggerId: null,
      errors: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.pledges.set(id, pledge);
    state.orderIndex.set(order.orderId, id);
    return pledge;
  }

  async function authorizePledge(orderId) {
    const pledgeId = state.orderIndex.get(orderId);
    if (!pledgeId) throw new HttpError(404, 'Unknown order');
    return withLock(`district:${state.pledges.get(pledgeId).districtId}`, async () => {
      const p = state.pledges.get(pledgeId);
      if (p.status === 'AUTHORIZED' || p.status === 'CAPTURED' || p.status === 'VOIDED') {
        return { pledge: p, idempotent: true };
      }
      if (p.status !== 'CREATED') throw new HttpError(409, `Pledge is ${p.status}; it cannot be authorized.`);
      const d = getDistrict(p.districtId);
      if (d.status === 'RELEASED') throw new HttpError(409, `${d.shortName} is no longer accepting pledges.`);
      transition(p, 'AUTHORIZING');
      let res;
      try {
        res = await provider.authorizeOrder({ orderId, requestId: `fg-auth-${p.id}` });
      } catch (e) {
        transition(p, 'CREATED');
        p.errors.push({ at: nowIso(), op: 'authorize', message: e.message });
        throw new HttpError(e.status && e.status < 500 ? 422 : 502, e.message, { debugId: e.debugId });
      }
      // Server-side validation of what PayPal actually authorized.
      let authorizedCents = null;
      try { authorizedCents = parseAmountToCents(String(res.amount)); } catch { /* handled below */ }
      const problems = [];
      if (authorizedCents !== p.amountCents) problems.push(`authorized amount ${res.amount} does not match pledge ${centsToString(p.amountCents)}`);
      if (res.currency && res.currency !== 'USD') problems.push(`unexpected currency ${res.currency}`);
      if (res.customId && res.customId !== p.districtId) problems.push('custom_id does not match pledge district');
      if (!['CREATED', 'PENDING'].includes(res.authorizationStatus)) problems.push(`authorization status ${res.authorizationStatus}`);
      p.authorization = {
        id: res.authorizationId,
        status: res.authorizationStatus,
        amountCents: authorizedCents,
        expirationTime: res.expirationTime,
        at: nowIso(),
      };
      p.orderStatus = res.orderStatus;
      if (res.payer?.name && p.donorLabel === 'Anonymous donor') p.donorLabel = res.payer.name;
      p.payerRef = res.payer?.payerId ? `payer ${res.payer.payerId}` : null;
      if (problems.length) {
        transition(p, 'AUTH_FAILED');
        p.errors.push({ at: nowIso(), op: 'authorize-validate', message: problems.join('; ') });
        // Release the hold we will not use.
        try { await provider.voidAuthorization({ authorizationId: res.authorizationId, requestId: `fg-void-${p.id}` }); } catch { /* recorded below */ }
        throw new HttpError(422, `Authorization rejected: ${problems.join('; ')}`);
      }
      transition(p, 'AUTHORIZED');
      // After a trigger (or for a live event) the pool is already open: capture immediately.
      if (d.status === 'TRIGGERED' && d.trigger) await settle(d);
      return { pledge: p, idempotent: false };
    });
  }

  // ---------------- Scenario ----------------

  function setScenario(districtId, active) {
    const d = getDistrict(districtId);
    if (active) {
      if (d.status !== 'WATCHING') throw new HttpError(409, `Replay is only available while ${d.shortName} is watching.`);
      d.scenario = { targetRatio: REPLAY_TARGET_RATIO, appliedAt: nowIso() };
    } else {
      if (d.status === 'TRIGGERED' && d.trigger?.simulated) throw new HttpError(409, 'This district was triggered by the replay scenario. Reset the demo to clear it.');
      d.scenario = null;
    }
    return d;
  }

  // ---------------- Evaluate / trigger ----------------

  async function evaluate(districtId) {
    const d = getDistrict(districtId);
    return withLock(`district:${d.id}`, async () => {
      if (d.status === 'RELEASED') throw new HttpError(409, `${d.shortName} was released; pledges were voided. Reset the demo to evaluate again.`);
      if (d.status === 'TRIGGERED') {
        // Duplicate evaluation: never re-trigger. Retry any incomplete settlement steps idempotently.
        await settle(d);
        return { outcome: 'ALREADY_TRIGGERED', district: d.id };
      }
      const { live, simulated } = await forecastView(d, { force: false });
      const basis = simulated ?? (live.series ? { series: live.series, evaluation: live.evaluation } : null);
      const isSim = Boolean(simulated);
      if (!basis || !basis.evaluation?.valid) {
        d.lastEvaluation = {
          at: nowIso(), simulated: isSim, valid: false,
          issues: basis?.evaluation?.issues ?? [live.error || 'Forecast unavailable'],
          evaluation: basis?.evaluation ?? null, assessment: null,
        };
        return { outcome: 'DATA_UNAVAILABLE', district: d.id, issues: d.lastEvaluation.issues };
      }
      const evaluation = basis.evaluation;
      const heldCents = sumStatus(d.id, ['AUTHORIZED']);

      if (!evaluation.trigger) {
        const assessment = await ai.assess({ district: d, evaluation, series: basis.series, simulated: isSim, heldCents, capturedCents: 0 });
        d.lastEvaluation = { at: nowIso(), simulated: isSim, valid: true, evaluation, assessment, heldCents };
        return { outcome: 'BELOW_THRESHOLD', district: d.id };
      }

      // Deterministic trigger confirmed. Commit the state change before any money moves.
      d.status = 'TRIGGERED';
      d.trigger = {
        id: `TRG-${shortId()}`,
        at: nowIso(),
        simulated: isSim,
        evaluation,
        series: basis.series,
        heldAtTriggerCents: heldCents,
        assessment: null,
        allocations: [],
        payouts: [],
        rounds: [],
        captureFailures: 0,
        settlement: 'CAPTURING',
        registrationClosesAt: new Date(Date.now() + AID_RULES.registrationHours * 3600_000).toISOString(),
      };
      d.lastEvaluation = { at: d.trigger.at, simulated: isSim, valid: true, evaluation, assessment: null, heldCents };

      const [assessment] = await Promise.all([
        ai.assess({ district: d, evaluation, series: basis.series, simulated: isSim, heldCents, capturedCents: heldCents }),
        captureAll(d),
      ]);
      d.trigger.assessment = assessment;
      d.lastEvaluation.assessment = assessment;
      await settle(d);
      return { outcome: 'TRIGGERED', district: d.id };
    });
  }

  async function captureAll(d) {
    const t = d.trigger;
    let failures = 0;
    for (const p of pledgesFor(d.id).filter((x) => x.status === 'AUTHORIZED')) {
      transition(p, 'CAPTURING');
      try {
        const res = await provider.captureAuthorization({ authorizationId: p.authorization.id, requestId: `fg-capture-${p.authorization.id}` });
        let capturedCents;
        try { capturedCents = parseAmountToCents(String(res.amount)); } catch { capturedCents = null; }
        if (capturedCents !== p.amountCents) {
          // Funds moved but the amount is not what we expect. Record exactly what PayPal reported.
          p.errors.push({ at: nowIso(), op: 'capture-validate', message: `captured ${res.amount}, expected ${centsToString(p.amountCents)}` });
        }
        p.capture = { id: res.captureId, status: res.status, amountCents: capturedCents ?? 0, at: nowIso() };
        p.triggerId = t.id;
        transition(p, 'CAPTURED');
      } catch (e) {
        failures += 1;
        transition(p, 'AUTHORIZED');
        p.errors.push({ at: nowIso(), op: 'capture', message: e.message });
        p.lastCaptureError = e.message;
        log.warn?.(`[floodgate] capture failed for ${p.id}: ${e.message}`);
      }
    }
    t.captureFailures = failures;
  }

  function capturedCentsFor(d) {
    return sumCents(pledgesFor(d.id).filter((p) => p.status === 'CAPTURED' && p.triggerId === d.trigger.id).map((p) => p.capture.amountCents));
  }

  function committedCents(d) {
    return sumCents((d.registrants || []).map((r) => r.entitlementCents || 0));
  }

  /** Idempotent settlement: capture leftovers, recompute allocations, create payouts for any uncovered captured funds. */
  async function settle(d) {
    const t = d.trigger;
    if (!t) return;
    if (pledgesFor(d.id).some((p) => p.status === 'AUTHORIZED')) await captureAll(d);
    const captured = capturedCentsFor(d);
    t.capturedCents = captured;

    // Retry a payout batch whose create request failed, using the same sender_batch_id.
    for (const b of t.payouts.filter((x) => x.createState === 'REQUEST_FAILED')) await submitPayout(d, b);
    if (committedCents(d) > captured) throw new Error('Invariant violated: aid commitments exceed captured funds');
    const failedCaptures = pledgesFor(d.id).filter((p) => p.status === 'AUTHORIZED').length;
    const failedPayouts = t.payouts.filter((b) => b.createState === 'REQUEST_FAILED').length;
    t.settlement = failedCaptures || failedPayouts ? 'NEEDS_RETRY' : captured === 0 ? 'AWAITING_FUNDS' : 'FUNDED';
  }

  async function submitPayout(d, batch) {
    const t = d.trigger;
    const sim = t.simulated ? ' (scenario)' : '';
    try {
      const res = await provider.createPayout({
        senderBatchId: batch.senderBatchId,
        emailSubject: `Floodgate direct aid: ${d.shortName}${sim}`,
        emailMessage: `Direct aid for households registered in ${d.name}. Paid by Floodgate under the published campaign rules.${sim}`,
        items: batch.items.map((i) => ({
          senderItemId: i.senderItemId,
          receiver: i.receiver,
          amount: centsToString(i.amountCents),
          note: i.note || `Floodgate ${d.shortName} trigger ${t.id}${sim}.`,
        })),
      });
      batch.createState = 'CREATED';
      batch.payoutBatchId = res.payoutBatchId;
      batch.batchStatus = res.batchStatus;
      batch.items.forEach((i) => { i.status = 'PENDING'; i.updatedAt = nowIso(); });
      batch.error = null;
    } catch (e) {
      batch.createState = 'REQUEST_FAILED';
      batch.error = e.message;
      batch.items.forEach((i) => { i.status = 'NOT_SUBMITTED'; });
      log.warn?.(`[floodgate] payout create failed for ${batch.senderBatchId}: ${e.message}`);
    }
    batch.updatedAt = nowIso();
  }

  const TERMINAL_BATCH = ['SUCCESS', 'DENIED', 'CANCELED'];

  // ---------------- Direct aid: registration ----------------
  function registrationState(d) {
    if (d.status === 'RELEASED') return { open: false, reason: 'This campaign was released; no aid is being paid.' };
    if (!d.payoutsSupported) return { open: false, reason: `PayPal Payouts cannot pay recipients in ${d.country}, so direct aid is not available here.` };
    if (d.status === 'TRIGGERED' && d.trigger?.registrationClosesAt && Date.parse(d.trigger.registrationClosesAt) < Date.now()) {
      return { open: false, reason: 'The registration window has closed.' };
    }
    return { open: true, reason: d.status === 'TRIGGERED' ? 'Registration is open.' : 'Pre-registration is open for this season.' };
  }

  /**
   * Register an affected household. Identity comes from Log in with PayPal (verified account);
   * location from the device. Every rule here is published on the campaign's rules card.
   */
  async function registerRecipient({ districtId, identity, location, householdSize }) {
    const d = getDistrict(districtId);
    return withLock(`district:${d.id}`, async () => {
      const st = registrationState(d);
      if (!st.open) throw new HttpError(409, st.reason);
      if (!identity?.subject || !identity.email) throw new HttpError(401, 'Sign in with PayPal first.');
      if (!identity.verified) throw new HttpError(422, 'Only verified PayPal accounts can register. Verify your PayPal account and try again.');
      const size = Number(householdSize);
      if (!Number.isInteger(size) || size < 1 || size > 15) throw new HttpError(400, 'Household size must be between 1 and 15.');
      const lat = Number(location?.lat); const lon = Number(location?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new HttpError(400, 'A valid location is required.');
      const id = anonId(identity.subject);
      if (d.registrants.some((r) => r.id === id)) throw new HttpError(409, 'This PayPal account is already registered for this campaign.');
      const dist = distanceKm(d.lat, d.lon, lat, lon);
      if (dist > d.radiusKm) throw new HttpError(422, `Your location is ${Math.round(dist)} km from ${d.shortName}; this campaign covers ${d.radiusKm} km.`);
      const sandbox = provider.mode !== 'paypal' || identity.sandbox;
      const flags = [];
      if (location.source === 'manual') {
        if (!sandbox) throw new HttpError(422, 'Device location is required.');
        flags.push('MANUAL_LOCATION_SANDBOX');
      }
      if (identity.country && identity.country !== d.countryCode) {
        if (!sandbox) throw new HttpError(422, 'Your PayPal account country does not match this campaign.');
        flags.push('COUNTRY_MISMATCH_SANDBOX');
      }
      const near = d.registrants.filter((r) => distanceKm(r.lat, r.lon, lat, lon) < 0.1).length;
      if (near >= AID_RULES.clusterLimit) flags.push('LOCATION_CLUSTER');
      const blocking = flags.filter((f) => !f.endsWith('_SANDBOX'));
      const r = {
        id, subject: identity.subject, email: identity.email, verified: true, accountCountry: identity.country || null,
        householdSize: size, lat, lon, distanceKm: Math.round(dist * 10) / 10, locationSource: location.source === 'manual' ? 'manual' : 'device',
        flags, status: blocking.length ? 'REVIEW' : 'ELIGIBLE', registeredAt: nowIso(),
        entitlementCents: 0, part1Cents: 0, part2Cents: 0, part2DueAt: null, part2Paid: false, round: null,
      };
      d.registrants.push(r);
      return r;
    });
  }

  // ---------------- Direct aid: disbursement rounds ----------------
  function aidSummary(d) {
    const captured = d.trigger ? capturedCentsFor(d) : 0;
    const committed = committedCents(d);
    const paid = d.trigger ? sumCents(d.trigger.payouts.filter((b) => b.createState === 'CREATED').map((b) => b.amountCents)) : 0;
    const completed = d.trigger ? sumCents(d.trigger.payouts.flatMap((b) => b.items).filter((i) => i.status === 'SUCCESS').map((i) => i.amountCents)) : 0;
    return {
      capturedCents: captured,
      committedCents: committed,
      reservedForReviewCents: committed - paid,
      availableCents: captured - committed,
      paidCents: paid,
      completedCents: completed,
      registrants: d.registrants.length,
      eligibleUnpaid: d.registrants.filter((r) => r.status === 'ELIGIBLE' && !r.entitlementCents).length,
    };
  }

  async function disburseRound(districtId) {
    const d = getDistrict(districtId);
    return withLock(`district:${d.id}`, async () => {
      const t = d.trigger;
      if (d.status !== 'TRIGGERED' || !t) throw new HttpError(409, 'Aid is paid only after the campaign has triggered.');
      await settle(d);
      const captured = capturedCentsFor(d);
      const available = captured - committedCents(d);
      const eligible = d.registrants.filter((r) => r.status === 'ELIGIBLE' && !r.entitlementCents);
      if (!eligible.length) throw new HttpError(409, 'No newly verified households are waiting for a payment.');
      const per = Math.min(AID_RULES.capPerHouseholdCents, Math.floor(available / eligible.length));
      if (per < AID_RULES.minPayoutCents) throw new HttpError(409, `Not enough unallocated funds (${centsToString(available)} USD) for ${eligible.length} household(s).`);
      const part1 = Math.floor(per * AID_RULES.firstPartShare);
      const roundNo = t.rounds.length + 1;
      const dueAt = new Date(Date.now() + AID_RULES.reviewHoldHours * 3600_000).toISOString();
      for (const r of eligible) {
        r.entitlementCents = per; r.part1Cents = part1; r.part2Cents = per - part1; r.part2DueAt = dueAt; r.round = roundNo;
      }
      if (committedCents(d) > captured) throw new Error('Invariant violated: aid commitments exceed captured funds');
      const batch = makeBatch(d, `R${roundNo}A`, eligible.map((r) => ({ r, cents: r.part1Cents, part: 1 })));
      t.rounds.push({ no: roundNo, at: nowIso(), households: eligible.length, perHouseholdCents: per, part1Cents: part1, part2DueAt: dueAt, batchId: batch.senderBatchId });
      await submitPayout(d, batch);
      return { round: t.rounds.at(-1), summary: aidSummary(d) };
    });
  }

  async function releaseSecondParts(districtId) {
    const d = getDistrict(districtId);
    return withLock(`district:${d.id}`, async () => {
      const t = d.trigger;
      if (!t) throw new HttpError(409, 'Nothing to release.');
      const due = d.registrants.filter((r) => r.entitlementCents && !r.part2Paid && r.status === 'ELIGIBLE' && Date.parse(r.part2DueAt) <= Date.now());
      if (!due.length) throw new HttpError(409, 'No second payments are due yet; they are released after the review period.');
      const batch = makeBatch(d, `R${t.rounds.length}B-${t.payouts.length + 1}`, due.map((r) => ({ r, cents: r.part2Cents, part: 2 })));
      due.forEach((r) => { r.part2Paid = true; });
      await submitPayout(d, batch);
      return { summary: aidSummary(d) };
    });
  }

  function makeBatch(d, tag, lines) {
    const t = d.trigger;
    const senderBatchId = `FG-${d.id.toUpperCase().slice(0, 18)}-${t.id}-${tag}`;
    const batch = {
      senderBatchId,
      amountCents: sumCents(lines.map((l) => l.cents)),
      createState: 'REQUESTED', payoutBatchId: null, batchStatus: null, simulated: t.simulated,
      items: lines.map(({ r, cents, part }, i) => ({
        senderItemId: `${senderBatchId}-${i + 1}`,
        receiver: r.email,
        partnerName: r.id,
        registrantId: r.id,
        part,
        amountCents: cents,
        note: `Floodgate direct aid for ${d.shortName}, payment ${part} of 2 (${r.id}).`,
        payoutItemId: null, status: 'NOT_SUBMITTED', errors: null, updatedAt: nowIso(),
      })),
      error: null, createdAt: nowIso(), updatedAt: nowIso(),
    };
    t.payouts.push(batch);
    return batch;
  }

  // ---------------- Live events (GDACS) ----------------
  // Earthquakes, wildfires and cyclones that GDACS rates Orange or Red open a campaign automatically.
  function upsertLiveEvents(events) {
    let added = 0;
    for (const e of events) {
      const id = `live-${e.type.toLowerCase()}-${e.eventId}`;
      if (state.districts.has(id)) continue;
      const at = nowIso();
      const hazard = { EQ: 'earthquake', WF: 'wildfire', TC: 'cyclone' }[e.type] || 'disaster';
      state.districts.set(id, {
        id, kind: 'live', hazard, name: e.name, shortName: e.shortName, area: 'Live events', region: e.region || '',
        country: e.country, countryCode: e.iso2 || null, river: null, basin: null, lat: e.lat, lon: e.lon,
        language: e.language, threshold: null, referenceBaselineM3s: null,
        partner: { name: '—', email: '' }, households: [],
        radiusKm: e.radiusKm, payoutsSupported: PAYOUT_COUNTRIES.has(e.country),
        status: 'TRIGGERED', watchEndsAt: null, scenario: null, release: null, registrants: [],
        event: { source: 'GDACS', type: e.type, eventId: e.eventId, alertLevel: e.alertLevel, severity: e.severity, startedAt: e.fromDate, url: e.url },
        lastEvaluation: null,
        trigger: {
          id: `TRG-${shortId()}`, at, simulated: false, live: true,
          evaluation: { valid: true, trigger: true, alertLevel: e.alertLevel, severity: e.severity },
          heldAtTriggerCents: 0, assessment: null, allocations: [], payouts: [], rounds: [], captureFailures: 0,
          settlement: 'AWAITING_FUNDS', capturedCents: 0,
          registrationClosesAt: new Date(Date.now() + AID_RULES.registrationHours * 3600_000).toISOString(),
        },
      });
      added += 1;
      const d = state.districts.get(id);
      if (ai.assessEvent) {
        ai.assessEvent({ district: d, event: d.event }).then((a) => { d.trigger.assessment = a; }).catch(() => {});
      }
    }
    return added;
  }

  // ---------------- PayPal webhooks ----------------
  // Called only after the route has verified the signature with PayPal. Payout state from a
  // webhook is applied immediately; the caller then re-reads the batch from PayPal so the
  // stored status always matches PayPal's own record.
  function applyWebhookEvent(evt) {
    const r = evt?.resource ?? {};
    const batchId = r.payout_batch_id || r.batch_header?.payout_batch_id || null;
    const entry = {
      id: String(evt?.id ?? ''), type: String(evt?.event_type ?? 'UNKNOWN'), at: nowIso(),
      resourceId: r.payout_item_id || batchId || r.id || null, districtId: null, duplicate: false,
    };
    if (entry.id && state.webhookEvents.some((e) => e.id === entry.id)) {
      entry.duplicate = true;
      return entry;
    }
    if (batchId) {
      for (const d of state.districts.values()) {
        for (const b of d.trigger?.payouts ?? []) {
          if (b.payoutBatchId !== batchId) continue;
          entry.districtId = d.id;
          if (r.batch_header?.batch_status) b.batchStatus = r.batch_header.batch_status;
          if (r.payout_item_id) {
            const sid = r.payout_item?.sender_item_id;
            const item = b.items.find((i) => i.payoutItemId === r.payout_item_id || (sid && i.senderItemId === sid)) ?? (b.items.length === 1 ? b.items[0] : null);
            if (item) {
              item.payoutItemId = r.payout_item_id;
              if (r.transaction_status) item.status = r.transaction_status;
              item.updatedAt = nowIso();
            }
          }
          b.lastWebhookAt = entry.at;
          b.lastWebhookType = entry.type;
        }
      }
    } else if (r.id) {
      for (const p of state.pledges.values()) {
        if (p.authorization?.id === r.id || p.capture?.id === r.id) entry.districtId = p.districtId;
      }
    }
    state.webhookEvents.unshift(entry);
    if (state.webhookEvents.length > 100) state.webhookEvents.length = 100;
    return entry;
  }

  function setWebhookStatus(s) { Object.assign(webhookStatus, s); }

  async function refreshPayouts(districtId) {
    const districts = districtId ? [getDistrict(districtId)] : [...state.districts.values()];
    for (const d of districts) {
      for (const b of d.trigger?.payouts ?? []) {
        if (b.createState !== 'CREATED' || TERMINAL_BATCH.includes(b.batchStatus)) continue;
        try {
          const res = await provider.getPayout(b.payoutBatchId);
          b.batchStatus = res.batchStatus;
          for (const item of b.items) {
            const r = res.items.find((x) => x.senderItemId === item.senderItemId) ?? (res.items.length === 1 ? res.items[0] : null);
            if (!r) continue;
            item.payoutItemId = r.payoutItemId;
            item.status = r.transactionStatus || item.status;
            item.errors = r.errors;
            item.updatedAt = nowIso();
          }
          b.lastPolledAt = nowIso();
          b.pollError = null;
        } catch (e) {
          b.pollError = e.message;
        }
        b.updatedAt = nowIso();
      }
    }
  }

  // ---------------- Release ----------------

  async function release(districtId, { reason = 'manual' } = {}) {
    const d = getDistrict(districtId);
    return withLock(`district:${d.id}`, async () => {
      if (d.status === 'TRIGGERED') throw new HttpError(409, `${d.shortName} has triggered; held pledges were captured and cannot be released.`);
      const pending = pledgesFor(d.id).filter((p) => p.status === 'AUTHORIZED');
      const failures = [];
      for (const p of pending) {
        transition(p, 'VOIDING');
        try {
          const res = await provider.voidAuthorization({ authorizationId: p.authorization.id, requestId: `fg-void-${p.authorization.id}` });
          p.void = { status: res.status || 'VOIDED', at: nowIso() };
          transition(p, 'VOIDED');
        } catch (e) {
          transition(p, 'AUTHORIZED');
          p.errors.push({ at: nowIso(), op: 'void', message: e.message });
          p.lastVoidError = e.message;
          failures.push({ pledgeId: p.id, message: e.message });
        }
      }
      for (const p of pledgesFor(d.id).filter((x) => x.status === 'CREATED')) transition(p, 'CANCELLED');
      d.status = 'RELEASED';
      d.scenario = null;
      d.release = {
        at: d.release?.at ?? nowIso(),
        lastAttemptAt: nowIso(),
        reason,
        voidedCents: sumStatus(d.id, ['VOIDED']),
        voidFailures: failures.length,
      };
      return { outcome: failures.length ? 'RELEASED_WITH_FAILURES' : 'RELEASED', district: d.id, failures };
    });
  }

  async function expireWatchWindows() {
    const now = Date.now();
    for (const d of state.districts.values()) {
      if (d.status === 'WATCHING' && Date.parse(d.watchEndsAt) <= now) {
        await release(d.id, { reason: 'watch-window-expired' }).catch((e) => log.warn?.(`[floodgate] auto-release ${d.id}: ${e.message}`));
      }
    }
  }

  // ---------------- Snapshots ----------------

  function districtSummary(d) {
    const pl = pledgesFor(d.id);
    const t = d.trigger;
    return {
      id: d.id, kind: d.kind, hazard: d.hazard, event: d.event ?? null, radiusKm: d.radiusKm, payoutsSupported: d.payoutsSupported,
      registration: registrationState(d), aid: aidSummary(d),
      registrants: d.registrants.map(publicRegistrant),
      name: d.name, shortName: d.shortName, area: d.area, region: d.region, country: d.country,
      river: d.river, basin: d.basin, lat: d.lat, lon: d.lon, language: d.language,
      threshold: d.threshold, referenceBaselineM3s: d.referenceBaselineM3s,
      partner: { name: d.partner.name, email: config.payoutRecipientOverride || d.partner.email, sample: true },
      households: d.households,
      status: d.status,
      watchEndsAt: d.watchEndsAt,
      scenario: d.scenario,
      lastEvaluation: d.lastEvaluation,
      release: d.release,
      totals: {
        heldCents: sumStatus(d.id, ['AUTHORIZED', 'CAPTURING', 'VOIDING']),
        capturedCents: sumCents(pl.filter((p) => p.status === 'CAPTURED').map((p) => p.capture.amountCents)),
        voidedCents: sumStatus(d.id, ['VOIDED']),
        pledgeCount: pl.filter((p) => !['CANCELLED', 'CREATED', 'AUTH_FAILED'].includes(p.status)).length,
        payoutInitiatedCents: t ? sumCents(t.payouts.filter((b) => b.createState === 'CREATED').map((b) => b.amountCents)) : 0,
        payoutCompletedCents: t ? sumCents(t.payouts.flatMap((b) => b.items).filter((i) => i.status === 'SUCCESS').map((i) => i.amountCents)) : 0,
      },
      trigger: t ? {
        id: t.id, at: t.at, simulated: t.simulated, evaluation: t.evaluation, series: t.series,
        assessment: t.assessment, allocations: t.allocations, allocationTotalCents: t.allocationTotalCents,
        capturedCents: t.capturedCents, heldAtTriggerCents: t.heldAtTriggerCents,
        payouts: t.payouts.map(publicBatch), settlement: t.settlement, rounds: t.rounds, live: Boolean(t.live),
        registrationClosesAt: t.registrationClosesAt,
      } : null,
      sample: true,
    };
  }

  // Public views never expose recipient emails, PayPal subjects or exact coordinates.
  function publicRegistrant(r) {
    return {
      id: r.id, householdSize: r.householdSize, distanceKm: r.distanceKm, locationSource: r.locationSource, flags: r.flags,
      status: r.status, registeredAt: r.registeredAt, entitlementCents: r.entitlementCents, part1Cents: r.part1Cents,
      part2Cents: r.part2Cents, part2DueAt: r.part2DueAt, part2Paid: r.part2Paid, round: r.round,
    };
  }
  function publicBatch(b) {
    return { ...b, items: b.items.map(({ receiver, ...rest }) => ({ ...rest, receiver: maskEmail(receiver) })) };
  }
  function maskEmail(e) {
    if (!e || !e.includes('@')) return '';
    const [u, dom] = e.split('@');
    return `${u.slice(0, 2)}•••@${dom}`;
  }

  function pledgeView(p) {
    return {
      id: p.id, districtId: p.districtId, amountCents: p.amountCents, donorLabel: p.donorLabel, provider: p.provider,
      orderId: p.orderId, status: p.status, authorization: p.authorization, capture: p.capture, void: p.void,
      triggerId: p.triggerId, errors: p.errors.slice(-3), createdAt: p.createdAt, updatedAt: p.updatedAt,
    };
  }

  function ledgerRows() {
    const rows = [];
    const prov = (p) => (p === 'paypal' ? 'PAYPAL SANDBOX' : 'MOCK');
    for (const d of state.districts.values()) {
      const t = d.trigger;
      const basisFor = (p) => (p.triggerId && t ? (t.simulated ? 'SCENARIO' : 'LIVE') : '—');
      for (const p of pledgesFor(d.id)) {
        rows.push({ id: `${p.id}`, time: p.createdAt, type: 'Pledge', district: d.shortName, party: p.donorLabel, amount: p.amountCents / 100, currency: 'USD', status: p.status, reference: p.orderId, scenario: basisFor(p), provider: prov(p.provider), zone: '', note: p.errors.at(-1)?.message ?? '' });
        if (p.authorization) rows.push({ id: `${p.id}-auth`, time: p.authorization.at, type: 'Authorization', district: d.shortName, party: p.donorLabel, amount: (p.authorization.amountCents ?? 0) / 100, currency: 'USD', status: p.status === 'AUTH_FAILED' ? 'REJECTED' : p.status === 'CAPTURED' ? 'CAPTURED' : p.status === 'VOIDED' ? 'VOIDED' : 'HELD', reference: p.authorization.id, scenario: basisFor(p), provider: prov(p.provider), zone: '', note: p.authorization.expirationTime ? `expires ${p.authorization.expirationTime.slice(0, 10)}` : '' });
        if (p.capture) rows.push({ id: `${p.id}-cap`, time: p.capture.at, type: 'Capture', district: d.shortName, party: p.donorLabel, amount: p.capture.amountCents / 100, currency: 'USD', status: p.capture.status === 'COMPLETED' ? 'CAPTURED' : `CAPTURE_${p.capture.status}`, reference: p.capture.id, scenario: basisFor(p), provider: prov(p.provider), zone: '', note: '' });
        else if (p.lastCaptureError && p.status === 'AUTHORIZED') rows.push({ id: `${p.id}-capfail`, time: p.updatedAt, type: 'Capture', district: d.shortName, party: p.donorLabel, amount: p.amountCents / 100, currency: 'USD', status: 'CAPTURE_FAILED', reference: p.authorization?.id ?? '', scenario: t?.simulated ? 'SCENARIO' : 'LIVE', provider: prov(p.provider), zone: '', note: p.lastCaptureError });
        if (p.void) rows.push({ id: `${p.id}-void`, time: p.void.at, type: 'Void', district: d.shortName, party: p.donorLabel, amount: p.amountCents / 100, currency: 'USD', status: 'VOIDED', reference: p.authorization.id, scenario: '—', provider: prov(p.provider), zone: '', note: 'Hold released' });
        else if (p.lastVoidError && p.status === 'AUTHORIZED') rows.push({ id: `${p.id}-voidfail`, time: p.updatedAt, type: 'Void', district: d.shortName, party: p.donorLabel, amount: p.amountCents / 100, currency: 'USD', status: 'VOID_FAILED', reference: p.authorization?.id ?? '', scenario: '—', provider: prov(p.provider), zone: '', note: p.lastVoidError });
      }
      if (t) {
        const sc = t.simulated ? 'SCENARIO' : 'LIVE';
        rows.push({ id: t.id, time: t.at, type: 'Trigger', district: d.shortName, party: t.live ? `GDACS ${d.event?.alertLevel} alert` : 'Floodgate trigger engine', amount: capturedCentsFor(d) / 100, currency: 'USD', status: 'TRIGGERED', reference: t.id, scenario: sc, provider: providerLabel(), zone: '', note: t.live ? `${d.event?.type} ${d.event?.eventId}: ${d.event?.severity}` : `ratio ${t.evaluation.ratio.toFixed(2)} >= ${d.threshold}` });
        for (const b of t.payouts) {
          rows.push({ id: b.senderBatchId, time: b.createdAt, type: 'Payout batch', district: d.shortName, party: `${b.items.length} household(s)`, amount: b.amountCents / 100, currency: 'USD', status: b.createState === 'REQUEST_FAILED' ? 'REQUEST_FAILED' : b.batchStatus || b.createState, reference: b.payoutBatchId || b.senderBatchId, scenario: sc, provider: providerLabel(), zone: '', note: b.error || b.pollError || `sender_batch_id ${b.senderBatchId}` });
          for (const i of b.items) rows.push({ id: i.senderItemId, time: b.createdAt, type: 'Payout item', district: d.shortName, party: `${i.registrantId || i.partnerName} <${maskEmail(i.receiver)}>`, amount: i.amountCents / 100, currency: 'USD', status: i.status, reference: i.payoutItemId || '—', scenario: sc, provider: providerLabel(), zone: '', note: i.errors || (i.part ? `payment ${i.part} of 2` : '') });
        }
      }
      for (const r of d.registrants) rows.push({ id: `${d.id}-${r.id}`, time: r.registeredAt, type: 'Registration', district: d.shortName, party: `${r.id} (household of ${r.householdSize})`, amount: r.entitlementCents ? r.entitlementCents / 100 : null, currency: r.entitlementCents ? 'USD' : '', status: r.status, reference: r.id, scenario: '—', provider: 'PAYPAL IDENTITY', zone: '', note: [`${r.distanceKm} km`, ...r.flags].join(' · ') });
      if (d.release) rows.push({ id: `${d.id}-release`, time: d.release.at, type: 'Release', district: d.shortName, party: 'Watch window closed', amount: d.release.voidedCents / 100, currency: 'USD', status: d.release.voidFailures ? 'RELEASED_WITH_FAILURES' : 'RELEASED', reference: '—', scenario: '—', provider: providerLabel(), zone: '', note: d.release.reason });
    }
    for (const e of state.webhookEvents) {
      if (e.duplicate) continue;
      const d = e.districtId ? state.districts.get(e.districtId) : null;
      rows.push({ id: `wh-${e.id}`, time: e.at, type: 'PayPal webhook', district: d?.shortName ?? '—', party: 'PayPal (signature verified)', amount: null, currency: '', status: e.type, reference: e.resourceId || e.id, scenario: '—', provider: providerLabel(), zone: '', note: `Event ${e.id}` });
    }
    rows.sort((a, b) => (a.time < b.time ? 1 : -1));
    return rows;
  }

  function snapshot() {
    return {
      seededAt: state.seededAt,
      mode: provider.mode,
      districts: [...state.districts.values()].map(districtSummary),
      pledges: [...state.pledges.values()].map(pledgeView),
      ledger: ledgerRows(),
      webhooks: { enabled: webhookStatus.enabled, error: webhookStatus.error, lastEventAt: state.webhookEvents[0]?.at ?? null, received: state.webhookEvents.length },
    };
  }

  return {
    reset,
    get provider() { return provider; },
    getDistrict,
    forecastView,
    createPledge,
    authorizePledge,
    setScenario,
    evaluate,
    release,
    refreshPayouts,
    registerRecipient,
    disburseRound,
    releaseSecondParts,
    upsertLiveEvents,
    aidSummary: (id) => aidSummary(getDistrict(id)),
    applyWebhookEvent,
    setWebhookStatus,
    get webhookStatus() { return webhookStatus; },
    expireWatchWindows,
    snapshot,
    districtSummary: (id) => districtSummary(getDistrict(id)),
    _state: () => state,
  };
}
