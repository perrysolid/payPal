import React, { useEffect, useRef, useState } from 'react';

const COLORS = { Red: '#ff3b30', Orange: '#ff9f0a', Green: '#30d158' };
let leafletLoader = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletLoader) {
    leafletLoader = new Promise((resolve, reject) => {
      if (!document.querySelector('link[href*="leaflet"]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
        document.head.appendChild(link);
      }
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.async = true;
      script.onload = () => resolve(window.L);
      script.onerror = () => {
        leafletLoader = null;
        reject(new Error('Open flood map engine failed to load'));
      };
      document.head.appendChild(script);
    });
  }
  return leafletLoader;
}

function popupHtml(ev) {
  const from = (ev.from ?? '').slice(0, 10);
  const to = (ev.to ?? '').slice(0, 10);
  const dates = from && to ? `${from} → ${to}` : from || 'Current';
  const reportLink = ev.report?.startsWith('https://www.gdacs.org/')
    ? `<div style="margin-top:6px;"><a href="${ev.report}" target="_blank" rel="noopener noreferrer" style="color:#0070ba;font-weight:600;text-decoration:none;">View GDACS Report ↗</a></div>`
    : '';

  return `
    <div style="font-family:system-ui,sans-serif;color:#0f1b27;font-size:12.5px;line-height:1.4;min-width:180px;">
      <b style="font-size:13.5px;display:block;margin-bottom:3px;">${ev.name || `Flood in ${ev.country}`}</b>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${COLORS[ev.alert] || '#30d158'};"></span>
        <b>${ev.alert} alert</b> · <span>${ev.country}</span>
      </div>
      <div style="color:#5f7387;font-size:11.5px;margin-bottom:2px;">Dates: ${dates}</div>
      <div style="color:#5f7387;font-size:11px;">Monitored via Open-Meteo GloFAS & GDACS</div>
      ${reportLink}
    </div>
  `;
}

export default function FloodMap({ events }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let active = true;
    loadLeaflet()
      .then((L) => {
        if (!active || !containerRef.current || mapRef.current) return;
        // Dark theme basemap tiles: Open, keyless, matching Open-Meteo / dark palette
        const map = L.map(containerRef.current, {
          center: [22, 80],
          zoom: 3,
          minZoom: 2,
          maxZoom: 14,
          zoomControl: true,
          attributionControl: true,
        });

        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
          subdomains: 'abcd',
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> &copy; <a href="https://carto.com/" target="_blank">CARTO</a> · Forecasts: Open-Meteo GloFAS',
        }).addTo(map);

        mapRef.current = map;
        renderMarkers(L, map);
      })
      .catch((e) => {
        if (active) setErr(e.message);
      });

    return () => {
      active = false;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  const renderMarkers = (L, map) => {
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    (events ?? []).forEach((ev) => {
      if (!Number.isFinite(ev.lat) || !Number.isFinite(ev.lng)) return;
      const radius = ev.alert === 'Red' ? 9 : ev.alert === 'Orange' ? 7 : 5;
      const color = COLORS[ev.alert] || COLORS.Green;

      const marker = L.circleMarker([ev.lat, ev.lng], {
        radius,
        fillColor: color,
        color: '#ffffff',
        weight: 1.5,
        opacity: 0.95,
        fillOpacity: 0.85,
      }).addTo(map);

      marker.bindPopup(popupHtml(ev), {
        closeButton: true,
        className: 'flood-popup',
      });

      markersRef.current.push(marker);
    });
  };

  useEffect(() => {
    if (window.L && mapRef.current) {
      renderMarkers(window.L, mapRef.current);
    }
  }, [events]);

  if (err) return <div className="map-empty">{err}</div>;

  return (
    <div
      ref={containerRef}
      className="map-host"
      style={{ width: '100%', height: '100%', minHeight: '360px', background: '#070f18' }}
    />
  );
}
