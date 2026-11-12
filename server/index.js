import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createForecastService } from './forecast.js';
import { createAiService } from './ai.js';
import { createEngine, HttpError } from './engine.js';
import { createMockProvider } from './payments/mock.js';
import { createPayPalProvider } from './payments/paypal.js';
import { DISTRICT_IDS } from './data/districts.js';

loadEnvFile();
const config = loadConfig();
config.warnings.forEach((w) => console.warn(`[floodgate] ${w}`));

export function createApp({ cfg = config, forecast = createForecastService(), ai = createAiService(cfg.ai), providerFactory } = {}) {
  const factory = providerFactory ?? (() => (cfg.paymentMode === 'paypal' ? createPayPalProvider(cfg.paypal) : createMockProvider()));
  const engine = createEngine({ providerFactory: factory, forecast, ai, config: cfg });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  const districtParam = (req) => {
    const id = String(req.params.id || '');
    if (!DISTRICT_IDS.includes(id)) throw new HttpError(404, `Unknown district "${id}"`);
    return id;
  };

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/config', (req, res) => {
    res.json({
      paymentMode: engine.provider.mode,
      paypalClientId: cfg.paymentMode === 'paypal' ? cfg.paypal.clientId : null, // public client ID only
      paypalEnvironment: cfg.paymentMode === 'paypal' ? 'sandbox' : null,
      ai: { enabled: ai.enabled, model: ai.enabled ? ai.model : null },
      payoutRecipientOverride: Boolean(cfg.payoutRecipientOverride),
      limits: { minPledge: '1.00', maxPledge: '1000.00', currency: 'USD' },
      disclaimers: [
        'Payments are processed in the PayPal Sandbox environment.',
        'Payouts are made to registered relief partners, who distribute funds to households according to the allocation ledger.',
        'Relief partner and household records shown are illustrative.',
        'Scenario runs overlay a modelled surge on the live forecast and are labelled wherever they appear.',
      ],
    });
  });

  app.get('/api/state', (req, res) => res.json(engine.snapshot()));

  app.get('/api/districts/:id/forecast', wrap(async (req, res) => {
    const d = engine.getDistrict(districtParam(req));
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
    if (typeof districtId !== 'string' || !DISTRICT_IDS.includes(districtId)) throw new HttpError(400, 'districtId is invalid');
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

  app.post('/api/ask', wrap(async (req, res) => {
    const q = req.body?.question;
    if (typeof q !== 'string' || !q.trim() || q.length > 300) throw new HttpError(400, 'question must be 1-300 characters');
    res.json(await ai.askLedger(q.trim()));
  }));

  app.post('/api/reset', (req, res) => {
    engine.reset();
    forecast.clear?.();
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
  setInterval(() => { engine.refreshPayouts().catch(() => {}); }, 10_000).unref();
  setInterval(() => { engine.expireWatchWindows().catch(() => {}); }, 60_000).unref();
  app.listen(config.port, () => {
    console.log(`[floodgate] listening on :${config.port} | payments=${config.paymentMode.toUpperCase()} | ai=${config.ai ? 'claude' : 'offline-template'}`);
  });
}
