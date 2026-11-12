async function request(method, url, body) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const err = new Error(data?.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('The request timed out. The server state is unchanged unless the ledger shows otherwise.');
    if (e instanceof TypeError) throw new Error('Network error: could not reach the Floodgate server.');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

export const api = {
  config: () => request('GET', '/api/config'),
  state: () => request('GET', '/api/state'),
  forecast: (id, refresh) => request('GET', `/api/districts/${id}/forecast${refresh ? '?refresh=1' : ''}`),
  scenario: (id, active) => request('POST', `/api/districts/${id}/scenario`, { active }),
  createPledge: (body) => request('POST', '/api/pledges', body),
  authorize: (orderId) => request('POST', `/api/pledges/${encodeURIComponent(orderId)}/authorize`),
  evaluate: (id) => request('POST', `/api/districts/${id}/evaluate`),
  release: (id) => request('POST', `/api/districts/${id}/release`),
  refreshPayouts: (id) => request('POST', `/api/districts/${id}/payouts/refresh`),
  ask: (question) => request('POST', '/api/ask', { question }),
  reset: () => request('POST', '/api/reset'),
  session: (token) => request('GET', `/api/auth/session/${encodeURIComponent(token)}`),
  register: (id, body) => request('POST', `/api/districts/${id}/registrations`, body),
  disburse: (id) => request('POST', `/api/districts/${id}/disburse`),
  releaseSecond: (id) => request('POST', `/api/districts/${id}/release-second`),
  essentials: (id) => request('GET', `/api/districts/${id}/essentials`),
};
