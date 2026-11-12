// Live global flood events from GDACS (UN OCHA / EU JRC). No API key required.
// Only events GDACS itself marks as current (iscurrent=true) are returned. On failure we serve the last
// good response (flagged stale) or an error. Nothing is ever invented.

const GDACS = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';
const CACHE_MS = 30 * 60 * 1000;
const LOOKBACK_DAYS = 45;

const ymd = (d) => d.toISOString().slice(0, 10);

export function normalize(geojson) {
  const seen = new Map();
  for (const f of geojson?.features ?? []) {
    const p = f.properties ?? {};
    const [lng, lat] = f.geometry?.coordinates ?? [];
    if (p.eventtype !== 'FL' || String(p.iscurrent) !== 'true') continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const ev = {
      id: p.eventid,
      name: p.name || `Flood in ${p.country}`,
      country: p.country || 'Unknown',
      lat,
      lng,
      alert: p.alertlevel || 'Green',
      score: Number.isFinite(p.alertscore) ? p.alertscore : null,
      severity: Number.isFinite(p.severitydata?.severity) ? p.severitydata.severity : null,
      severityText: p.severitydata?.severitytext?.trim() || null,
      from: p.fromdate ?? null,
      to: p.todate ?? null,
      modified: p.datemodified ?? null,
      report: p.url?.report ?? null,
    };
    const prev = seen.get(ev.id);
    if (!prev || (ev.modified ?? '') > (prev.modified ?? '')) seen.set(ev.id, ev);
  }
  const rank = { Red: 0, Orange: 1, Green: 2 };
  return [...seen.values()].sort((a, b) => (rank[a.alert] ?? 3) - (rank[b.alert] ?? 3) || a.country.localeCompare(b.country));
}

export function createFloodService({ fetchImpl = fetch } = {}) {
  let cache = null;
  async function get() {
    if (cache && Date.now() - cache.at < CACHE_MS) return { ...cache.data, stale: false };
    const to = new Date();
    const from = new Date(to.getTime() - LOOKBACK_DAYS * 86400_000);
    const url = `${GDACS}?eventlist=FL&fromdate=${ymd(from)}&todate=${ymd(to)}&alertlevel=Green;Orange;Red`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15_000);
      const res = await fetchImpl(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
      if (!res.ok) throw new Error(`GDACS responded ${res.status}`);
      const events = normalize(await res.json());
      const data = { source: 'GDACS', sourceUrl: 'https://www.gdacs.org', fetchedAt: new Date().toISOString(), events };
      cache = { at: Date.now(), data };
      return { ...data, stale: false };
    } catch (e) {
      if (cache) return { ...cache.data, stale: true };
      throw new Error(`Flood feed unavailable: ${e.message}`);
    }
  }
  return { get };
}
