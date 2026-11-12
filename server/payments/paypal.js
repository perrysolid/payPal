// PayPal Sandbox provider.
// Orders + Payments use the official APIMatic-generated @paypal/paypal-server-sdk.
// Payouts are not in the SDK (v2.5.0 ships Orders, Payments, Vault, Transaction Search,
// Subscriptions), so Payouts uses REST with an OAuth client-credentials token.
import {
  Client,
  Environment,
  OrdersController,
  PaymentsController,
  CheckoutPaymentIntent,
  ApiError,
} from '@paypal/paypal-server-sdk';

const TIMEOUT_MS = 20_000;

function paypalError(e, op) {
  if (e instanceof ApiError) {
    let detail = null;
    try {
      const body = typeof e.body === 'string' ? JSON.parse(e.body) : e.result;
      detail = body?.details?.[0]?.issue || body?.name || body?.message || null;
      const debugId = body?.debug_id;
      const err = new Error(`PayPal ${op} failed (${e.statusCode}${detail ? `: ${detail}` : ''})`);
      err.status = e.statusCode;
      err.code = detail;
      err.debugId = debugId;
      return err;
    } catch {
      /* fall through */
    }
    const err = new Error(`PayPal ${op} failed (${e.statusCode})`);
    err.status = e.statusCode;
    return err;
  }
  const err = new Error(`PayPal ${op} failed: ${e.message}`);
  err.status = 502;
  return err;
}

export function createPayPalProvider({ clientId, clientSecret, baseUrl }) {
  const client = new Client({
    clientCredentialsAuthCredentials: { oAuthClientId: clientId, oAuthClientSecret: clientSecret },
    timeout: TIMEOUT_MS,
    environment: Environment.Sandbox,
  });
  const orders = new OrdersController(client);
  const payments = new PaymentsController(client);

  let token = null; // { value, expiresAt }
  async function accessToken() {
    if (token && Date.now() < token.expiresAt - 60_000) return token.value;
    const res = await fetchWithTimeout(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      const err = new Error(`PayPal OAuth failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    const j = await res.json();
    token = { value: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
    return token.value;
  }

  async function fetchWithTimeout(url, opts) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } catch (e) {
      const err = new Error(e.name === 'AbortError' ? 'PayPal request timed out' : `PayPal network error: ${e.message}`);
      err.status = 504;
      throw err;
    } finally {
      clearTimeout(t);
    }
  }

  async function rest(method, path, body, requestId) {
    const headers = { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' };
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    const res = await fetchWithTimeout(`${baseUrl}${path}`, { method, headers, body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    let j = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok) {
      const issue = j?.details?.[0]?.issue || j?.name || j?.message;
      const err = new Error(`PayPal ${method} ${path.split('?')[0]} failed (${res.status}${issue ? `: ${issue}` : ''})`);
      err.status = res.status;
      err.code = j?.name || issue;
      err.debugId = j?.debug_id;
      throw err;
    }
    return j;
  }

  return {
    mode: 'paypal',

    async createOrder({ amount, districtId, description, referenceId, requestId }) {
      try {
        const { result } = await orders.createOrder({
          body: {
            intent: CheckoutPaymentIntent.Authorize,
            purchaseUnits: [
              {
                referenceId,
                customId: districtId,
                description,
                softDescriptor: 'FLOODGATE',
                amount: { currencyCode: 'USD', value: amount },
              },
            ],
          },
          paypalRequestId: requestId,
          prefer: 'return=minimal',
        });
        return { orderId: result.id, status: result.status };
      } catch (e) {
        throw paypalError(e, 'create order');
      }
    },

    async authorizeOrder({ orderId, requestId }) {
      try {
        const { result } = await orders.authorizeOrder({ id: orderId, paypalRequestId: requestId, prefer: 'return=representation' });
        const pu = result.purchaseUnits?.[0];
        const auth = pu?.payments?.authorizations?.[0];
        if (!auth?.id) throw new Error('PayPal response did not include an authorization');
        return {
          orderStatus: result.status,
          authorizationId: auth.id,
          authorizationStatus: auth.status,
          amount: auth.amount?.value,
          currency: auth.amount?.currencyCode,
          customId: auth.customId ?? pu?.customId ?? null,
          expirationTime: auth.expirationTime ?? null,
          payer: {
            name: [result.payer?.name?.givenName, result.payer?.name?.surname].filter(Boolean).join(' ') || null,
            email: result.payer?.emailAddress ?? null,
            payerId: result.payer?.payerId ?? null,
          },
        };
      } catch (e) {
        if (e.status) throw e;
        throw paypalError(e, 'authorize order');
      }
    },

    async captureAuthorization({ authorizationId, requestId }) {
      try {
        const { result } = await payments.captureAuthorizedPayment({
          authorizationId,
          paypalRequestId: requestId,
          prefer: 'return=representation',
          body: { finalCapture: true },
        });
        return { captureId: result.id, status: result.status, amount: result.amount?.value };
      } catch (e) {
        throw paypalError(e, 'capture authorization');
      }
    },

    async voidAuthorization({ authorizationId, requestId }) {
      try {
        const { result } = await payments.voidPayment({ authorizationId, paypalRequestId: requestId, prefer: 'return=representation' });
        return { status: result?.status ?? 'VOIDED' };
      } catch (e) {
        throw paypalError(e, 'void authorization');
      }
    },

    async createPayout({ senderBatchId, items, emailSubject, emailMessage }) {
      const j = await rest('POST', '/v1/payments/payouts', {
        sender_batch_header: { sender_batch_id: senderBatchId, email_subject: emailSubject, email_message: emailMessage },
        items: items.map((it) => ({
          recipient_type: 'EMAIL',
          amount: { value: it.amount, currency: 'USD' },
          receiver: it.receiver,
          note: it.note,
          sender_item_id: it.senderItemId,
        })),
      }, senderBatchId);
      return { payoutBatchId: j.batch_header.payout_batch_id, batchStatus: j.batch_header.batch_status };
    },

    async getPayout(payoutBatchId) {
      const j = await rest('GET', `/v1/payments/payouts/${encodeURIComponent(payoutBatchId)}`);
      return {
        payoutBatchId: j.batch_header.payout_batch_id,
        batchStatus: j.batch_header.batch_status,
        items: (j.items || []).map((i) => ({
          payoutItemId: i.payout_item_id,
          senderItemId: i.payout_item?.sender_item_id,
          transactionStatus: i.transaction_status,
          receiver: i.payout_item?.receiver,
          amount: i.payout_item?.amount?.value,
          errors: i.errors ? (i.errors.name || i.errors.message) : null,
        })),
      };
    },
  
    /**
     * Verify a webhook delivery with PayPal. The raw request body is embedded verbatim so the
     * signed payload is byte-identical (re-serialising parsed JSON can break verification).
     */
    async verifyWebhook({ headers, rawBody, webhookId }) {
      const h = (k) => headers[k] ?? headers[k.toLowerCase()];
      const fields = {
        auth_algo: h('paypal-auth-algo'),
        cert_url: h('paypal-cert-url'),
        transmission_id: h('paypal-transmission-id'),
        transmission_sig: h('paypal-transmission-sig'),
        transmission_time: h('paypal-transmission-time'),
        webhook_id: webhookId,
      };
      if (Object.values(fields).some((v) => typeof v !== 'string' || !v) || typeof rawBody !== 'string' || !rawBody) return false;
      const body = `{${Object.entries(fields).map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',')},"webhook_event":${rawBody}}`;
      const j = await rest('POST', '/v1/notifications/verify-webhook-signature', body);
      return j?.verification_status === 'SUCCESS';
    },

    /** Find the webhook registered for `url` on this REST app, or create it. Idempotent by URL. */
    async ensureWebhook(url, eventTypes) {
      const list = await rest('GET', '/v1/notifications/webhooks');
      const existing = (list?.webhooks || []).find((w) => w.url === url);
      if (existing) {
        const have = new Set((existing.event_types || []).map((e) => e.name));
        if (eventTypes.every((e) => have.has(e))) return { id: existing.id, created: false };
        await rest('PATCH', `/v1/notifications/webhooks/${existing.id}`, [{ op: 'replace', path: '/event_types', value: eventTypes.map((name) => ({ name })) }]);
        return { id: existing.id, created: false, updated: true };
      }
      const j = await rest('POST', '/v1/notifications/webhooks', { url, event_types: eventTypes.map((name) => ({ name })) });
      return { id: j.id, created: true };
    },
  };
}
