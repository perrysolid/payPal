import React, { useMemo, useRef, useState, useEffect } from 'react';
import { m3s, shortDate } from '../format.js';

const H = 280;
const PAD = { l: 58, r: 16, t: 18, b: 30 };

function niceTicks(max, count = 5) {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => raw <= s) ?? raw;
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
  return ticks;
}

export default function Chart({ live, simulated, showSim, baseline, threshold }) {
  const wrapRef = useRef(null);
  const [W, setW] = useState(760);
  const [hover, setHover] = useState(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const model = useMemo(() => {
    if (!live) return null;
    const past = live.past;
    const fc = live.forecast;
    const simFc = showSim && simulated ? simulated.forecast : null;
    const all = [...past, ...fc];
    const danger = baseline * threshold;
    const values = [...all.map((p) => p.value), ...(simFc ?? []).map((p) => p.value), danger].filter((v) => v != null);
    const yMax = niceTicks(Math.max(...values) * 1.08).at(-1);
    const n = all.length;
    const x = (i) => PAD.l + (i / (n - 1)) * (W - PAD.l - PAD.r);
    const y = (v) => PAD.t + (1 - v / yMax) * (H - PAD.t - PAD.b);
    const path = (pts, offset = 0) => pts
      .map((p, i) => (p.value == null ? null : `${x(i + offset).toFixed(1)},${y(p.value).toFixed(1)}`))
      .filter(Boolean)
      .map((s, i) => `${i ? 'L' : 'M'}${s}`)
      .join(' ');
    const todayIdx = past.length;
    const lastPast = past.at(-1);
    // Connect forecast line to the last observation for continuity.
    const fcWithJoin = lastPast ? [lastPast, ...fc] : fc;
    const simWithJoin = simFc && lastPast ? [lastPast, ...simFc] : simFc;
    return {
      all, n, x, y, yMax, ticks: niceTicks(yMax),
      pastPath: path(past),
      fcPath: path(fcWithJoin, todayIdx - (lastPast ? 1 : 0)),
      simPath: simWithJoin ? path(simWithJoin, todayIdx - (lastPast ? 1 : 0)) : null,
      simArea: simWithJoin ? `${path(simWithJoin, todayIdx - 1)} L${x(n - 1)},${y(0)} L${x(todayIdx - 1)},${y(0)} Z` : null,
      todayX: x(todayIdx - 0.5),
      danger,
      simFc,
      todayIdx,
    };
  }, [live, simulated, showSim, baseline, threshold, W]);

  if (!model) return <div ref={wrapRef} className="skeleton" style={{ height: H }} />;

  const { x, y, ticks, all, n, todayIdx } = model;
  const labelEvery = W < 520 ? 9 : 5;

  function onMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    if (i < 0 || i >= n) return setHover(null);
    setHover(i);
  }

  const hp = hover != null ? all[hover] : null;
  const hSim = hover != null && model.simFc && hover >= todayIdx ? model.simFc[hover - todayIdx] : null;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
        aria-label="River discharge: 30 days observed and 7-day forecast"
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <defs>
          <pattern id="simhatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--sim)" fillOpacity="0.06" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="var(--sim)" strokeOpacity="0.18" strokeWidth="2" />
          </pattern>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--line-2)" />
            <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" fontSize="10.5" fill="var(--muted)" fontFamily="IBM Plex Mono">
              {t >= 1000 ? `${(t / 1000).toLocaleString('en-US')}k` : t}
            </text>
          </g>
        ))}
        <rect x={model.todayX} y={PAD.t} width={W - PAD.r - model.todayX} height={H - PAD.t - PAD.b} fill="var(--river)" fillOpacity="0.045" />
        <line x1={model.todayX} x2={model.todayX} y1={PAD.t} y2={H - PAD.b} stroke="var(--ink-2)" strokeDasharray="2 3" />
        <text x={model.todayX + 6} y={PAD.t + 10} fontSize="10.5" fill="var(--ink-2)" fontFamily="IBM Plex Mono">FORECAST</text>
        <text x={model.todayX - 6} y={PAD.t + 10} fontSize="10.5" fill="var(--muted)" textAnchor="end" fontFamily="IBM Plex Mono">OBSERVED</text>

        {model.simArea && <path d={model.simArea} fill="url(#simhatch)" />}
        {model.simArea && <text x={W - PAD.r - 6} y={H - PAD.b - 8} textAnchor="end" fontSize="11" fontWeight="600" fill="var(--sim)" fontFamily="IBM Plex Mono">SCENARIO</text>}

        <line x1={PAD.l} x2={W - PAD.r} y1={y(baseline)} y2={y(baseline)} stroke="var(--muted)" strokeDasharray="6 4" strokeWidth="1.3" />
        <text x={PAD.l + 6} y={y(baseline) - 5} fontSize="10.5" fill="var(--ink-2)" fontFamily="IBM Plex Mono">30-day median {m3s(baseline)}</text>
        <line x1={PAD.l} x2={W - PAD.r} y1={y(model.danger)} y2={y(model.danger)} stroke="var(--danger)" strokeWidth="1.5" />
        <text x={PAD.l + 6} y={y(model.danger) - 5} fontSize="10.5" fill="var(--danger)" fontFamily="IBM Plex Mono">Danger {threshold.toFixed(2)}× = {m3s(model.danger)}</text>

        <path d={model.pastPath} fill="none" stroke="var(--ink)" strokeWidth="2" strokeLinejoin="round" />
        <path d={model.fcPath} fill="none" stroke="var(--river)" strokeWidth="2" strokeDasharray="5 4" strokeLinejoin="round" />
        {model.simPath && <path d={model.simPath} fill="none" stroke="var(--sim)" strokeWidth="2.6" strokeLinejoin="round" />}

        {all.map((p, i) => (i % labelEvery === 0 || (i === n - 1 && (n - 1) % labelEvery > 2)) && (
          <text key={p.date} x={x(i)} y={H - 10} fontSize="10.5" fill="var(--muted)" textAnchor="middle" fontFamily="IBM Plex Mono">{shortDate(p.date)}</text>
        ))}

        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} stroke="var(--ink)" strokeOpacity="0.25" />
            {hp?.value != null && <circle cx={x(hover)} cy={y(hp.value)} r="3.5" fill={hover >= todayIdx ? 'var(--river)' : 'var(--ink)'} />}
            {hSim && <circle cx={x(hover)} cy={y(hSim.value)} r="3.5" fill="var(--sim)" />}
          </g>
        )}
      </svg>
      {hover != null && hp && (
        <div style={{
          position: 'absolute', top: 8, left: Math.min(Math.max(x(hover) / W * 100, 8), 70) + '%',
          background: 'var(--ink)', color: 'var(--surface)', padding: '6px 9px', borderRadius: 6, fontSize: 12, pointerEvents: 'none', whiteSpace: 'nowrap',
        }}>
          <div className="mono" style={{ opacity: 0.7, fontSize: 11 }}>{shortDate(hp.date)} · {hover >= todayIdx ? 'forecast' : 'observed'}</div>
          <div className="mono">Live: {m3s(hp.value)}</div>
          {hSim && <div className="mono" style={{ color: '#cdb8f0' }}>Scenario: {m3s(hSim.value)}</div>}
        </div>
      )}
    </div>
  );
}
