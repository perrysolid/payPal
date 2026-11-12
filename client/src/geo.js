const R = 6371;
const rad = (x) => (x * Math.PI) / 180;

export function km(aLat, aLng, bLat, bLng) {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Nearest Floodgate river district to a GDACS flood event. */
export function nearestDistrict(districts, ev) {
  let best = null;
  for (const d of districts) {
    if (d.kind === 'live' || !Number.isFinite(d.lat) || !Number.isFinite(d.lon)) continue;
    const dist = km(ev.lat, ev.lng, d.lat, d.lon);
    if (!best || dist < best.km) best = { district: d, km: dist };
  }
  return best;
}

export const RANK = { Red: 0, Orange: 1, Green: 2 };
export const topAlerts = (events, n) => [...(events ?? [])]
  .sort((a, b) => (RANK[a.alert] ?? 3) - (RANK[b.alert] ?? 3) || (b.score ?? 0) - (a.score ?? 0))
  .slice(0, n ?? events?.length ?? 0);
export const day = (s) => (s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
export const daysBetween = (a, b) => (a && b ? Math.max(1, Math.round((new Date(b) - new Date(a)) / 86400000)) : null);
