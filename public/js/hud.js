// HUD overlay for camera mode.
//
// Sizes itself dynamically to the current viewport so corner brackets,
// crosshair, and tick marks land in the right proportional positions on
// any device (portrait phone, landscape phone, tablet, desktop).
// SVG viewBox is rewritten to match the current window dimensions on
// build, and rebuilt on resize/orientation change.

const NS = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('hud-overlay');

let vbW = 1000;
let vbH = 600;
let built = false;
let fadeTimer = null;

function el(tag, attrs = {}, parent = svg) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  parent.appendChild(e);
  return e;
}

function clear() { while (svg.firstChild) svg.removeChild(svg.firstChild); }

function readViewport() {
  vbW = Math.max(320, window.innerWidth || document.documentElement.clientWidth || 1000);
  vbH = Math.max(320, window.innerHeight || document.documentElement.clientHeight || 600);
}

export function buildBaseHud() {
  readViewport();
  svg.setAttribute('viewBox', `0 0 ${vbW} ${vbH}`);
  clear();
  built = true;

  // Anchor everything to a proportion of the smaller dimension so the HUD
  // never looks oversized in one axis (eg portrait phones).
  const s = Math.min(vbW, vbH);
  const m = Math.max(16, s * 0.05);
  const bracketLen = Math.max(20, s * 0.07);
  const strokeW = Math.max(1.5, s * 0.0035);

  const corner = (x, y, fx, fy) => {
    el('polyline', {
      class: 'hud-stroke',
      'stroke-width': strokeW,
      points: `${x},${y + bracketLen * fy} ${x},${y} ${x + bracketLen * fx},${y}`,
    });
  };
  corner(m, m, 1, 1);
  corner(vbW - m, m, -1, 1);
  corner(m, vbH - m, 1, -1);
  corner(vbW - m, vbH - m, -1, -1);

  // Center crosshair — sized to fit but never larger than ~18% of view
  const cx = vbW / 2;
  const cy = vbH / 2;
  const r = Math.min(s * 0.09, 90);
  el('circle', { class: 'hud-stroke', cx, cy, r, 'stroke-opacity': 0.5, 'stroke-width': strokeW });
  el('circle', { class: 'hud-stroke', cx, cy, r: Math.max(3, r * 0.13), 'stroke-width': strokeW });
  const tickIn = r * 0.35;
  const tickOut = r * 1.35;
  el('line', { class: 'hud-stroke', x1: cx - tickOut, y1: cy, x2: cx - tickIn, y2: cy, 'stroke-width': strokeW });
  el('line', { class: 'hud-stroke', x1: cx + tickIn, y1: cy, x2: cx + tickOut, y2: cy, 'stroke-width': strokeW });
  el('line', { class: 'hud-stroke', x1: cx, y1: cy - tickOut, x2: cx, y2: cy - tickIn, 'stroke-width': strokeW });
  el('line', { class: 'hud-stroke', x1: cx, y1: cy + tickIn, x2: cx, y2: cy + tickOut, 'stroke-width': strokeW });

  // Side tick rule — only worth showing when there's horizontal room
  if (vbW / vbH > 1.15) {
    const railTop = vbH * 0.18;
    const railBot = vbH * 0.82;
    const railStart = vbW * 0.14;
    const railEnd = vbW * 0.86;
    const step = (railEnd - railStart) / 20;
    const tickShort = Math.max(4, s * 0.012);
    const tickLong = tickShort * 2;
    for (let i = 0; i <= 20; i++) {
      const x = railStart + i * step;
      const h = (i % 5 === 0) ? tickLong : tickShort;
      el('line', { class: 'hud-stroke', x1: x, y1: railTop, x2: x, y2: railTop + h, 'stroke-opacity': 0.6, 'stroke-width': strokeW * 0.8 });
      el('line', { class: 'hud-stroke', x1: x, y1: railBot, x2: x, y2: railBot - h, 'stroke-opacity': 0.6, 'stroke-width': strokeW * 0.8 });
    }
  }

  // Status labels at top-left
  const fontMain = Math.max(10, s * 0.018);
  const t1 = el('text', { x: m + 6, y: m - fontMain * 0.4, class: 'holo-text', 'font-size': fontMain });
  t1.textContent = 'FRIDAY · VISUAL';
  const t2 = el('text', { x: m + 6, y: m - fontMain * 0.4 + fontMain * 1.1, class: 'holo-text', 'font-size': fontMain * 0.8, opacity: 0.7 });
  t2.textContent = 'READY';

  // Animated scanning band — height proportional
  el('rect', { class: 'scan', x: 0, y: 0, width: vbW, height: Math.max(3, vbH * 0.008) });
}

export function showReticle(x, y, label) {
  if (!built) buildBaseHud();
  const s = Math.min(vbW, vbH);
  const cx = x * vbW;
  const cy = y * vbH;
  const r = Math.max(14, s * 0.035);
  const strokeW = Math.max(1.2, s * 0.003);
  const fontSize = Math.max(9, s * 0.015);
  const g = el('g', {});
  el('circle', { class: 'reticle', cx, cy, r, 'stroke-width': strokeW }, g);
  el('line', { class: 'reticle', x1: cx - r * 1.4, y1: cy, x2: cx - r * 0.55, y2: cy, 'stroke-width': strokeW }, g);
  el('line', { class: 'reticle', x1: cx + r * 0.55, y1: cy, x2: cx + r * 1.4, y2: cy, 'stroke-width': strokeW }, g);
  if (label) {
    const t = el('text', { x: cx + r * 1.3, y: cy + fontSize * 0.35, class: 'holo-text', 'font-size': fontSize }, g);
    t.textContent = label;
  }
  setTimeout(() => { try { svg.removeChild(g); } catch {} }, 12000);
  return g;
}

export function clearReticles() {
  [...svg.querySelectorAll('g')].forEach(g => svg.removeChild(g));
}

export function setReadout(text) {
  const r = document.getElementById('hud-readout');
  if (!r) return;
  r.textContent = text || '';
  r.classList.remove('faded');
  clearTimeout(fadeTimer);
  if (text) fadeTimer = setTimeout(() => r.classList.add('faded'), 9000);
}

// Rebuild on viewport changes so HUD stays proportional.
let rebuildTimer = null;
function scheduleRebuild() {
  if (!built) return;
  if (document.getElementById('camera-stage')?.hidden) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(buildBaseHud, 180);
}
window.addEventListener('resize', scheduleRebuild);
window.addEventListener('orientationchange', () => setTimeout(scheduleRebuild, 250));
