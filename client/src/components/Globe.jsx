import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

const TEX = 'https://cdn.jsdelivr.net/npm/three-globe@2.31.0/example/img/earth-night.jpg';
const TILT = THREE.MathUtils.degToRad(23.44);
const COLORS = { Red: 0xff3b30, Orange: 0xff9f0a, Green: 0x30d158 };

export function latLngToVec3(lat, lng, r = 1) {
  const phi = THREE.MathUtils.degToRad(90 - lat);
  const theta = THREE.MathUtils.degToRad(lng + 180);
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}

export default function Globe({ events }) {
  const host = useRef(null);
  const api = useRef(null);

  // Scene setup, once.
  useEffect(() => {
    const el = host.current;
    const w = () => el.clientWidth || 600;
    const h = () => el.clientHeight || 600;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, w() / h(), 0.1, 100);
    camera.position.set(0, 0.3, 3.3);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w(), h());
    renderer.domElement.style.touchAction = 'none';
    el.appendChild(renderer.domElement);

    const labels = new CSS2DRenderer();
    labels.setSize(w(), h());
    Object.assign(labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    el.appendChild(labels.domElement);

    // Stars
    const starPos = new Float32Array(900);
    for (let i = 0; i < 900; i += 3) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(30 + Math.random() * 20);
      starPos.set([v.x, v.y, v.z], i);
    }
    const starGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.08, transparent: true, opacity: 0.7 })));

    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(3, 2, 4);
    scene.add(sun);

    // Root group carries the cursor rotation; tilt holds the axis; spin is the Earth's own turn.
    const root = new THREE.Group();
    scene.add(root);
    const tilt = new THREE.Group();
    tilt.rotation.z = TILT;
    root.add(tilt);
    const spin = new THREE.Group();
    tilt.add(spin);

    const tex = new THREE.TextureLoader().load(TEX);
    tex.colorSpace = THREE.SRGBColorSpace;
    spin.add(new THREE.Mesh(
      new THREE.SphereGeometry(1, 96, 96),
      new THREE.MeshBasicMaterial({ map: tex, color: 0xb8c6d8 }),
    ));

    // Atmosphere glow
    scene.add(new THREE.Mesh(
      new THREE.SphereGeometry(1.14, 64, 64),
      new THREE.ShaderMaterial({
        transparent: true, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false,
        vertexShader: 'varying vec3 n; void main(){ n = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'varying vec3 n; void main(){ float i = pow(0.62 - dot(n, vec3(0.0,0.0,1.0)), 3.0); gl_FragColor = vec4(0.25,0.6,1.0,1.0) * i; }',
      }),
    ));

    // 3D axis through the poles.
    const axisMat = new THREE.MeshStandardMaterial({ color: 0x8fdcf0, metalness: 0.55, roughness: 0.3, emissive: 0x1b5a70, emissiveIntensity: 0.6 });
    tilt.add(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 2.3, 24), axisMat));
    for (const dir of [1, -1]) {
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.034, 0.1, 24), axisMat);
      tip.position.y = dir * 1.2;
      if (dir < 0) tip.rotation.x = Math.PI;
      tilt.add(tip);
    }
    spin.add(new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(Array.from({ length: 128 }, (_, i) => new THREE.Vector3(Math.cos((i / 128) * Math.PI * 2) * 1.003, 0, Math.sin((i / 128) * Math.PI * 2) * 1.003))),
      new THREE.LineBasicMaterial({ color: 0x7fc4d8, transparent: true, opacity: 0.25 }),
    ));

    // Smooth free rotation: drag spins the globe about screen axes, then glides to a stop.
    const dom = renderer.domElement;
    let dragging = false;
    let px = 0;
    let py = 0;
    let vx = 0;
    let vy = 0;
    const qx = new THREE.Quaternion();
    const qy = new THREE.Quaternion();
    const AX = new THREE.Vector3(1, 0, 0);
    const AY = new THREE.Vector3(0, 1, 0);
    const SPEED = 0.0052;
    const rotate = (dx, dy) => {
      qy.setFromAxisAngle(AY, dx * SPEED);
      qx.setFromAxisAngle(AX, dy * SPEED);
      root.quaternion.premultiply(qy).premultiply(qx);
    };
    const down = (e) => { dragging = true; px = e.clientX; py = e.clientY; vx = 0; vy = 0; dom.setPointerCapture(e.pointerId); };
    const move = (e) => {
      if (!dragging) return;
      const dx = e.clientX - px;
      const dy = e.clientY - py;
      px = e.clientX; py = e.clientY;
      rotate(dx, dy);
      vx = vx * 0.6 + dx * 0.4;
      vy = vy * 0.6 + dy * 0.4;
    };
    const up = (e) => { dragging = false; try { dom.releasePointerCapture(e.pointerId); } catch { /* already released */ } };
    dom.addEventListener('pointerdown', down);
    dom.addEventListener('pointermove', move);
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);

    const markers = new THREE.Group();
    spin.add(markers);

    const camDir = new THREE.Vector3();
    const wp = new THREE.Vector3();
    let raf;
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!dragging) {
        spin.rotation.y += dt * 0.12;
        if (Math.abs(vx) > 0.01 || Math.abs(vy) > 0.01) {
          rotate(vx, vy);
          const decay = Math.pow(0.04, dt); // ~1s glide
          vx *= decay; vy *= decay;
        }
      }
      camDir.copy(camera.position).normalize();
      markers.children.forEach((m) => {
        if (m.userData.label) {
          m.getWorldPosition(wp);
          const facing = wp.clone().normalize().dot(camDir);
          m.userData.label.element.style.opacity = facing > 0.12 ? String(Math.min(1, (facing - 0.12) * 4)) : '0';
        }
        if (m.userData.pulse) m.scale.setScalar(1 + 0.5 * Math.sin(now / 420 + m.userData.phase));
      });
      renderer.render(scene, camera);
      labels.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    const ro = new ResizeObserver(() => { camera.aspect = w() / h(); camera.updateProjectionMatrix(); renderer.setSize(w(), h()); labels.setSize(w(), h()); });
    ro.observe(el);

    api.current = { markers };
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      dom.removeEventListener('pointerdown', down);
      dom.removeEventListener('pointermove', move);
      dom.removeEventListener('pointerup', up);
      dom.removeEventListener('pointercancel', up);
      renderer.dispose();
      scene.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
      el.replaceChildren();
      api.current = null;
    };
  }, []);

  // Markers + tiny labels whenever the event list changes.
  useEffect(() => {
    const g = api.current?.markers;
    if (!g) return;
    g.children.slice().forEach((m) => { m.userData.label?.removeFromParent(); m.userData.label?.element.remove(); g.remove(m); m.geometry.dispose(); m.material.dispose(); });
    (events ?? []).forEach((ev, i) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(0.014, 12, 12), new THREE.MeshBasicMaterial({ color: COLORS[ev.alert] ?? COLORS.Green }));
      m.position.copy(latLngToVec3(ev.lat, ev.lng, 1.012));
      m.userData = { pulse: ev.alert !== 'Green', phase: i };
      g.add(m);
    });
  }, [events]);

  return <div className="globe-host" ref={host} />;
}
