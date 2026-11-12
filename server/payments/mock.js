// In-memory MOCK payment provider. Makes NO PayPal calls. Every ID it returns is
// prefixed MOCK- so it can never be confused with a real PayPal Sandbox reference.
import { randomUUID } from 'node:crypto';

const id = (p) => `MOCK-${p}-${randomUUID().slice(0, 8).toUpperCase()}`;

export function createMockProvider() {
  const orders = new Map();
  const auths = new Map();
  const batches = new Map();
  const idem = new Map();

  function once(key, fn) {
    if (key && idem.has(key)) return idem.get(key);
    const r = fn();
    if (key) idem.set(key, r);
    return r;
  }

  return {
    mode: 'mock',
    async createOrder({ amount, districtId, description }) {
      const o = { id: id('ORDER'), status: 'CREATED', amount, districtId, description };
      orders.set(o.id, o);
      return { orderId: o.id, status: o.status };
    },
    async authorizeOrder({ orderId, requestId }) {
      return once(requestId, () => {
        const o = orders.get(orderId);
        if (!o) throw Object.assign(new Error('Unknown mock order'), { status: 404 });
        if (o.status === 'COMPLETED') throw Object.assign(new Error('ORDER_ALREADY_AUTHORIZED'), { status: 422 });
        o.status = 'COMPLETED';
        const a = { id: id('AUTH'), status: 'CREATED', amount: o.amount, orderId };
        auths.set(a.id, a);
        return {
          orderStatus: 'COMPLETED',
          authorizationId: a.id,
          authorizationStatus: 'CREATED',
          amount: o.amount,
          customId: o.districtId,
          payer: { name: 'Mock Donor', email: 'mock-donor@floodgate-sample.example', payerId: 'MOCKPAYER' },
          expirationTime: new Date(Date.now() + 29 * 864e5).toISOString(),
        };
      });
    },
    async captureAuthorization({ authorizationId, requestId }) {
      return once(requestId, () => {
        const a = auths.get(authorizationId);
        if (!a) throw Object.assign(new Error('Unknown mock authorization'), { status: 404 });
        if (a.status !== 'CREATED') throw Object.assign(new Error(`AUTHORIZATION_ALREADY_${a.status}`), { status: 422 });
        a.status = 'CAPTURED';
        return { captureId: id('CAPTURE'), status: 'COMPLETED', amount: a.amount };
      });
    },
    async voidAuthorization({ authorizationId, requestId }) {
      return once(requestId, () => {
        const a = auths.get(authorizationId);
        if (!a) throw Object.assign(new Error('Unknown mock authorization'), { status: 404 });
        if (a.status !== 'CREATED') throw Object.assign(new Error(`AUTHORIZATION_ALREADY_${a.status}`), { status: 422 });
        a.status = 'VOIDED';
        return { status: 'VOIDED' };
      });
    },
    async createPayout({ senderBatchId, items, emailSubject }) {
      if (batches.has(senderBatchId)) {
        throw Object.assign(new Error('Batch with given sender_batch_id already exists'), { status: 400, code: 'DUPLICATE_REQUEST_ID' });
      }
      const b = {
        payoutBatchId: id('BATCH'),
        senderBatchId,
        batchStatus: 'PENDING',
        polls: 0,
        emailSubject,
        items: items.map((it) => ({ ...it, payoutItemId: id('ITEM'), transactionStatus: 'PENDING' })),
      };
      batches.set(b.payoutBatchId, b);
      return { payoutBatchId: b.payoutBatchId, batchStatus: b.batchStatus };
    },
    async getPayout(payoutBatchId) {
      const b = batches.get(payoutBatchId);
      if (!b) throw Object.assign(new Error('Unknown mock payout batch'), { status: 404 });
      b.polls += 1;
      // Simulated lifecycle: PENDING -> PROCESSING -> SUCCESS over successive polls.
      if (b.polls >= 2) {
        b.batchStatus = 'SUCCESS';
        b.items.forEach((i) => { i.transactionStatus = 'SUCCESS'; });
      } else if (b.polls >= 1) b.batchStatus = 'PROCESSING';
      return {
        payoutBatchId: b.payoutBatchId,
        batchStatus: b.batchStatus,
        items: b.items.map((i) => ({
          payoutItemId: i.payoutItemId,
          senderItemId: i.senderItemId,
          transactionStatus: i.transactionStatus,
          receiver: i.receiver,
          amount: i.amount,
          errors: null,
        })),
      };
    },
  };
}
