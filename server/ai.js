// Claude integration. Claude explains risk, translates alerts, suggests zone weights and
// drafts response timelines. It never decides the trigger, never sets an amount, and
// never moves money. Every output is validated with Zod before use.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { ZONE_DESCRIPTIONS } from './data/districts.js';

const AI_TIMEOUT_MS = 60_000;

// ---------- Trigger assessment ----------

const AssessmentWire = z.object({
  severity: z.enum(['watch', 'warning', 'severe']),
  rationale: z.string(),
  zoneWeights: z.object({ A: z.number(), B: z.number(), C: z.number() }),
  alertEnglish: z.string(),
  alertLocal: z.string(),
  responseSteps: z.array(z.object({
    title: z.string(),
    startHourOffset: z.number(),
    durationHours: z.number(),
    owner: z.string(),
  })),
});

// Stricter checks applied after parsing (structured outputs do not enforce numeric ranges).
export const AssessmentStrict = AssessmentWire.extend({
  rationale: z.string().min(40).max(900),
  zoneWeights: z.object({
    A: z.number().min(0).max(10),
    B: z.number().min(0).max(10),
    C: z.number().min(0).max(10),
  }).refine((w) => w.A + w.B + w.C > 0, 'zone weights must not all be zero'),
  alertEnglish: z.string().min(10).refine((s) => s.trim().split(/\s+/).length < 40, 'alertEnglish must be under 40 words'),
  alertLocal: z.string().min(5),
  responseSteps: z.array(z.object({
    title: z.string().min(3).max(120),
    startHourOffset: z.number().min(-72).max(336),
    durationHours: z.number().min(0.5).max(336),
    owner: z.string().min(2).max(80),
  })).min(4).max(6),
});

const SCRIPT_RANGES = {
  'Bengali-Assamese': /[ঀ-৿]/,
  Bengali: /[ঀ-৿]/,
  Devanagari: /[ऀ-ॿ]/,
};

const ASSESSMENT_SYSTEM = `You are the risk communication analyst for Floodgate, a forecast-triggered relief funding platform running as a PayPal Sandbox demonstration.

A deterministic engine has already decided whether the district crossed its danger threshold. You do not decide that, you do not set any money amounts and you do not authorize, capture or pay out funds. Your job is to explain the situation to ordinary donors and to draft guidance for a relief partner.

Write:
- severity: "watch" if the deterministic verdict is no trigger; "warning" or "severe" if triggered (severe when the ratio is well above threshold or the peak is imminent).
- rationale: 2 to 4 plain sentences for donors, citing the actual numbers given (baseline, peak, ratio, threshold, peak date). No jargon, no exaggeration, no claims about real casualties.
- zoneWeights: relative allocation weights for risk zones A, B and C (numbers between 0 and 10). These scale per-member household shares; the platform's code computes the actual amounts.
- alertEnglish: a practical household alert of 30 words or fewer (hard limit: under 40 words).
- alertLocal: the same alert in the district's local language, written in its native script. If the language is Maithili, write genuine Maithili (e.g. "मे", "क", "अछि"), not Hindi.
- responseSteps: 4 to 6 practical steps for the relief partner, each with title, startHourOffset (hours from now, may be negative only if already under way), durationHours and owner (a role such as "Relief partner field team", not a real organisation).

If the data is marked SIMULATED, treat it as a drill: say so plainly in the rationale ("In this simulated scenario..."). Never present simulated data as a real flood.`;

// ---------- Ask the Ledger ----------

export const LEDGER_COLUMNS = {
  type: { kind: 'text', values: ['Pledge', 'Authorization', 'Capture', 'Void', 'Payout batch', 'Payout item', 'Household allocation', 'Trigger', 'Release', 'Evaluation'] },
  district: { kind: 'text', values: ['Guwahati', 'Majuli', 'Sylhet', 'Kurigram', 'Saptari', 'Darbhanga'] },
  party: { kind: 'text' },
  status: { kind: 'text' },
  zone: { kind: 'text', values: ['A', 'B', 'C'] },
  amount: { kind: 'number' },
  scenario: { kind: 'text', values: ['LIVE', 'SIMULATED'] },
  provider: { kind: 'text', values: ['PAYPAL SANDBOX', 'MOCK'] },
  reference: { kind: 'text' },
};
const TEXT_OPS = ['equals', 'notEqual', 'contains', 'notContains', 'startsWith'];
const NUM_OPS = ['equals', 'notEqual', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual'];

const AskWire = z.object({
  filters: z.array(z.object({
    column: z.string(),
    operator: z.string(),
    value: z.string(),
  })),
  sort: z.object({ column: z.string(), direction: z.enum(['asc', 'desc']) }).nullable(),
  explanation: z.string(),
});

/** Convert model output to an AG Grid filter model, rejecting anything outside the allowlist. */
export function validateLedgerQuery(raw) {
  const parsed = AskWire.parse(raw);
  const rejected = [];
  const byColumn = {};
  for (const f of parsed.filters.slice(0, 8)) {
    const col = Object.hasOwn(LEDGER_COLUMNS, f.column) ? LEDGER_COLUMNS[f.column] : null;
    if (!col) { rejected.push(`unknown column "${f.column}"`); continue; }
    if (col.kind === 'number') {
      const n = Number(f.value);
      if (!NUM_OPS.includes(f.operator) || !Number.isFinite(n)) { rejected.push(`invalid number filter on ${f.column}`); continue; }
      (byColumn[f.column] ||= []).push({ filterType: 'number', type: f.operator, filter: n });
    } else {
      if (!TEXT_OPS.includes(f.operator) || typeof f.value !== 'string' || f.value.length > 60) { rejected.push(`invalid text filter on ${f.column}`); continue; }
      let value = f.value;
      if (col.values) {
        const match = col.values.find((v) => v.toLowerCase() === value.toLowerCase());
        if (f.operator === 'equals' && !match) { rejected.push(`"${value}" is not a known ${f.column}`); continue; }
        if (match) value = match;
      }
      (byColumn[f.column] ||= []).push({ filterType: 'text', type: f.operator, filter: value });
    }
  }
  const filterModel = {};
  for (const [colId, conds] of Object.entries(byColumn)) {
    filterModel[colId] = conds.length === 1
      ? conds[0]
      : { filterType: conds[0].filterType, operator: 'OR', conditions: conds.slice(0, 2) };
  }
  let sort = null;
  if (parsed.sort && Object.hasOwn(LEDGER_COLUMNS, parsed.sort.column)) sort = parsed.sort;
  else if (parsed.sort && parsed.sort.column !== 'time') rejected.push(`cannot sort by "${parsed.sort.column}"`);
  else if (parsed.sort) sort = parsed.sort;
  return { filterModel, sort, explanation: parsed.explanation.slice(0, 300), rejected };
}

/** Deterministic keyword parser used when Claude is unavailable. */
export function keywordLedgerQuery(question) {
  const q = question.toLowerCase();
  const filters = [];
  for (const d of LEDGER_COLUMNS.district.values) if (q.includes(d.toLowerCase())) filters.push({ column: 'district', operator: 'equals', value: d });
  const typeMap = [
    ['household', 'Household allocation'], ['allocation', 'Household allocation'], ['payout item', 'Payout item'],
    ['payout', 'Payout batch'], ['pledge', 'Pledge'], ['authori', 'Authorization'], ['capture', 'Capture'], ['void', 'Void'],
  ];
  for (const [k, v] of typeMap) if (q.includes(k)) { filters.push({ column: 'type', operator: 'equals', value: v }); break; }
  const zone = /zone\s*([abc])\b/.exec(q);
  if (zone) filters.push({ column: 'zone', operator: 'equals', value: zone[1].toUpperCase() });
  if (q.includes('simulated')) filters.push({ column: 'scenario', operator: 'equals', value: 'SIMULATED' });
  if (/\bunpaid|held|pending|uncaptured\b/.test(q)) filters.push({ column: 'status', operator: 'notContains', value: 'CAPTURED' });
  if (q.includes('failed')) filters.push({ column: 'status', operator: 'contains', value: 'FAIL' });
  const over = /(over|above|more than|greater than)\s*\$?(\d+(?:\.\d+)?)/.exec(q);
  if (over) filters.push({ column: 'amount', operator: 'greaterThan', value: over[2] });
  const under = /(under|below|less than)\s*\$?(\d+(?:\.\d+)?)/.exec(q);
  if (under) filters.push({ column: 'amount', operator: 'lessThan', value: under[2] });
  return validateLedgerQuery({ filters, sort: null, explanation: filters.length ? 'Matched keywords in your question.' : 'No recognised keywords; showing all rows.' });
}

const ASK_SYSTEM = `You translate natural-language questions about the Floodgate financial ledger into a structured filter for a data grid. Use only these columns:
${Object.entries(LEDGER_COLUMNS).map(([k, v]) => `- ${k} (${v.kind}${v.values ? `; values: ${v.values.join(', ')}` : ''})`).join('\n')}
Text operators: ${TEXT_OPS.join(', ')}. Number operators: ${NUM_OPS.join(', ')}. Amount is in US dollars.
Statuses in use include CREATED, AUTHORIZED, CAPTURED, VOIDED, CAPTURE_FAILED, VOID_FAILED, PENDING, PROCESSING, SUCCESS, UNCLAIMED, FAILED, ALLOCATED, TRIGGERED, RELEASED.
"Unpaid" or "held" pledges are rows of type Pledge whose status is not CAPTURED (use operator notEqual with value CAPTURED). Household allocations carry the zone. Sort column may also be "time".
Return an empty filters array if the question cannot be expressed. explanation: one short sentence describing the filter.`;

// ---------- Template fallbacks ----------

const LOCAL_TEMPLATES = {
  as: (d) => `${d}ৰ বাবে বানপানীৰ সতৰ্কবাণী: নদীৰ পানী বাঢ়িব পাৰে। নথি-পত্ৰ, খাদ্য আৰু পশুধন ওখ ঠাইলৈ নিয়ক আৰু স্থানীয় প্ৰশাসনৰ নিৰ্দেশনা মানি চলক।`,
  bn: (d) => `${d}-এর জন্য বন্যা সতর্কতা: নদীর পানি বাড়তে পারে। কাগজপত্র, খাবার ও গবাদিপশু উঁচু জায়গায় সরিয়ে নিন এবং স্থানীয় প্রশাসনের নির্দেশনা মেনে চলুন।`,
  ne: (d) => `${d}का लागि बाढी चेतावनी: नदीको पानी बढ्न सक्छ। कागजात, खाना र पशुधन अग्लो स्थानमा सार्नुहोस् र स्थानीय प्रशासनको निर्देशन पालना गर्नुहोस्।`,
  mai: (d) => `${d} लेल बाढ़िक चेतावनी: नदीक पानि बढ़ि सकैत अछि। कागजात, भोजन आ मवेशी ऊँच स्थान पर लऽ जाउ आ स्थानीय प्रशासनक निर्देशक पालन करू।`,
};

export function templateAssessment({ district, evaluation, simulated }) {
  const r = evaluation.ratio?.toFixed(2);
  const sim = simulated ? 'In this simulated scenario, ' : '';
  const triggered = evaluation.trigger;
  return {
    severity: triggered ? (evaluation.ratio >= district.threshold * 1.25 ? 'severe' : 'warning') : 'watch',
    rationale: `${sim}the ${district.river} is forecast to peak at ${Math.round(evaluation.peak).toLocaleString('en-US')} m³/s against a 30-day median of ${Math.round(evaluation.baseline).toLocaleString('en-US')} m³/s, a ratio of ${r}. The danger threshold for ${district.shortName} is ${district.threshold.toFixed(2)}, so the trigger ${triggered ? 'has been met' : 'has not been met'}. This is a fixed template because the AI service is unavailable.`,
    zoneWeights: { A: 1, B: 1, C: 1 },
    alertEnglish: `Flood warning for ${district.shortName}: river levels may rise. Move documents, food and livestock to higher ground and follow local authority guidance.`,
    alertLocal: LOCAL_TEMPLATES[district.language.code](district.shortName),
    responseSteps: [
      { title: 'Confirm partner readiness and contact lists', startHourOffset: 0, durationHours: 4, owner: 'Relief partner coordinator' },
      { title: 'Issue household alerts in local language', startHourOffset: 2, durationHours: 6, owner: 'Relief partner field team' },
      { title: 'Distribute cash allocations per ledger', startHourOffset: 8, durationHours: 24, owner: 'Relief partner finance lead' },
      { title: 'Verify receipt and report back', startHourOffset: 32, durationHours: 24, owner: 'Relief partner coordinator' },
    ],
  };
}

// ---------- Service ----------

export function createAiService(aiConfig) {
  const client = aiConfig ? new Anthropic({ apiKey: aiConfig.apiKey, timeout: AI_TIMEOUT_MS, maxRetries: 1 }) : null;
  const model = aiConfig?.model ?? 'claude-haiku-5-5';

  async function structuredCall({ system, user, schema, effort, maxTokens }) {
    const response = await client.messages.parse({
      model,
      max_tokens: maxTokens,
      output_config: { effort, format: zodOutputFormat(schema) },
      system,
      messages: [{ role: 'user', content: user }],
    });
    if (response.stop_reason !== 'end_turn') {
      throw new Error(`Claude stopped with stop_reason=${response.stop_reason}`);
    }
    if (!response.parsed_output) throw new Error('Claude returned no parseable structured output');
    return { output: response.parsed_output, model: response.model };
  }

  async function assess({ district, evaluation, series, simulated, heldCents, capturedCents }) {
    const zoneCounts = { A: 0, B: 0, C: 0 };
    const zoneMembers = { A: 0, B: 0, C: 0 };
    for (const h of district.households) { zoneCounts[h.zone] += 1; zoneMembers[h.zone] += h.members; }
    const fallback = (reason) => ({
      ...templateAssessment({ district, evaluation, simulated }),
      source: 'template',
      sourceLabel: 'AI OFFLINE — TEMPLATE RESPONSE',
      fallbackReason: reason,
      model: null,
    });
    if (!client) return fallback('ANTHROPIC_API_KEY is not configured');

    const payload = {
      dataLabel: simulated ? 'SIMULATED FORECAST (synthetic replay scenario, not a real forecast)' : 'LIVE FORECAST (Open-Meteo GloFAS river discharge)',
      district: {
        name: district.name, country: district.country, region: district.region, river: district.river, basin: district.basin,
        localLanguage: `${district.language.name} (${district.language.script} script)`,
      },
      discharge_m3s: {
        past30Days: series.past.map((p) => [p.date, p.value]),
        forecast7Days: series.forecast.map((p) => [p.date, p.value]),
      },
      baselineMedian30d_m3s: round(evaluation.baseline),
      forecastPeak_m3s: round(evaluation.peak),
      forecastPeakDate: evaluation.peakDate,
      ratio: Number(evaluation.ratio.toFixed(3)),
      dangerThresholdRatio: district.threshold,
      deterministicVerdict: evaluation.trigger ? 'TRIGGERED' : 'NOT TRIGGERED',
      fundsUSD: { heldAuthorizations: (heldCents / 100).toFixed(2), captured: (capturedCents / 100).toFixed(2) },
      households: { byZone: zoneCounts, membersByZone: zoneMembers, zoneDescriptions: ZONE_DESCRIPTIONS, note: 'SAMPLE DATA' },
    };
    try {
      const scriptRe = SCRIPT_RANGES[district.language.script];
      const check = (output) => {
        const strict = AssessmentStrict.safeParse(output);
        if (!strict.success) return { problem: strict.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
        if (scriptRe && !scriptRe.test(strict.data.alertLocal)) return { problem: `alertLocal must be written in ${district.language.script} script` };
        return { data: strict.data };
      };
      const userMsg = `Assess this district.\n\n${JSON.stringify(payload)}`;
      let { output, model: servedBy } = await structuredCall({ system: ASSESSMENT_SYSTEM, user: userMsg, schema: AssessmentWire, effort: 'low', maxTokens: 6000 });
      let result = check(output);
      if (!result.data) {
        // One corrective retry; the output is validated again and never trusted blindly.
        ({ output, model: servedBy } = await structuredCall({
          system: ASSESSMENT_SYSTEM,
          user: `${userMsg}\n\nYour previous answer failed validation (${result.problem}). Produce a corrected assessment that satisfies every constraint.`,
          schema: AssessmentWire, effort: 'low', maxTokens: 6000,
        }));
        result = check(output);
      }
      if (!result.data) return fallback(`Claude output failed validation: ${result.problem}`);
      const strict = { data: result.data };
      // The model's severity is advisory; it must agree with the deterministic verdict.
      let severity = strict.data.severity;
      if (!evaluation.trigger) severity = 'watch';
      else if (severity === 'watch') severity = 'warning';
      return { ...strict.data, severity, source: 'claude', sourceLabel: `Generated by Claude (${servedBy})`, model: servedBy, fallbackReason: null };
    } catch (e) {
      return fallback(errorSummary(e));
    }
  }

  async function askLedger(question) {
    if (!client) return { ...keywordLedgerQuery(question), source: 'keyword', sourceLabel: 'AI OFFLINE — KEYWORD MATCH' };
    try {
      const { output, model: servedBy } = await structuredCall({
        system: ASK_SYSTEM,
        user: question,
        schema: AskWire,
        effort: 'low',
        maxTokens: 2000,
      });
      return { ...validateLedgerQuery(output), source: 'claude', sourceLabel: `Filter generated by Claude (${servedBy})` };
    } catch (e) {
      return { ...keywordLedgerQuery(question), source: 'keyword', sourceLabel: 'AI OFFLINE — KEYWORD MATCH', fallbackReason: errorSummary(e) };
    }
  }

  return { enabled: Boolean(client), model, assess, askLedger };
}

function round(n) { return Math.round(n * 10) / 10; }

function errorSummary(e) {
  if (e instanceof Anthropic.APIError) return `Claude API error ${e.status ?? ''} ${e.name}`.trim();
  return e.message?.slice(0, 200) || 'Unknown AI error';
}
