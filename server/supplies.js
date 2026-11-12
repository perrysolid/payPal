// Channel3 product search: prices for household essentials that direct aid can cover.
// Results are reference prices for recipients and donors; Floodgate does not buy anything.
// Channel3 links are referral links: the per-offer commission rate is shown in the UI.
import { Channel3 } from '@channel3/sdk';

const KITS = {
  flood: ['water purification tablets', 'waterproof dry bag', 'oral rehydration salts', 'tarpaulin 10x12'],
  cyclone: ['emergency tarpaulin', 'solar lantern', 'water purification tablets', 'first aid kit'],
  earthquake: ['emergency tent', 'first aid kit', 'solar lantern', 'emergency blanket'],
  wildfire: ['N95 masks', 'eye wash', 'portable air purifier', 'first aid kit'],
};

export function createSupplyService({ apiKey }) {
  const client = apiKey ? new Channel3({ apiKey }) : null;
  const cache = new Map();
  async function essentials(hazard) {
    if (!client) return { enabled: false, items: [] };
    const key = KITS[hazard] ? hazard : 'flood';
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.value;
    const results = await Promise.allSettled(KITS[key].map((q) => client.products.search({ query: q, limit: 3 })));
    const items = [];
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') return;
      const products = r.value?.data ?? r.value?.products ?? [];
      const best = products
        .map((p) => {
          const offer = (p.offers || []).filter((o) => o.availability !== 'OutOfStock' && o.price?.price != null).sort((a, b) => a.price.price - b.price.price)[0];
          return offer ? { p, offer } : null;
        })
        .filter(Boolean)
        .sort((a, b) => a.offer.price.price - b.offer.price.price)[0];
      if (!best) return;
      items.push({
        need: KITS[key][i],
        title: best.p.title,
        brand: best.p.brands?.[0]?.name ?? null,
        image: (best.p.images || []).find((im) => im.is_main_image)?.url ?? best.p.images?.[0]?.url ?? null,
        priceCents: Math.round(best.offer.price.price * 100),
        currency: best.offer.price.currency || 'USD',
        merchant: best.offer.domain,
        url: best.offer.url,
        commissionRate: best.offer.max_commission_rate ?? null,
      });
    });
    const value = { enabled: true, hazard: key, items, fetchedAt: new Date().toISOString() };
    cache.set(key, { at: Date.now(), value });
    return value;
  }
  return { enabled: Boolean(client), essentials };
}
