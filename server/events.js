// Live disaster events from GDACS (Global Disaster Alert and Coordination System, UN/EU).
// No API key. Orange and Red alerts for earthquakes, wildfires and tropical cyclones open a
// direct-aid campaign automatically; nobody picks events by hand.

const GDACS = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH';
const LANG = {
  MEX: { code: 'es', name: 'Spanish' }, PAN: { code: 'es', name: 'Spanish' }, COL: { code: 'es', name: 'Spanish' }, PER: { code: 'es', name: 'Spanish' },
  GTM: { code: 'es', name: 'Spanish' }, HND: { code: 'es', name: 'Spanish' }, CHN: { code: 'zh', name: 'Chinese' }, IND: { code: 'hi', name: 'Hindi' },
  PHL: { code: 'fil', name: 'Filipino' }, JPN: { code: 'ja', name: 'Japanese' }, IDN: { code: 'id', name: 'Indonesian' }, USA: { code: 'en', name: 'English' },
  VUT: { code: 'bi', name: 'Bislama' }, GUM: { code: 'en', name: 'English' }, TUR: { code: 'tr', name: 'Turkish' }, GRC: { code: 'el', name: 'Greek' },
};
const COUNTRY_FIX = { 'México': 'Mexico', 'United States': 'United States' };
const ISO2 = { MEX: 'MX', PAN: 'PA', COL: 'CO', PER: 'PE', GTM: 'GT', HND: 'HN', CHN: 'CN', IND: 'IN', PHL: 'PH', JPN: 'JP', IDN: 'ID', USA: 'US', VUT: 'VU', GUM: 'GU', TUR: 'TR', GRC: 'GR' };
const RADIUS = { EQ: { Orange: 120, Red: 200 }, WF: { Orange: 40, Red: 60 }, TC: { Orange: 150, Red: 250 } };

export function createEventService({ fetchImpl = fetch, lookbackDays = 30 } = {}) {
  let cache = null;
  async function list() {
    if (cache && Date.now() - cache.at < 15 * 60_000) return cache.events;
    const to = new Date();
    const from = new Date(Date.now() - lookbackDays * 86400_000);
    const url = `${GDACS}?eventlist=EQ;WF;TC&alertlevel=Orange;Red&fromDate=${from.toISOString().slice(0, 10)}&toDate=${to.toISOString().slice(0, 10)}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`GDACS HTTP ${res.status}`);
      const j = await res.json();
      const seen = new Set();
      const events = [];
      for (const f of j.features || []) {
        const p = f.properties || {};
        const key = `${p.eventtype}-${p.eventid}`;
        if (seen.has(key) || !['EQ', 'WF', 'TC'].includes(p.eventtype) || !['Orange', 'Red'].includes(p.alertlevel)) continue;
        seen.add(key);
        const iso3 = p.iso3 || '';
        const firstCountry = String(p.country || '').split(',')[0].trim();
        const country = COUNTRY_FIX[firstCountry] || firstCountry || 'Unknown';
        const [lon, lat] = f.geometry?.coordinates || [];
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const kind = { EQ: 'Earthquake', WF: 'Wildfire', TC: 'Cyclone' }[p.eventtype];
        const mag = /Magnitude ([\d.]+)M/.exec(p.severitydata?.severitytext || '')?.[1];
        events.push({
          type: p.eventtype, eventId: p.eventid, alertLevel: p.alertlevel,
          name: p.name || `${kind} in ${country}`,
          shortName: p.eventtype === 'EQ' ? `${country} M${mag ?? '?'}` : p.eventtype === 'TC' ? `${(p.name || '').replace(/^Tropical Cyclone /, '')} (${country})` : `${kind} (${country})`,
          country, iso2: ISO2[iso3] || null, region: p.country || '',
          lat: Number(lat), lon: Number(lon),
          severity: p.severitydata?.severitytext || '',
          fromDate: p.fromdate, url: p.url?.report || `https://www.gdacs.org/report.aspx?eventtype=${p.eventtype}&eventid=${p.eventid}`,
          language: LANG[iso3] || { code: 'en', name: 'English' },
          radiusKm: RADIUS[p.eventtype]?.[p.alertlevel] ?? 100,
        });
      }
      events.sort((a, b) => (a.fromDate < b.fromDate ? 1 : -1));
      cache = { at: Date.now(), events: events.slice(0, 8) };
      return cache.events;
    } finally {
      clearTimeout(timer);
    }
  }
  return { list, clear() { cache = null; } };
}
