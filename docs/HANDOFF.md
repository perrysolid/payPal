# Floodgate — handoff (12 Nov 2026, ~23:30 IST)

Submission deadline: **1:30 AM IST, 13 Nov 2026** (PayPal AI Hackathon, Devpost).

## The idea in one line

**Give before the disaster, and see exactly whom you helped.**
When you give to a donation drive you never learn whom your money reached. Floodgate pays verified
households directly through PayPal, with no NGO or government in between, and every cent is traceable
on a public ledger: your pledge → the trigger → the payout batch → each household (anonymous ID).

## How it works

1. **Pledge before the disaster.** Donors place a PayPal *authorization* (a hold, not a charge) on an
   at-risk area. Nobody is charged unless the trigger fires.
2. **Rules decide the trigger, not people.**
   - Forecast hazards: river floods (GloFAS via Open-Meteo, live data, 13 districts in 10 countries).
   - Live events that cannot be forecast: earthquakes, wildfires, cyclones. A GDACS Orange or Red alert
     opens a campaign automatically, and donations made then are captured immediately.
3. **Affected households register with "Log in with PayPal".** PayPal has already verified its account
   holders, so Floodgate stores no ID documents or videos. The device location must be inside the
   campaign radius. Registration is limited to one per PayPal account.
4. **Equal split, paid in two parts.** Each round divides the unallocated pool equally among newly
   verified households, up to USD 100 each. 50% is paid now through one PayPal Payouts batch; the other
   50% after a 48-hour review. Unusual registrations (for example, many from the same spot) are held
   for review.
5. **Transparency.** The public ledger shows every authorization, capture, payout item and registration
   with PayPal reference IDs, using anonymous recipient IDs (`R-XXXXXXXX`) and masked emails. PayPal
   webhooks are signature-verified and recorded. Floodgate takes 0%; PayPal's own fees are shown, and
   Channel3 referral commissions are shown per product.

## Done and verified (on `main`, live at https://floodgate-5udu.onrender.com)

- Real PayPal Sandbox: order → authorize → capture → Payouts → SUCCESS; void on release.
  - IDs: capture `3BH97989N17631617`, payout batch `Q6CAHQJKQJRDY`, void `6P524970LP6381606`.
  - Hosted live trigger, Garissa, Kenya (Tana River at 2.34×): batch `LSBHVVE2PS5ZU`, item `W78CRG9Z5D9Y8` SUCCESS.
- PayPal webhooks: auto-registered from `RENDER_EXTERNAL_URL`, verified via `verify-webhook-signature`
  on the raw body, de-duplicated, written to the ledger. Four real events were verified on Render.
  Polling continues as a fallback.
- Claude Haiku 5.5 (`claude-haiku-5-5`): risk assessment plus alerts in 11 languages with script checks
  (Urdu right-to-left, genuine Maithili); "Ask the Ledger" builds AG Grid filters.
- AG Grid ledger (grouping, CSV export), Render Blueprint, OpenAPI spec `docs/openapi.yaml` (APIMatic),
  global districts with a region filter, phone layout checked at 390px.
- PayPal Payouts country check (developer.paypal.com/payouts/supported-features): **no** Payouts in
  Bangladesh, Pakistan, Nepal, Nigeria, Myanmar, Haiti, Fiji or Vanuatu. The app says so instead of pretending.

## Work in progress (branch `direct-aid`, not deployed)

Server side done, **tests pass (22)**:

| File | What it has |
|---|---|
| `server/engine.js` | `AID_RULES`, `PAYOUT_COUNTRIES`, `registerRecipient`, `disburseRound`, `releaseSecondParts`, `upsertLiveEvents`, anonymised public views, ledger `Registration` rows. A trigger now captures into a pool; there is no NGO payout. |
| `server/identity.js` | Log in with PayPal (OpenID Connect): `/api/auth/paypal/start` → PayPal → `/api/auth/paypal/callback` → one-time token. |
| `server/events.js` | GDACS live events (EQ, WF, TC; Orange/Red only; no key needed). |
| `server/supplies.js` | Channel3 SDK (`@channel3/sdk`): cheapest in-stock essentials per hazard, with commission rate. Tested live. |
| `server/ai.js` | `assessEvent` for live events. |
| `server/index.js` | Routes: `POST /api/districts/:id/registrations`, `/disburse`, `/release-second`, `GET /essentials`, `POST /api/live-events/refresh`, `GET /api/auth/session/:token`. `/api/config` now returns `aidRules`, `bryntumLicenseKey`, `suppliesEnabled`. |

Installed but **not wired** into the UI yet: `@bryntum/scheduler-enterprise` and `@bryntum/scheduler-react-enterprise` (8.0.1).

## Next steps for Claude Code (in order)

1. **UI: recipient portal** (in `client/src/components/`):
   - A "Register with PayPal" button that links to `/api/auth/paypal/start?district=<id>`.
   - On return, `App.jsx` reads `?register=<token>&district=`, calls `GET /api/auth/session/:token`, then
     shows a form: household size, "Use my location" (`navigator.geolocation`), and a Sandbox-only
     "use campaign centre" option (`source: 'manual'`). It POSTs to `/registrations`.
   - Show a rules card from `config.aidRules`.
   - List registrants (anonymous ID, distance, flags, status, part 1/part 2).
   - A "Run payment round" button that calls `/disburse`.
2. **UI: Settlement**. Replace the partner-payout table with the pool summary (`district.aid`), the
   rounds (`trigger.rounds`) and the payout items per anonymous recipient. Remove the zone-weight
   panel and the household allocation table, which are now obsolete.
3. **UI: Live events**. Show a "Live events" area chip and cards for districts with `kind === 'live'`
   (hazard icon, GDACS alert level, `event.url`). The detail view has no forecast chart; show the event
   facts, and donations are captured immediately.
4. **Bryntum Scheduler**. Lazy-load `BryntumScheduler` in the Assessment panel:
   - Resources: step owners plus "PayPal payments".
   - Events: `assessment.responseSteps` (offset from `trigger.at`), the registration window, and each
     round's part 1 and part 2 (`part2DueAt`).
   - Set `globalThis.bryntum.licenseKey = config.bryntumLicenseKey`.
   - CSS: `@bryntum/core-enterprise/core.thin.css`, `@bryntum/grid-enterprise/grid.thin.css`,
     `@bryntum/scheduler-enterprise/scheduler.thin.css`, `@bryntum/scheduler-enterprise/svalbard-light.css`.
   - Keep the existing SVG timeline as a fallback.
5. **Channel3 panel**: "What this aid can cover". `GET /api/districts/:id/essentials` returns image,
   title, price, merchant and referral-commission percentage.
6. **"Whom you helped" donor view**: for each pledge, show its share of every payout item (pro rata
   to the captured pool), with anonymous recipient IDs, amounts and PayPal item IDs. This is the
   transparency pitch.
7. **Test with three Sandbox resident accounts** (the user created them; credentials are in chat, not
   in the repo):
   - Log in with PayPal → register (Sandbox manual location) → run a round → check that the webhooks
     show SUCCESS.
   - Then run `npx vitest run`, build, merge `direct-aid` into `main`, and push. Render auto-deploys.
8. **README**: new pitch, rules, flaws and fixes table, roadmap (PayPal Vault for season-long pledges,
   optional ID check by an outside provider for flagged cases, a regulated entity holding the funds).

## Manual setup the user must do

- PayPal Developer → the Sandbox app → enable **Log in with PayPal**:
  - Return URLs: `http://localhost:8787/api/auth/paypal/callback` and
    `https://floodgate-5udu.onrender.com/api/auth/paypal/callback`.
  - Requested information: email, address, account verification status.
- Render → floodgate → Environment: add `CHANNEL3_API_KEY` and `BRYNTUM_LICENSE_KEY`.
- After judging, rotate the Anthropic key, the PayPal secret and the Channel3 key; all were pasted in chat.

## Known flaws and fixes (put this in the README)

| Problem | Fix |
|---|---|
| Fake or duplicate registrants | Verified PayPal accounts only; one per account; flags for location clusters; 50/50 split with a review period |
| Faked GPS | Account country must match the campaign country (enforced outside the Sandbox); 50% holdback |
| First come, first served | Equal split per round, with a per-household cap |
| Privacy | Anonymous IDs; emails masked; exact coordinates never published |
| No PayPal or no signal | Pre-registration before the season; countries without PayPal Payouts are shown as not covered |
| Law (handling money, sanctions screening) | Production needs a licensed entity or PayPal itself to hold funds. The rules decide who is paid, not people. |
| Holds expire after up to 29 days | Production: PayPal Vault, charging the saved payment method when the trigger fires |
| "No commission" | Floodgate takes 0%; PayPal fees and Channel3 referral rates are shown openly |
