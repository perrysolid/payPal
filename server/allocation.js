import { apportion, sumCents } from './money.js';

/**
 * Household allocation ledger. Code (not the model) computes amounts:
 * share_i = zoneWeight[zone_i] x members_i, apportioned over capturedCents in integer cents.
 */
export function computeAllocations(households, zoneWeights, capturedCents) {
  const weights = households.map((h) => (zoneWeights[h.zone] ?? 0) * h.members);
  const amounts = apportion(capturedCents, weights);
  const rows = households.map((h, i) => ({
    householdId: h.id,
    label: h.label,
    zone: h.zone,
    members: h.members,
    weight: weights[i],
    amountCents: amounts[i],
  }));
  const total = sumCents(amounts);
  if (total !== capturedCents) throw new Error(`Allocation reconciliation failed: ${total} != ${capturedCents}`);
  return rows;
}
