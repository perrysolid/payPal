import React, { useMemo } from 'react';

// Seamless wave path: only harmonics whose period divides W, so translateX(-50%) loops without a seam.
function wavePath(W, H, a1, p1, a2, p2, ph) {
  const pts = [];
  for (let x = 0; x <= W * 2; x += 12) {
    const y = H / 2 + a1 * Math.sin((2 * Math.PI * x) / p1 + ph) + a2 * Math.sin((2 * Math.PI * x) / p2 + ph * 1.7);
    pts.push(`${x.toFixed(0)} ${y.toFixed(2)}`);
  }
  return `M${pts.join(' L')} L${W * 2} ${H} L0 ${H}Z`;
}
function edgePath(W, H, a1, p1, a2, p2, ph) {
  const pts = [];
  for (let x = 0; x <= W * 2; x += 12) {
    const y = H / 2 + a1 * Math.sin((2 * Math.PI * x) / p1 + ph) + a2 * Math.sin((2 * Math.PI * x) / p2 + ph * 1.7);
    pts.push(`${x.toFixed(0)} ${y.toFixed(2)}`);
  }
  return `M${pts.join(' L')}`;
}

const W = 1200;
const LAYERS = [
  { cls: 'l1', top: 0, h: 40, a1: 8, p1: 600, a2: 3.5, p2: 400, ph: 0.4, fill: '#2f93c4', op: 0.38, dur: 30, foam: false },
  { cls: 'l2', top: 10, h: 40, a1: 8, p1: 400, a2: 4, p2: 300, ph: 2.1, fill: '#1c78ad', op: 0.5, dur: 21, rev: true },
  { cls: 'l4', top: 4, h: 40, a1: 9, p1: 1200, a2: 4, p2: 600, ph: 1.1, fill: '#3d9fd0', op: 0.28, dur: 38, rev: true },
  { cls: 'l3', top: 22, h: 40, a1: 7, p1: 600, a2: 4, p2: 240, ph: 4.0, fill: '#115c8c', op: 0.7, dur: 15 },
];

export default function Water() {
  const layers = useMemo(() => LAYERS.map((l) => ({ ...l, d: wavePath(W, l.h, l.a1, l.p1, l.a2, l.p2, l.ph), e: edgePath(W, l.h, l.a1, l.p1, l.a2, l.p2, l.ph) })), []);
  return (
    <div className="water" aria-hidden="true">
      <div className="water-deep" />
      {layers.map((l) => (
        <div key={l.cls} className="wl" style={{ top: l.top, opacity: l.op }}>
          <svg className={`wl-wave ${l.rev ? 'rev' : ''}`} style={{ animationDuration: `${l.dur}s`, height: l.h }} viewBox={`0 0 ${W * 2} ${l.h}`} preserveAspectRatio="none">
            <path d={l.d} fill={l.fill} />
            {l.foam && <path d={l.e} fill="none" stroke="#cdeeff" strokeOpacity=".75" strokeWidth="1.6" />}
          </svg>
          <div className="wl-fill" style={{ top: l.h - 1, background: l.fill }} />
        </div>
      ))}
      <div className="caustics" />
      <div className="sheen" />
    </div>
  );
}
