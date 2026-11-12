import React, { useEffect, useRef, useState } from 'react';

let sdkPromise = null;
function loadSdk(clientId) {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=authorize&components=buttons&disable-funding=paylater,venmo`;
    s.async = true;
    s.onload = () => (window.paypal ? resolve(window.paypal) : reject(new Error('PayPal SDK did not initialise')));
    s.onerror = () => { sdkPromise = null; reject(new Error('Could not load the PayPal JavaScript SDK')); };
    document.head.appendChild(s);
  });
  return sdkPromise;
}

/**
 * PayPal Smart Buttons with intent=authorize. The order is created and authorized on
 * our server; the browser only approves it. Amount and district come from refs so the
 * buttons do not re-render on every keystroke.
 */
export default function PayPalButtons({ clientId, getPledge, disabled, onCreate, onApproved, onError, onCancel }) {
  const host = useRef(null);
  const handlers = useRef({});
  handlers.current = { getPledge, onCreate, onApproved, onError, onCancel };
  const [status, setStatus] = useState('loading');

  useEffect(() => {
    let buttons;
    let cancelled = false;
    loadSdk(clientId).then((paypal) => {
      if (cancelled || !host.current) return;
      buttons = paypal.Buttons({
        style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'paypal', height: 42, tagline: false },
        createOrder: async () => {
          const body = handlers.current.getPledge();
          const res = await handlers.current.onCreate(body);
          return res.orderId;
        },
        onApprove: async (data) => {
          await handlers.current.onApproved(data.orderID);
        },
        onCancel: () => handlers.current.onCancel?.(),
        onError: (err) => handlers.current.onError(err instanceof Error ? err : new Error(String(err?.message || err))),
      });
      buttons.render(host.current).then(() => !cancelled && setStatus('ready')).catch((e) => { setStatus('error'); handlers.current.onError(e); });
    }).catch((e) => { setStatus('error'); handlers.current.onError(e); });
    return () => { cancelled = true; try { buttons?.close(); } catch { /* ignore */ } };
  }, [clientId]);

  return (
    <div style={{ position: 'relative', opacity: disabled ? 0.45 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
      {status === 'loading' && <div className="skeleton" style={{ height: 42 }} />}
      {status === 'error' && <div className="inline-error" style={{ margin: 0 }}>PayPal buttons failed to load. Check your network and reload.</div>}
      <div ref={host} className="pp-holder" />
    </div>
  );
}
