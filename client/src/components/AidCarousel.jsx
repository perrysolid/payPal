import React from 'react';

// Endless looping row of direct-aid options. Pauses on hover.
export default function AidCarousel({ cards }) {
  if (!cards.length) return null;
  let base = cards;
  while (base.length < 8) base = [...base, ...cards];
  const track = [...base, ...base];
  return (
    <div className="carousel" aria-label="Direct aid options">
      <div className="carousel-track" style={{ animationDuration: `${Math.max(30, base.length * 6)}s` }}>
        {track.map((c, i) => <div className="aid-card" key={`${c.key}-${i}`} aria-hidden={i >= base.length}>{c.node}</div>)}
      </div>
    </div>
  );
}
