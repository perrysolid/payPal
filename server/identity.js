// Log in with PayPal (OpenID Connect) for recipient registration.
// PayPal has already verified its account holders; Floodgate stores only an anonymous ID,
// the payout email and the verification flag. No ID documents or videos are collected.
import { randomBytes } from 'node:crypto';

const SCOPES = 'openid email https://uri.paypal.com/services/paypalattributes address';

export function createIdentityService({ cfg, fetchImpl = fetch }) {
  const pending = new Map(); // state -> { districtId, at }
  const sessions = new Map(); // token -> { identity, districtId, at }
  const sweep = () => {
    const cutoff = Date.now() - 20 * 60_000;
    for (const m of [pending, sessions]) for (const [k, v] of m) if (v.at < cutoff) m.delete(k);
  };
  const isPayPal = cfg.paymentMode === 'paypal';
  const web = 'https://www.sandbox.paypal.com';
  const api = cfg.paypal?.baseUrl;

  function startUrl({ districtId, redirectUri }) {
    sweep();
    const state = randomBytes(16).toString('hex');
    pending.set(state, { districtId, at: Date.now() });
    if (!isPayPal) return { url: `/api/auth/paypal/callback?code=mock&state=${state}`, mock: true };
    const q = new URLSearchParams({ flowEntry: 'static', client_id: cfg.paypal.clientId, response_type: 'code', scope: SCOPES, redirect_uri: redirectUri, state });
    return { url: `${web}/connect/?${q}` };
  }

  async function complete({ code, state, redirectUri }) {
    const p = pending.get(state);
    if (!p) throw Object.assign(new Error('Sign-in session expired. Start again.'), { status: 400 });
    pending.delete(state);
    let identity;
    if (!isPayPal) {
      const n = randomBytes(3).toString('hex');
      identity = { subject: `mock-${n}`, email: `resident-${n}@floodgate-mock.example`, verified: true, country: null, name: 'Mock resident', sandbox: true };
    } else {
      const basic = Buffer.from(`${cfg.paypal.clientId}:${cfg.paypal.clientSecret}`).toString('base64');
      const tokRes = await fetchImpl(`${api}/v1/oauth2/token`, {
        method: 'POST',
        headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
      });
      const tok = await tokRes.json().catch(() => ({}));
      if (!tokRes.ok || !tok.access_token) throw Object.assign(new Error(`PayPal sign-in failed (${tok.error_description || tok.error || tokRes.status})`), { status: 502 });
      const uiRes = await fetchImpl(`${api}/v1/identity/openidconnect/userinfo?schema=openid`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
      const u = await uiRes.json().catch(() => ({}));
      if (!uiRes.ok) throw Object.assign(new Error(`PayPal profile request failed (${uiRes.status})`), { status: 502 });
      const email = u.email || u.emails?.find((e) => e.primary)?.value || u.emails?.[0]?.value;
      identity = {
        subject: u.user_id || u.payer_id || u.sub,
        email,
        verified: u.verified_account === true || u.verified_account === 'true',
        country: u.address?.country || null,
        name: u.name || null,
        sandbox: true, // this deployment uses the PayPal Sandbox
      };
      if (!identity.subject || !identity.email) throw Object.assign(new Error('PayPal did not return an account ID and email. Enable email for Log in with PayPal in the app settings.'), { status: 502 });
    }
    const token = randomBytes(18).toString('hex');
    sessions.set(token, { identity, districtId: p.districtId, at: Date.now() });
    return { token, districtId: p.districtId };
  }

  function session(token) {
    const s = sessions.get(String(token || ''));
    if (!s || Date.now() - s.at > 20 * 60_000) return null;
    return s;
  }
  function consume(token) { sessions.delete(String(token || '')); }
  return { startUrl, complete, session, consume };
}
