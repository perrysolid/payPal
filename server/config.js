// Environment validation. Secrets never leave the server and are never logged.

function clean(v) {
  const s = (v ?? '').trim();
  return s.length ? s : null;
}

export function loadConfig(env = process.env) {
  const warnings = [];
  const paypalId = clean(env.PAYPAL_CLIENT_ID);
  const paypalSecret = clean(env.PAYPAL_CLIENT_SECRET);
  let paymentMode = 'mock';
  if (paypalId && paypalSecret) paymentMode = 'paypal';
  else if (paypalId || paypalSecret) {
    warnings.push('Only one of PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET is set. Falling back to MOCK MODE.');
  }
  if (clean(env.FORCE_MOCK_PAYMENTS) === 'true') paymentMode = 'mock';

  const anthropicKey = clean(env.ANTHROPIC_API_KEY);
  const payoutOverride = clean(env.PAYPAL_PAYOUT_RECIPIENT_EMAIL);
  if (payoutOverride && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payoutOverride)) {
    throw new Error('PAYPAL_PAYOUT_RECIPIENT_EMAIL is not a valid email address');
  }
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port <= 0) throw new Error('PORT must be a positive integer');

  return {
    port,
    production: env.NODE_ENV === 'production',
    paymentMode,
    paypal: paymentMode === 'paypal'
      ? { clientId: paypalId, clientSecret: paypalSecret, baseUrl: 'https://api-m.sandbox.paypal.com' }
      : null,
    payoutRecipientOverride: payoutOverride,
    ai: anthropicKey ? { apiKey: anthropicKey, model: 'claude-opus-5-5' } : null,
    warnings,
  };
}
