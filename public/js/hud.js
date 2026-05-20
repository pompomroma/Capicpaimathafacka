const NS = 'http://www.w3.org/2000/svg';
const svg = document.getElementById('hud-overlay');

function el(tag, attrs = {}, parent = svg) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  parent.appendChild(e);
  return e;
}

function clear() { while (svg.firstChild) svg.removeChild(svg.firstChild); }

export function buildBaseHud() {
  clear();
  // Corners
  const corner = (x, y, fx, fy) => {
    el('polyline', { class: 'hud-stroke', points: `${x},${y + 60 * fy} ${x},${y} ${x + 60 * fx},${y}` });
  };
  corner(40, 40, 1, 1);
  corner(960, 40, -1, 1);
  corner(40, 560, 1, -1);
  corner(960, 560, -1, -1);

  // Center crosshair
  const cx = 500, cy = 300;
  el('circle', { class: 'hud-stroke', cx, cy, r: 60, 'stroke-opacity': 0.6 });
  el('circle', { class: 'hud-stroke', cx, cy, r: 8 });
  el('line', { class: 'hud-stroke', x1: cx - 80, y1: cy, x2: cx - 20, y2: cy });
  el('line', { class: 'hud-stroke', x1: cx + 20, y1: cy, x2: cx + 80, y2: cy });
  el('line', { class: 'hud-stroke', x1: cx, y1: cy - 80, x2: cx, y2: cy - 20 });
  el('line', { class: 'hud-stroke', x1: cx, y1: cy + 20, x2: cx, y2: cy + 80 });

  // Top/bottom tick rule
  for (let i = 0; i < 21; i++) {
    const x = 100 + i * 40;
    const h = (i % 5 === 0) ? 14 : 7;
    el('line', { class: 'hud-stroke', x1: x, y1: 100, x2: x, y2: 100 + h, 'stroke-opacity': 0.6 });
    el('line', { class: 'hud-stroke', x1: x, y1: 500, x2: x, y2: 500 - h, 'stroke-opacity': 0.6 });
  }

  // Status label
  el('text', { x: 70, y: 80, class: 'holo-text' }).textContent = 'FRIDAY · VISUAL';
  el('text', { x: 70, y: 96, class: 'holo-text', 'opacity': 0.7 }).textContent = 'READY';

  // Animated scanning band
  el('rect', { class: 'scan', x: 0, y: 0, width: 1000, height: 6 });
}

export function showReticle(x, y, label) {
  const cx = x * 1000;
  const cy = y * 600;
  const g = el('g', {});
  el('circle', { class: 'reticle', cx, cy, r: 22 }, g);
  el('line', { class: 'reticle', x1: cx - 30, y1: cy, x2: cx - 12, y2: cy }, g);
  el('line', { class: 'reticle', x1: cx + 12, y1: cy, x2: cx + 30, y2: cy }, g);
  if (label) {
    const t = el('text', { x: cx + 28, y: cy + 4, class: 'holo-text' }, g);
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
  if (r) r.textContent = text;
}
