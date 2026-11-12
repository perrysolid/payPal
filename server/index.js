import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createForecastService } from './forecast.js';
import { createAiService } from './ai.js';
import { createFloodService } from './floods.js';
import { createEngine, HttpError } from './engine.js';
import { createMockProvider } from './payments/mock.js';
import { createPayPalProvider } from './payments/paypal.js';
import { DISTRICT_IDS } from './data/districts.js';
import { createEventService } from './events.js';
import { createIdentityService } from './identity.js';
import { createSupplyService } from './supplies.js';
import { AID_RULES } from './engine.js';

export const WEBHOOK_PATH = '/api/webhooks/paypal';
export const WEBHOOK_EVENTS = [
  'PAYMENT.PAYOUTSBATCH.SUCCESS', 'PAYMENT.PAYOUTSBATCH.DENIED', 'PAYMENT.PAYOUTSBATCH.PROCESSING',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', 'PAYMENT.PAYOUTS-ITEM.FAILED', 'PAYMENT.PAYOUTS-ITEM.BLOCKED',
  'PAYMENT.PAYOUTS-ITEM.CANCELED', 'PAYMENT.PAYOUTS-ITEM.DENIED', 'PAYMENT.PAYOUTS-ITEM.HELD',
  'PAYMENT.PAYOUTS-ITEM.REFUNDED', 'PAYMENT.PAYOUTS-ITEM.RETURNED', 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
  'PAYMENT.AUTHORIZATION.CREATED', 'PAYMENT.AUTHORIZATION.VOIDED',
  'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.DENIED',
];

loadEnvFile();
const config = loadConfig();
config.warnings.forEach((w) => console.warn(`[floodgate] ${w}`));

export function createApp({ cfg = config, forecast = createForecastService(), ai = createAiService(cfg.ai), floods = createFloodService(), providerFactory, events = createEventService(), supplies = createSupplyService({ apiKey: process.env.CHANNEL3_API_KEY }) } = {}) {
  const factory = providerFactory ?? (() => (cfg.paymentMode === 'paypal' ? createPayPalProvider(cfg.paypal) : createMockProvider()));
  const engine = createEngine({ providerFactory: factory, forecast, ai, config: cfg });
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({
    limit: '64kb',
    // Keep the exact bytes of webhook deliveries for signature verification.
    verify: (req, res, buf) => { if (req.originalUrl === WEBHOOK_PATH) req.rawBody = buf.toString('utf8'); },
  }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const districtParam = (req) => {
    const id = String(req.params.id || '');
    if (!/^[a-z0-9-]{3,60}$/.test(id)) throw new HttpError(404, `Unknown campaign "${id}"`);
    engine.getDistrict(id); // 404 if unknown
    return id;
  };
  const identity = createIdentityService({ cfg });
  const publicBase = (req) => (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const callbackUrl = (req) => `${publicBase(req)}/api/auth/paypal/callback`;

  async function loadLiveEvents() {
    try { engine.upsertLiveEvents(await events.list()); } catch (e) { console.warn(`[floodgate] GDACS: ${e.message}`); }
  }
  app.locals.loadLiveEvents = loadLiveEvents;

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/config', (req, res) => {
    res.json({
      paymentMode: engine.provider.mode,
      paypalClientId: cfg.paymentMode === 'paypal' ? cfg.paypal.clientId : null, // public client ID only
      paypalEnvironment: cfg.paymentMode === 'paypal' ? 'sandbox' : null,
      ai: { enabled: ai.enabled, model: ai.enabled ? ai.model : null },
      payoutRecipientOverride: Boolean(cfg.payoutRecipientOverride),
      webhooks: { enabled: engine.webhookStatus.enabled },
      aidRules: AID_RULES,
      bryntumLicenseKey: process.env.BRYNTUM_LICENSE_KEY || null, // client-side license key by design
      suppliesEnabled: supplies.enabled,
      limits: { minPledge: '1.00', maxPledge: '1000.00', currency: 'USD' },
      disclaimers: [
        'Payments are processed in the PayPal Sandbox environment.',
        'Payouts are made to registered relief partners, who distribute funds to households according to the allocation ledger.',
        'Relief partner and household records shown are illustrative.',
        'Scenario runs overlay a modelled surge on the live forecast and are labelled wherever they appear.',
      ],
    });
  });

  const specPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/openapi.yaml');
  app.get('/api/openapi.yaml', (req, res) => res.type('application/yaml').sendFile(specPath));
  app.get('/api/floods', wrap(async (req, res) => res.json(await floods.get())));

  app.get('/api/state', (req, res) => res.json(engine.snapshot()));

  app.get('/api/districts/:id/forecast', wrap(async (req, res) => {
    const d = engine.getDistrict(districtParam(req));
    if (d.kind === 'live') return res.json({ live: null, simulated: null, event: d.event });
    const view = await engine.forecastView(d, { force: req.query.refresh === '1' });
    res.json(view);
  }));

  app.post('/api/districts/:id/scenario', wrap(async (req, res) => {
    const id = districtParam(req);
    const active = req.body?.active === true;
    engine.setScenario(id, active);
    const view = await engine.forecastView(engine.getDistrict(id));
    res.json({ district: engine.districtSummary(id), forecast: view });
  }));

  app.post('/api/pledges', wrap(async (req, res) => {
    const { districtId, amount, donorName } = req.body || {};
    if (typeof districtId !== 'string' || !/^[a-z0-9-]{3,60}$/.test(districtId)) throw new HttpError(400, 'districtId is invalid');
    engine.getDistrict(districtId);
    if (typeof amount !== 'string' && typeof amount !== 'number') throw new HttpError(400, 'amount is required');
    const p = await engine.createPledge({ districtId, amount, donorName });
    res.status(201).json({ orderId: p.orderId, pledgeId: p.id, amount: (p.amountCents / 100).toFixed(2), currency: 'USD' });
  }));

  app.post('/api/pledges/:orderId/authorize', wrap(async (req, res) => {
    const orderId = String(req.params.orderId || '');
    if (!/^[A-Za-z0-9-]{6,64}$/.test(orderId)) throw new HttpError(400, 'orderId is invalid');
    const { pledge, idempotent } = await engine.authorizePledge(orderId);
    res.json({
      idempotent,
      pledgeId: pledge.id,
      status: pledge.status,
      authorizationId: pledge.authorization?.id,
      amount: (pledge.amountCents / 100).toFixed(2),
      currency: 'USD',
    });
  }));

  app.post('/api/districts/:id/evaluate', wrap(async (req, res) => {
    const id = districtParam(req);
    const result = await engine.evaluate(id);
    res.json({ ...result, district: engine.districtSummary(id) });
  }));

  app.post('/api/districts/:id/release', wrap(async (req, res) => {
    const id = districtParam(req);
    const result = await engine.release(id, { reason: 'manual-close-of-watch-window' });
    res.json({ ...result, district: engine.districtSummary(id) });
  }));

  app.post('/api/districts/:id/payouts/refresh', wrap(async (req, res) => {
    const id = districtParam(req);
    await engine.refreshPayouts(id);
    res.json({ district: engine.districtSummary(id) });
  }));

  app.post(WEBHOOK_PATH, wrap(async (req, res) => {
    const ws = engine.webhookStatus;
    if (!ws.enabled || !ws.webhookId || typeof engine.provider.verifyWebhook !== 'function') {
      return res.status(503).json({ error: 'Webhooks are not configured' });
    }
    let verified = false;
    try {
      verified = await engine.provider.verifyWebhook({ headers: req.headers, rawBody: req.rawBody, webhookId: ws.webhookId });
    } catch (e) {
      console.warn(`[floodgate] webhook verification error: ${e.message}`);
    }
    if (!verified) return res.status(400).json({ error: 'Webhook signature could not be verified' });
    const entry = engine.applyWebhookEvent(req.body);
    console.log(`[floodgate] webhook ${entry.type} ${entry.id}${entry.duplicate ? ' (duplicate)' : ''}`);
    if (!entry.duplicate && entry.type.startsWith('PAYMENT.PAYOUTS')) engine.refreshPayouts(entry.districtId || undefined).catch(() => {});
    res.json({ received: true });
  }));

  // ---- Direct aid: Log in with PayPal, registration, payment rounds ----
  app.get('/api/auth/paypal/start', (req, res, next) => {
    try {
      const districtId = String(req.query.district || '');
      engine.getDistrict(districtId);
      const { url } = identity.startUrl({ districtId, redirectUri: callbackUrl(req) });
      res.redirect(302, url);
    } catch (e) { next(e); }
  });

  app.get('/api/auth/paypal/callback', wrap(async (req, res) => {
    if (req.query.error) return res.redirect(302, `/?register_error=${encodeURIComponent(String(req.query.error_description || req.query.error))}`);
    try {
      const { token, districtId } = await identity.complete({ code: String(req.query.code || ''), state: String(req.query.state || ''), redirectUri: callbackUrl(req) });
      res.redirect(302, `/?register=${token}&district=${encodeURIComponent(districtId)}`);
    } catch (e) {
      res.redirect(302, `/?register_error=${encodeURIComponent(e.message)}`);
    }
  }));

  app.get('/api/auth/session/:token', (req, res) => {
    const s = identity.session(req.params.token);
    if (!s) return res.status(404).json({ error: 'Sign-in session expired. Sign in with PayPal again.' });
    const { identity: id } = s;
    res.json({ districtId: s.districtId, verified: id.verified, country: id.country, name: id.name, email: id.email.replace(/^(.{2}).*@/, '$1•••@') });
  });

  app.post('/api/districts/:id/registrations', wrap(async (req, res) => {
    const id = districtParam(req);
    const s = identity.session(req.body?.token);
    if (!s || s.districtId !== id) throw new HttpError(401, 'Sign in with PayPal for this campaign first.');
    const loc = req.body?.location || {};
    const r = await engine.registerRecipient({
      districtId: id, identity: s.identity, householdSize: req.body?.householdSize,
      location: { lat: loc.lat, lon: loc.lon, source: loc.source === 'manual' ? 'manual' : 'device' },
    });
    identity.consume(req.body.token);
    res.status(201).json({ id: r.id, status: r.status, flags: r.flags, distanceKm: r.distanceKm, district: engine.districtSummary(id) });
  }));

  app.post('/api/districts/:id/disburse', wrap(async (req, res) => {
    const id = districtParam(req);
    const r = await engine.disburseRound(id);
    res.json({ ...r, district: engine.districtSummary(id) });
  }));

  app.post('/api/districts/:id/release-second', wrap(async (req, res) => {
    const id = districtParam(req);
    const r = await engine.releaseSecondParts(id);
    res.json({ ...r, district: engine.districtSummary(id) });
  }));

  app.get('/api/districts/:id/essentials', wrap(async (req, res) => {
    const d = engine.getDistrict(districtParam(req));
    res.json(await supplies.essentials(d.hazard));
  }));

  app.post('/api/live-events/refresh', wrap(async (req, res) => {
    events.clear?.();
    await loadLiveEvents();
    res.json({ ok: true });
  }));

  app.post('/api/ask', wrap(async (req, res) => {
    const q = req.body?.question;
    if (typeof q !== 'string' || !q.trim() || q.length > 300) throw new HttpError(400, 'question must be 1-300 characters');
    res.json(await ai.askLedger(q.trim()));
  }));

  app.post('/api/reset', (req, res) => {
    engine.reset();
    forecast.clear?.();
    loadLiveEvents();
    res.json({
      ok: true,
      note: 'Records cleared and district data restored. Completed PayPal transactions are not reversed.',
    });
  });

  // Static frontend in production.
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' });
    const status = err instanceof HttpError ? err.status : err.status && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error(`[floodgate] ${req.method} ${req.path}: ${err.message}`);
    res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? `Internal error: ${err.message}` : err.message, debugId: err.debugId });
  });

  return { app, engine };
}

async function setupWebhooks(engine) {
  if (config.paymentMode !== 'paypal' || typeof engine.provider.ensureWebhook !== 'function') return;
  const base = (process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  if (!/^https:\/\//.test(base)) {
    console.log('[floodgate] webhooks off: no public https URL (set PUBLIC_BASE_URL); payout status is polled');
    return;
  }
  const url = `${base}${WEBHOOK_PATH}`;
  let webhookId = process.env.PAYPAL_WEBHOOK_ID || null;
  if (!webhookId) {
    const r = await engine.provider.ensureWebhook(url, WEBHOOK_EVENTS);
    webhookId = r.id;
    console.log(`[floodgate] PayPal webhook ${r.created ? 'registered' : 'found'} for ${url}`);
  }
  engine.setWebhookStatus({ enabled: true, url, webhookId, error: null });
}

function loadEnvFile() {
  const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { app, engine } = createApp();
  app.locals.loadLiveEvents();
  setInterval(() => { app.locals.loadLiveEvents(); }, 15 * 60_000).unref();
  setupWebhooks(engine).catch((e) => {
    engine.setWebhookStatus({ enabled: false, error: e.message });
    console.warn(`[floodgate] webhooks disabled: ${e.message}`);
  });
  // Polling remains as a fallback: every 10 s without webhooks, every 60 s with them.
  let lastPoll = 0;
  setInterval(() => {
    const every = engine.webhookStatus.enabled ? 60_000 : 10_000;
    if (Date.now() - lastPoll < every) return;
    lastPoll = Date.now();
    engine.refreshPayouts().catch(() => {});
  }, 10_000).unref();
  setInterval(() => { engine.expireWatchWindows().catch(() => {}); }, 60_000).unref();
  app.listen(config.port, () => {
    console.log(`[floodgate] listening on :${config.port} | payments=${config.paymentMode.toUpperCase()} | ai=${config.ai ? 'claude' : 'offline-template'}`);
  });
}
