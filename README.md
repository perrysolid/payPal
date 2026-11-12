# Floodgate

**Disaster relief that moves before the flood arrives.**

Floodgate is a forecast-triggered relief funding platform for flood-prone districts in South Asia. Donors pledge to a district with a PayPal **authorization** (a hold, not a charge). Floodgate watches the GloFAS river-discharge forecast. If a deterministic engine sees the forecast cross the district's danger threshold, the held pledges are **captured** and a **PayPal Payout** goes to the district's relief partner. Claude then explains the risk in plain language and in the local script. If the watch window closes without a trigger, the holds are **voided** and nobody is charged.

> **Sandbox demonstration.** Every financial transaction runs in the PayPal Sandbox and no real money moves. Relief partners, payout emails and households are fictional **SAMPLE DATA**. Replay scenarios are synthetic and are never real forecasts. See [Limitations and disclaimers](#16-limitations-and-regulatory-disclaimers).

---

## 1. Product overview

| Stage | What happens | PayPal object |
|---|---|---|
| **PLEDGE** | A donor picks a district and amount, then approves in PayPal. | Order (`intent: AUTHORIZE`) → Authorization |
| **WATCH** | Floodgate pulls 30 days of observed and 7 days of forecast river discharge from Open-Meteo (GloFAS). | — |
| **TRIGGER** | Code computes `peak / median`. If it is at or above the threshold: capture every held authorization, initiate a Payout to the relief partner, write the household allocation ledger and ask Claude for an assessment. | Capture, Payout batch, Payout item |
| **RELEASE** | Watch window ends with no trigger: void every held authorization for that district only. | Void |

The UI keeps five states apart: **authorization** (held, not charged), **capture** (charged), **payout initiated** (PayPal accepted the batch), **payout completed** (PayPal reports the item as `SUCCESS`) and **household allocation** (a ledger entry for the relief partner, not a PayPal transfer).

## 2. Problem and target users

Flood forecasts for the Brahmaputra, Surma and Koshi basins often arrive days before the water does, but relief money usually arrives after the damage. Diaspora donors want to help their home districts but do not know when to give and cannot see where their money goes.

- **Donors**, especially diaspora communities from Assam, Bihar, Nepal and Bangladesh, who want to commit funds in advance and pay only if the risk materialises.
- **Relief partners**, who need money to arrive *before* the flood peak, plus a clear allocation plan.
- **Judges and auditors**, who need to see every cent: held, captured, paid out and allocated.

## 3. Four-stage workflow

```
 PLEDGE ──────────► WATCH ──────────► TRIGGER ─────────► capture ─► payout ─► allocation ledger
 (authorize)        (Open-Meteo)       ratio >= threshold
                        │
                        └── window closes, no trigger ──► RELEASE ─► void (donor not charged)
```

## 4. Architecture

```
┌──────────────────────── Browser (React + Vite) ─────────────────────────┐
│ District board · SVG discharge chart · PayPal JS SDK buttons            │
│ (intent=authorize) · AI assessment · Settlement · AG Grid ledger        │
└───────────────┬─────────────────────────────────────────────────────────┘
                │ /api (JSON). No secrets in the browser; only the public PayPal client ID.
┌───────────────▼───────────── Express (Node 20+, ES modules) ────────────┐
│ server/index.js     routes, validation, error handling, static frontend │
│ server/engine.js    state machine, per-district locks, invariants       │
│ server/forecast.js  Open-Meteo client, cell probing, 30-min cache,      │
│                     deterministic trigger, replay surge                 │
│ server/ai.js        Claude assessment + Ask the Ledger (Zod-validated)  │
│ server/allocation.js integer-cent household allocation                  │
│ server/payments/paypal.js  @paypal/paypal-server-sdk + Payouts REST     │
│ server/payments/mock.js    in-memory MOCK provider (no PayPal calls)    │
└──────┬──────────────────────┬──────────────────────────┬────────────────┘
       │                      │                          │
 Open-Meteo Flood API   PayPal Sandbox               Anthropic API
 (GloFAS discharge)     Orders v2, Payments v2,      claude-opus-5-5
                        Payouts v1
```

One deployable service: in production Express serves the built React app from `dist/`. In development Vite proxies `/api` to Express.

## 5. Tech stack

- **Backend:** Node.js 20+, Express 5, ES modules, Zod
- **Frontend:** React 19, Vite, AG Grid Community 36, hand-built SVG chart (no chart dependency)
- **Payments:** `@paypal/paypal-server-sdk` (APIMatic-generated) plus the PayPal Payouts REST API
- **AI:** `@anthropic-ai/sdk`, model `claude-opus-5-5`, structured outputs
- **Data:** Open-Meteo Flood API (GloFAS v4 river discharge)
- **Tests:** Vitest (financial invariants, trigger maths, AI output guards)
- **Hosting:** Render (`render.yaml`)

## 6. PayPal integration

| Operation | API | Source |
|---|---|---|
| Create pledge order, `intent: AUTHORIZE`, one purchase unit, `custom_id` = district ID | `OrdersController.createOrder` | `server/payments/paypal.js` |
| Buyer approval | PayPal JS SDK Buttons with `intent=authorize` | `client/src/components/PayPalButtons.jsx` |
| Authorize the approved order | `OrdersController.authorizeOrder` | `server/payments/paypal.js` |
| Capture on trigger (`final_capture: true`) | `PaymentsController.captureAuthorizedPayment` | `server/payments/paypal.js` |
| Void on release | `PaymentsController.voidPayment` | `server/payments/paypal.js` |
| Payout to relief partner | `POST /v1/payments/payouts` (REST, OAuth client credentials) | `server/payments/paypal.js` |
| Payout status polling | `GET /v1/payments/payouts/{batch_id}` every 10 s | `server/engine.js` → `refreshPayouts` |

**Server-side checks.** The browser sends only a district ID, an amount string and an optional display name. The server validates the district, enforces USD 1.00 to 1,000.00, stores the pledge, and later checks that PayPal's authorization amount, currency and `custom_id` match what it stored. A mismatched authorization is voided and rejected.

**Financial safety invariants** (`server/engine.js`, tested in `tests/engine.test.js`):

1. A pledge can be authorized only once; repeat calls return the stored result.
2. An authorization can be captured only once (explicit state machine plus `PayPal-Request-Id` keyed on the authorization ID).
3. An authorization can be voided only once.
4. A triggered district cannot trigger again: the status changes under a per-district lock *before* any money moves. Re-evaluating only retries incomplete settlement steps.
5. Payout totals can never exceed captured funds. This is checked before every batch is created.
6. Household allocations reconcile exactly to captured cents (largest-remainder apportionment with BigInt arithmetic).
7. Release only touches the selected district's authorizations.
8. A failed payout request is recorded as `REQUEST_FAILED`, never as initiated or completed. "Completed" requires a PayPal item status of `SUCCESS`.
9. Retries are idempotent: deterministic `PayPal-Request-Id` values and a stable `sender_batch_id` per batch.
10. All money is integer cents. Floating-point is used only for display.

**Mock mode.** If `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` are missing, an in-memory provider applies the same state transitions. A banner reads **MOCK MODE — NO PAYPAL CALLS**, the PayPal button is replaced by **Simulate approval**, and every reference starts with `MOCK-`.

## 7. Claude integration and its safety boundaries

**Claude does:**

- explain the flood risk to donors in 2 to 4 sentences, citing the real numbers
- write a household alert in English (under 40 words) and in the local language and native script (Assamese, Bengali, Nepali, Maithili)
- suggest relative allocation weights for risk zones A, B and C
- draft a 4 to 6 step response timeline for the relief partner
- turn plain-English ledger questions into grid filters (**Ask the Ledger**)

**Claude never:** decides the trigger, authorizes, captures, voids, pays out, sets an amount or overrides a check.

How the boundary is enforced (`server/ai.js`):

- One call per valid evaluation through `client.beta.messages.parse` with a Zod output schema (`betaZodOutputFormat`). Effort is set to `low` for latency. No temperature, top_p or thinking budget is sent.
- `stop_reason` must be `end_turn` before the output is used. The parsed output is checked again against a stricter Zod schema (ranges, word count, 4 to 6 steps), and a regex confirms the local alert is in the expected Unicode script.
- If Claude's severity disagrees with the deterministic verdict, the verdict wins.
- Code computes the money: `share = zoneWeight × members`, apportioned in integer cents.
- Ask the Ledger: every column and operator is checked against an explicit allowlist (`Object.hasOwn`, so prototype keys are rejected). The client only applies a validated AG Grid filter model. No model-generated code or expressions are run.
- Server-side refusal fallback is enabled (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). The label shows which model served the response.
- **Fallback:** without `ANTHROPIC_API_KEY`, or on any API, validation or refusal failure, Floodgate uses a fixed deterministic template with equal zone weights, labelled **AI OFFLINE — TEMPLATE RESPONSE** along with the reason. Ask the Ledger falls back to a keyword parser labelled **AI OFFLINE — KEYWORD MATCH**. Template output is never presented as Claude's.

## 8. AG Grid usage

`client/src/components/Ledger.jsx` uses AG Grid Community for a single unified ledger. Row types are Pledge, Authorization, Capture, Void, Payout batch, Payout item, Household allocation, Trigger and Release. Features:

- sorting and per-column text and number filters
- header column groups (Transaction / Money / Provenance)
- custom status cell renderers and SIMULATED/LIVE badges
- CSV export
- **Group by district**: sorts by district and uses AG Grid Community row spanning (`enableCellSpan` + `spanRows`). Full row grouping is an AG Grid Enterprise feature, so it is not used.
- **Ask the Ledger**: Claude returns `{column, operator, value}` triples, the server converts them to an AG Grid filter model, and the client applies it with `api.setFilterModel`.

## 9. APIMatic-generated SDK

`@paypal/paypal-server-sdk` is PayPal's official server SDK, generated with APIMatic. Floodgate uses its `Client`, `OrdersController` (`createOrder`, `authorizeOrder`) and `PaymentsController` (`captureAuthorizedPayment`, `voidPayment`), its typed models (`CheckoutPaymentIntent.Authorize`, camelCase request bodies) and its `ApiError` handling. Version 2.5.0 of the SDK does not include Payouts, so Payouts uses the REST API directly with an OAuth client-credentials token.

## 10. Render deployment

`render.yaml` defines one Node web service:

1. Push this repository to GitHub.
2. In Render, choose **New → Blueprint** and select the repository.
3. Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `ANTHROPIC_API_KEY` and, optionally, `PAYPAL_PAYOUT_RECIPIENT_EMAIL`.
4. Render runs `npm ci --include=dev && npm run build`, then `npm start`. The health check is `/api/health`.

State is held in memory, so a restart or a free-tier spin-down clears the demo state. This is equivalent to `POST /api/reset`.

## 11. Installation and configuration

```bash
git clone https://github.com/perrysolid/payPal.git floodgate && cd floodgate
npm install
cp .env.example .env      # fill in keys, or leave empty for mock/offline mode
npm run dev               # API on :8787, web on http://localhost:5173
npm test                  # invariant tests
npm run build && npm start  # production build served on :8787
```

| Variable | Required | Purpose |
|---|---|---|
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | For Sandbox mode | PayPal Sandbox REST app. If missing, MOCK MODE is used. |
| `PAYPAL_PAYOUT_RECIPIENT_EMAIL` | Optional | Sends all relief-partner payouts to one Sandbox personal account so items can reach `SUCCESS`. Without it, payouts go to fictional `.example` addresses and PayPal reports them as `UNCLAIMED`. |
| `ANTHROPIC_API_KEY` | For AI | Claude assessment and Ask the Ledger. If missing, template responses are used. |
| `PORT` | Optional | Defaults to 8787. |

## 12. PayPal Sandbox test accounts

1. Go to [developer.paypal.com](https://developer.paypal.com) → **Apps & Credentials** → **Sandbox** → create an app. Copy its Client ID and Secret.
2. Under the app's features, make sure **Payouts** is enabled.
3. Under **Testing Tools → Sandbox Accounts** you will find a default **Business** account (the merchant that receives captures and funds payouts) and a **Personal** account (the donor). Use the Personal account's email and password to approve pledges in the PayPal popup.
4. Optionally create a second Personal account to act as the relief partner and put its email in `PAYPAL_PAYOUT_RECIPIENT_EMAIL`.

## 13. Demo instructions (about 2 minutes)

1. Open Floodgate. Six district cards show live peak-to-median ratios. In November all six are well below 1.8×, because it is after the monsoon.
2. Select **Sylhet**. The chart shows 30 days of observed discharge, the live 7-day forecast, the median baseline and the danger line.
3. Choose **$25** and approve with the PayPal Sandbox personal account. The pledge becomes an **authorization**: held, not charged.
4. Click **Replay flood scenario**. A purple, hatched **SIMULATED FORECAST** surge appears. The live line stays as it is.
5. Click **Evaluate now**. The engine computes 2.35× ≥ 1.80×, captures the authorization, initiates a payout to the relief partner and asks Claude for an assessment.
6. Read the assessment: severity, a rationale with numbers, the English alert and the **Bengali** alert, zone weights and the response timeline.
7. Look at **Settlement**: held → captured → payout initiated (**PENDING**) → completed only once PayPal reports `SUCCESS`.
8. Check the household allocation table. The total reconciles exactly to the captured amount.
9. Scroll to the **Financial ledger**. Ask "Show unpaid pledges in zone B in Sylhet", toggle **Group by district** and export CSV.
10. Optionally pledge to Kurigram and click **Release** to see a void. Sylhet is unaffected.
11. Click **Reset demo** to start again. This clears application records only; it does not reverse Sandbox transactions.

## 14. Sample data

`server/data/districts.js` seeds six districts: Guwahati (Kamrup Metro) and Majuli (Assam, Brahmaputra), Sylhet (Bangladesh, Surma), Kurigram (Bangladesh, Brahmaputra-Jamuna), Saptari (Nepal, Koshi) and Darbhanga (Bihar, Kosi). Each has coordinates, a local language, a reference discharge, a 1.8× threshold, a relief partner, a payout email and 12 households across risk zones A, B and C with member counts. **Every partner, email and household is fictional**. There is no NGO partnership, government affiliation or verified beneficiary behind any of them.

Open-Meteo snaps coordinates to the nearest river grid cell, so each district has several candidate coordinates along the main channel. On first load Floodgate probes them all and keeps the cell with the largest valid 30-day median discharge. The chosen grid cell is shown under the chart.

## 15. Replay scenarios

Because forecasts after the monsoon do not cross thresholds, **Replay flood scenario** applies a synthetic surge that peaks at 2.35× the live 30-day median on forecast day 4. It is applied on top of a copy of the live forecast. The live data is never modified and stays available in the **Live forecast** tab. Anything derived from a replay is labelled **SIMULATED**: the chart, trigger assessment, Claude prompt and rationale, settlement panel, ledger rows, payout email subject and note, and notifications.

## 16. Limitations and regulatory disclaimers

- **Sandbox only.** No real money moves. All PayPal objects are Sandbox objects.
- **PayPal availability is limited in parts of the target region.** For example, PayPal cannot receive domestic payments in Bangladesh, and India and Nepal have restrictions. For that reason payouts go to **registered relief partners**, never to households.
- **Household amounts are allocation-ledger entries**, not PayPal transfers. They are instructions to the relief partner.
- **A PayPal authorization is not escrow.** It is a temporary hold on the donor's funding source (generally honoured for 3 days and valid for up to 29 days). Floodgate does not claim regulated escrow. A real deployment would need reauthorization or a different instrument for watch windows longer than the honour period.
- **Payouts** require a Payouts-enabled business account. Items sent to non-PayPal emails become `UNCLAIMED`, and Floodgate shows that status as reported.
- **In-memory state.** A restart clears records. There is no database or authentication; this is a hackathon prototype.
- **Forecasts** come from GloFAS via Open-Meteo. They are modelled discharge, not official warnings. Floodgate is not a warning service and does not replace guidance from national hydrological agencies.
- Webhook signature verification is **not implemented**. Payout status comes from polling.

## 17. License

[MIT](LICENSE) © 2026 Parth Mishra
