// Open-Meteo flood forecast retrieval and the deterministic trigger engine.
// Money movement depends only on `computeTrigger`, never on model output.

const FLOOD_API = 'https://flood-api.open-meteo.com/v1/flood';
const CACHE_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 12_000;

export const PAST_DAYS = 30;
export const FORECAST_DAYS = 7;

async function fetchJson(url, fetchImpl) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`Open-Meteo responded ${res.status}`);
    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Open-Meteo request timed out');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Split an Open-Meteo daily series into past observations and forecast days relative to `today` (YYYY-MM-DD). */
export function splitSeries(time, discharge, today) {
  const points = time.map((t, i) => {
    const v = discharge[i];
    return { date: t, value: Number.isFinite(v) && v >= 0 ? v : null };
  });
  const past = points.filter((p) => p.date < today);
  const forecast = points.filter((p) => p.date >= today);
  return { past, forecast };
}

/** Deterministic trigger. Pure function of the series and threshold. */
export function computeTrigger({ past, forecast }, threshold) {
  const pastVals = past.map((p) => p.value).filter((v) => v != null);
  const fcVals = forecast.map((p) => p.value).filter((v) => v != null);
  const issues = [];
  if (pastVals.length < 20) issues.push(`only ${pastVals.length} of ${PAST_DAYS} past observations available`);
  if (fcVals.length < 5) issues.push(`only ${fcVals.length} of ${FORECAST_DAYS} forecast days available`);
  const baseline = median(pastVals);
  if (baseline == null || baseline <= 0) issues.push('baseline is zero or invalid');
  const peak = fcVals.length ? Math.max(...fcVals) : null;
  const valid = issues.length === 0;
  const ratio = valid ? peak / baseline : null;
  const peakDate = valid ? forecast.find((p) => p.value === peak)?.date ?? null : null;
  return {
    valid,
    issues,
    baseline,
    peak,
    peakDate,
    ratio,
    threshold,
    dangerLevel: baseline != null && baseline > 0 ? baseline * threshold : null,
    trigger: valid && ratio >= threshold,
  };
}

/**
 * Synthetic replay surge. Returns a NEW forecast array; never mutates live data.
 * Ramps forecast days toward `targetRatio` x baseline, peaking on day 4.
 */
export function applyReplaySurge(forecast, baseline, targetRatio = 2.35) {
  const shape = [0.52, 0.7, 0.88, 1.0, 0.91, 0.78, 0.64]; // fraction of the synthetic peak per forecast day
  return forecast.map((p, i) => {
    const surge = baseline * targetRatio * (shape[i] ?? 0.6);
    return { date: p.date, value: Math.round(Math.max(p.value ?? 0, surge) * 100) / 100 };
  });
}

export function createForecastService({ fetchImpl = fetch, now = () => new Date() } = {}) {
  const cache = new Map(); // districtId -> { fetchedAt, data }
  const cellChoice = new Map(); // districtId -> chosen [lat, lon]

  async function fetchCell(lat, lon) {
    const url = `${FLOOD_API}?latitude=${lat}&longitude=${lon}&daily=river_discharge&past_days=${PAST_DAYS}&forecast_days=${FORECAST_DAYS}`;
    const j = await fetchJson(url, fetchImpl);
    const time = j?.daily?.time;
    const q = j?.daily?.river_discharge;
    if (!Array.isArray(time) || !Array.isArray(q) || time.length !== q.length) {
      throw new Error('Open-Meteo returned an unexpected payload');
    }
    return { time, discharge: q, gridLat: j.latitude, gridLon: j.longitude, requested: [lat, lon] };
  }

  /** Probe candidate coordinates; choose the cell with the largest valid median discharge. */
  async function probe(district) {
    const results = await Promise.allSettled(district.candidates.map(([la, lo]) => fetchCell(la, lo)));
    let best = null;
    const probes = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') { probes.push({ error: r.reason?.message }); continue; }
      const vals = r.value.discharge.filter((v) => Number.isFinite(v));
      const med = median(vals.slice(0, PAST_DAYS));
      probes.push({ requested: r.value.requested, grid: [r.value.gridLat, r.value.gridLon], median: med, points: vals.length });
      if (med != null && med > 0 && vals.length >= PAST_DAYS && (!best || med > best.med)) best = { med, cell: r.value };
    }
    if (!best) {
      const err = new Error('No candidate river cell returned usable discharge data');
      err.probes = probes;
      throw err;
    }
    cellChoice.set(district.id, best.cell.requested);
    return { cell: best.cell, probes };
  }

  async function getForecast(district, { force = false } = {}) {
    const hit = cache.get(district.id);
    const nowMs = now().getTime();
    if (!force && hit && hit.ok && nowMs - hit.fetchedAt < CACHE_MS) return { ...hit.data, cache: 'hit' };
    try {
      let cell, probes;
      const chosen = cellChoice.get(district.id);
      if (chosen) {
        cell = await fetchCell(chosen[0], chosen[1]);
        probes = hit?.data?.probes ?? [];
      } else {
        ({ cell, probes } = await probe(district));
      }
      const today = now().toISOString().slice(0, 10);
      const series = splitSeries(cell.time, cell.discharge, today);
      const data = {
        districtId: district.id,
        source: 'open-meteo-glofas',
        live: true,
        fetchedAt: new Date(nowMs).toISOString(),
        grid: { lat: cell.gridLat, lon: cell.gridLon, requested: cell.requested },
        probes,
        series,
        evaluation: computeTrigger(series, district.threshold),
        error: null,
        stale: false,
      };
      cache.set(district.id, { ok: true, fetchedAt: nowMs, data });
      return { ...data, cache: 'miss' };
    } catch (e) {
      // Never manufacture values. Serve the last good response, clearly marked stale.
      if (hit?.ok) {
        return { ...hit.data, stale: true, error: `Refresh failed: ${e.message}. Showing data from ${hit.data.fetchedAt}.`, cache: 'stale' };
      }
      return {
        districtId: district.id,
        source: 'open-meteo-glofas',
        live: false,
        fetchedAt: null,
        series: null,
        evaluation: null,
        probes: e.probes ?? [],
        error: e.message,
        stale: false,
        cache: 'error',
      };
    }
  }

  function clear() { cache.clear(); }

  return { getForecast, clear };
}
