// Exact money handling. All internal amounts are integer US cents.

export function parseAmountToCents(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error('Amount must be finite');
    input = input.toFixed(2);
  }
  if (typeof input !== 'string') throw new Error('Amount must be a string or number');
  const s = input.trim();
  const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error('Amount must be a positive decimal with at most two fractional digits');
  const whole = Number(m[1]);
  const frac = Number((m[2] || '').padEnd(2, '0'));
  return whole * 100 + frac;
}

export function centsToString(cents) {
  assertCents(cents);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export function assertCents(cents) {
  if (!Number.isSafeInteger(cents)) throw new Error(`Invalid cents value: ${cents}`);
  return cents;
}

export function sumCents(list) {
  return list.reduce((acc, c) => acc + assertCents(c), 0);
}

/**
 * Split `totalCents` across `weights` using the largest-remainder method.
 * Integer arithmetic only (BigInt), so the result always sums to totalCents exactly.
 */
export function apportion(totalCents, weights) {
  assertCents(totalCents);
  if (totalCents < 0) throw new Error('Cannot apportion a negative total');
  if (!weights.length) return [];
  // Scale weights to integers (weights may be fractional, e.g. 1.5 x 4 members).
  const scaled = weights.map((w) => {
    if (!Number.isFinite(w) || w < 0) throw new Error('Weights must be non-negative finite numbers');
    return BigInt(Math.round(w * 1_000_000));
  });
  let W = scaled.reduce((a, b) => a + b, 0n);
  const effective = W === 0n ? scaled.map(() => 1n) : scaled;
  if (W === 0n) W = BigInt(scaled.length);
  const T = BigInt(totalCents);
  const base = effective.map((w) => (T * w) / W);
  const rema = effective.map((w, i) => ({ i, r: (T * w) % W }));
  let leftover = Number(T - base.reduce((a, b) => a + b, 0n));
  rema.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  const out = base.map(Number);
  for (let k = 0; k < leftover; k++) out[rema[k % rema.length].i] += 1;
  return out;
}
