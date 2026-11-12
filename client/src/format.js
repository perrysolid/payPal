export const usd = (cents) => {
  if (cents == null || !Number.isFinite(cents)) return 'USD —';
  const neg = cents < 0;
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  return `${neg ? '-' : ''}USD ${whole}.${String(abs % 100).padStart(2, '0')}`;
};
export const usdFromDollars = (d) => usd(Math.round(Number(d) * 100));
export const m3s = (v) => (v == null || !Number.isFinite(v) ? '—' : `${Math.round(v).toLocaleString('en-US')} m³/s`);
export const ratio = (r) => (r == null || !Number.isFinite(r) ? '—' : `${r.toFixed(2)}×`);
export function ago(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}
export const shortDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
export const time = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
