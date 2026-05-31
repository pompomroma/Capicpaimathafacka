// Realistic male human-head 3D particle hologram face.
//
// Visual style matches the reference: a particle-built male head, screen-left
// rendered in cool cyan/white, screen-right dispersing into warm orange/red
// sparks, with a faint halo of stray ambient particles.
//
// The head is sampled by rejection on an implicit SDF composed of:
//   skull + jaw + nose-bridge + nose-tip + brow + upper-lip + lower-lip
//   + chin + cheekbones + ears, with eye sockets and a mouth slit carved.
//
// Animation systems (independent, additive per frame):
//   - Jaw + lip viseme driven by TTS amplitude (live lip-sync)
//   - Eye blinks on a randomized cadence (200 ms close/open cycle)
//   - Brow raise/furrow, cheek lift, mouth-corner up/down per emotion
//   - Idle: low-frequency head sway + bob, occasional gaze saccades,
//     per-point hologram jitter
//   - Dispersal particles: orange sparks drifting off the right side
//     with continuous respawn cycles, fading by life
//
// Public API (preserved):
//   init(canvas)         — boot the renderer
//   setEmotion(name)     — change target emotion
//
// Event listeners (preserved):
//   window 'friday:amp'      → number (0..1) lip-sync amplitude
//   window 'friday:emotion'  → string emotion name

// ---------- tunables ----------
const POINT_COUNT     = 5200;  // surface points forming the head
const DISPERSAL_COUNT = 480;   // orange sparks drifting off the right silhouette
const HALO_COUNT      = 260;   // ambient floaters

const EMOTIONS = ['neutral', 'focused', 'amused', 'concerned', 'alert'];

// ---------- module state ----------
let scene, camera, renderer, headGroup;
let surfacePoints, dispersalPoints, haloPoints;

let basePositions;     // Float32Array, size = POINT_COUNT*3
let posAttr;           // BufferAttribute (live positions for surface points)
let baseColors;        // Float32Array, size = POINT_COUNT*3
let pointWeights;      // Array of per-point region weight objects

let emotionDeltas;     // map emotion → Float32Array of XYZ offsets
let currentEmotion = 'neutral';
let targetEmotion  = 'neutral';
let emoBlend = 1;

let visemeAmp  = 0;
let lastT      = 0;
let blinkTimer = 2;
let blinkPhase = 0;
let saccadeT   = 0;
let saccadeX   = 0;
let saccadeY   = 0;

// dispersal
let dispPos, dispVel, dispLife, dispMaxLife, dispSrcIdx, dispColorAttr;

// halo
let haloPosAttr, haloVel;

// ---------- math helpers ----------
function ellipsoidD(x, y, z, cx, cy, cz, rx, ry, rz) {
  const dx = (x - cx) / rx;
  const dy = (y - cy) / ry;
  const dz = (z - cz) / rz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - 1;
}

function smin(a, b, k) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function rand(a, b) { return a + Math.random() * (b - a); }
function gauss() {
  // Box-Muller, clamped
  const u = Math.max(Math.random(), 1e-6);
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------- implicit head surface ----------
function headSDF(x, y, z) {
  // Skull: tall ellipsoid for the cranium
  let d = ellipsoidD(x, y, z,  0,  0.16, -0.04,  0.72, 0.95, 0.78);
  // Jaw: rounded box below
  d = smin(d, ellipsoidD(x, y, z,  0, -0.46,  0.02,  0.55, 0.5, 0.62), 0.18);
  // Nose bridge
  d = smin(d, ellipsoidD(x, y, z,  0,  0.04,  0.66,  0.075, 0.30, 0.16), 0.05);
  // Nose tip
  d = smin(d, ellipsoidD(x, y, z,  0, -0.19,  0.80,  0.10, 0.085, 0.10), 0.04);
  // Brow ridge
  d = smin(d, ellipsoidD(x, y, z,  0,  0.30,  0.56,  0.45, 0.07, 0.18), 0.06);
  // Upper lip
  d = smin(d, ellipsoidD(x, y, z,  0, -0.39,  0.62,  0.17, 0.04, 0.08), 0.03);
  // Lower lip
  d = smin(d, ellipsoidD(x, y, z,  0, -0.47,  0.60,  0.17, 0.06, 0.08), 0.03);
  // Chin
  d = smin(d, ellipsoidD(x, y, z,  0, -0.72,  0.42,  0.20, 0.19, 0.22), 0.08);
  // Cheekbones
  d = smin(d, ellipsoidD(x, y, z, -0.42, -0.12, 0.40,  0.18, 0.20, 0.20), 0.10);
  d = smin(d, ellipsoidD(x, y, z,  0.42, -0.12, 0.40,  0.18, 0.20, 0.20), 0.10);
  // Ears
  d = smin(d, ellipsoidD(x, y, z, -0.72,  0.06,-0.12,  0.08, 0.18, 0.10), 0.07);
  d = smin(d, ellipsoidD(x, y, z,  0.72,  0.06,-0.12,  0.08, 0.18, 0.10), 0.07);
  // Carve eye sockets
  const eyeL = ellipsoidD(x, y, z, -0.27, 0.12, 0.60, 0.14, 0.09, 0.10);
  const eyeR = ellipsoidD(x, y, z,  0.27, 0.12, 0.60, 0.14, 0.09, 0.10);
  d = Math.max(d, -eyeL - 0.015);
  d = Math.max(d, -eyeR - 0.015);
  // Carve mouth slit
  const mouthSlit = ellipsoidD(x, y, z, 0, -0.43, 0.65, 0.13, 0.012, 0.05);
  d = Math.max(d, -mouthSlit);
  return d;
}

// ---------- per-point region weights ----------
function classify(x, y, z) {
  // mouth proximity (used as gate for upper/lower lip + jaw + corners)
  const mDist = Math.hypot((x) / 0.28, (y + 0.43) / 0.13, (z - 0.62) / 0.16);
  const mouth = Math.max(0, 1 - mDist);
  // separate upper / lower lips
  const upper = mouth * Math.max(0, Math.min(1, (y + 0.42) / 0.06));
  const lower = mouth * Math.max(0, Math.min(1, (-(y + 0.42)) / 0.06));
  // jaw mass below mid-face (used for the jaw-drop on speak)
  const jaw = Math.max(0, Math.min(1, ((-0.3) - y) / 0.45));
  // brow region
  const bDist = Math.hypot(x / 0.45, (y - 0.30) / 0.1);
  const brow = Math.max(0, 1 - bDist);
  const browInner = brow * Math.max(0, 1 - Math.abs(x) / 0.22);
  const browOuter = brow * Math.min(1, Math.abs(x) / 0.32);
  // eyelid (upper half of eye region)
  const elD = Math.hypot((x + 0.27) / 0.17, (y - 0.12) / 0.08);
  const erD = Math.hypot((x - 0.27) / 0.17, (y - 0.12) / 0.08);
  const lidL = Math.max(0, 1 - elD) * Math.max(0, Math.min(1, (y - 0.10) / 0.08));
  const lidR = Math.max(0, 1 - erD) * Math.max(0, Math.min(1, (y - 0.10) / 0.08));
  // cheeks (for amused smile lift)
  const chL = Math.max(0, 1 - Math.hypot((x + 0.4) / 0.22, (y + 0.15) / 0.22));
  const chR = Math.max(0, 1 - Math.hypot((x - 0.4) / 0.22, (y + 0.15) / 0.22));
  // mouth corners
  const cornerL = mouth * Math.max(0, (-x - 0.07) / 0.18);
  const cornerR = mouth * Math.max(0, (x - 0.07) / 0.18);
  return { mouth, upper, lower, jaw, brow, browInner, browOuter, lidL, lidR, chL, chR, cornerL, cornerR };
}

// ---------- sample head surface ----------
function sampleHead() {
  const out = new Float32Array(POINT_COUNT * 3);
  const sizes = new Float32Array(POINT_COUNT);
  const weights = new Array(POINT_COUNT);
  let i = 0;
  const eps = 0.022; // tighter shell so the silhouette + feature edges sharpen
  let attempts = 0;
  while (i < POINT_COUNT && attempts < POINT_COUNT * 400) {
    attempts++;
    const x = rand(-0.92, 0.92);
    const y = rand(-1.05, 1.20);
    const z = rand(-0.95, 1.00);
    const d = headSDF(x, y, z);
    if (Math.abs(d) > eps) continue;
    // Bias to higher density at the front (visible features)
    if (z < 0 && Math.random() > 0.55) continue;

    // Feature-weighted acceptance: more points where eyes/nose/mouth/brow
    // live, so the same point budget concentrates on the features.
    const w = classify(x, y, z);
    const noseLike = Math.max(0, 1 - Math.hypot(x / 0.12, (y - 0.05) / 0.30, (z - 0.70) / 0.22));
    const feat = Math.max(w.mouth, w.brow, w.lidL + w.lidR, w.upperLip, w.lowerLip, noseLike);
    const accept = 0.35 + 0.65 * Math.min(1, feat);
    if (Math.random() > accept) continue;

    out[i * 3]     = x;
    out[i * 3 + 1] = y;
    out[i * 3 + 2] = z;
    weights[i] = w;
    // Per-point size: feature points larger and brighter, skin points
    // smaller so they don't bloom together under additive blending.
    sizes[i] = feat > 0.35 ? 0.030
             : feat > 0.10 ? 0.022
             :               0.012;
    i++;
  }
  while (i < POINT_COUNT) {
    out[i * 3]     = rand(-0.3, 0.3);
    out[i * 3 + 1] = rand(-0.3, 0.3);
    out[i * 3 + 2] = rand(0, 0.3);
    weights[i] = classify(out[i*3], out[i*3+1], out[i*3+2]);
    sizes[i] = 0.018;
    i++;
  }
  return { positions: out, weights, sizes };
}

// ---------- emotion delta tables ----------
function buildEmotionDeltas(base, weights) {
  const out = {};
  for (const name of EMOTIONS) {
    const arr = new Float32Array(base.length);
    for (let i = 0; i < POINT_COUNT; i++) {
      const i3 = i * 3;
      const w = weights[i];
      let dx = 0, dy = 0, dz = 0;
      switch (name) {
        case 'focused':
          // brow furrow: inner brow pinches down + inward
          dy -= 0.045 * w.browInner;
          dx -= Math.sign(base[i3]) * 0.025 * w.browInner;
          // mouth slightly tighter
          dy += 0.005 * w.upper;
          dy -= 0.005 * w.lower;
          // small forward lean of the chin
          dz += 0.01 * w.jaw;
          break;
        case 'amused':
          // mouth corners up + outward (smile)
          dy += 0.08 * w.cornerL;  dx -= 0.04 * w.cornerL;
          dy += 0.08 * w.cornerR;  dx += 0.04 * w.cornerR;
          // cheek lift
          dy += 0.05 * w.chL;
          dy += 0.05 * w.chR;
          // very slight squint from cheek lift
          dy -= 0.015 * w.lidL;
          dy -= 0.015 * w.lidR;
          // brow outer rises slightly
          dy += 0.012 * w.browOuter;
          break;
        case 'concerned':
          // brow inner up (the "worried" arch)
          dy += 0.04 * w.browInner;
          // mouth corners down
          dy -= 0.05 * w.cornerL;
          dy -= 0.05 * w.cornerR;
          // chin tucks slightly
          dy -= 0.01 * w.jaw;
          dz -= 0.008 * w.jaw;
          break;
        case 'alert':
          // brow raised
          dy += 0.05 * w.brow;
          // upper eyelid lifts (eyes wider)
          dy += 0.03 * (w.lidL + w.lidR);
          // mouth opens a touch
          dy -= 0.012 * w.lower;
          dy += 0.006 * w.upper;
          break;
        case 'neutral':
        default: break;
      }
      arr[i3] = dx; arr[i3 + 1] = dy; arr[i3 + 2] = dz;
    }
    out[name] = arr;
  }
  return out;
}

// ---------- colors ----------
function buildColors(base, weights) {
  // x-position blend: cyan/white at x<0, orange/red at x>0, smooth across center.
  const colors = new Float32Array(POINT_COUNT * 3);
  for (let i = 0; i < POINT_COUNT; i++) {
    const x = base[i * 3];
    // Blend factor: 0 at left, 1 at right, smoothstep around x=0
    const t = Math.min(1, Math.max(0, (x + 0.05) / 0.55));
    const tt = t * t * (3 - 2 * t);
    // Cyan side: bias toward white at very negative x for highlights
    const leftIntensity = Math.min(1, 0.85 + 0.25 * Math.random());
    const cyan = [0.35 * leftIntensity, 0.92 * leftIntensity, 1.0 * leftIntensity];
    const orange = [1.0, 0.45, 0.12];
    let r = cyan[0] * (1 - tt) + orange[0] * tt;
    let g = cyan[1] * (1 - tt) + orange[1] * tt;
    let b = cyan[2] * (1 - tt) + orange[2] * tt;
    // Feature-point intensity boost so lips/eyes/nose read clearly against
    // the dimmer cheek/forehead glow.
    const w = weights[i];
    const feat = Math.max(w.mouth, w.brow, w.lidL + w.lidR, w.upperLip, w.lowerLip);
    const boost = 1.0 + 0.18 * Math.min(1, feat);
    colors[i * 3]     = Math.min(1, r * boost);
    colors[i * 3 + 1] = Math.min(1, g * boost);
    colors[i * 3 + 2] = Math.min(1, b * boost);
  }
  return colors;
}

// ---------- dispersal sparks ----------
function buildDispersal(base) {
  // Pick source indices near the RIGHT-SILHOUETTE edge, well clear of the
  // central nose/eye/mouth region so orange streaks no longer cross the
  // features.
  const srcCandidates = [];
  for (let i = 0; i < POINT_COUNT; i++) {
    const x = base[i * 3];
    if (x > 0.18) srcCandidates.push({ i, w: Math.max(0.1, (x - 0.18) + 0.4) });
  }
  // Weighted sample
  const srcs = new Int32Array(DISPERSAL_COUNT);
  for (let n = 0; n < DISPERSAL_COUNT; n++) {
    const target = Math.random() * srcCandidates.reduce((a, b) => a + b.w, 0);
    let cum = 0, pick = srcCandidates[0];
    for (const c of srcCandidates) { cum += c.w; if (cum >= target) { pick = c; break; } }
    srcs[n] = pick.i;
  }
  const pos = new Float32Array(DISPERSAL_COUNT * 3);
  const vel = new Float32Array(DISPERSAL_COUNT * 3);
  const life = new Float32Array(DISPERSAL_COUNT);
  const maxLife = new Float32Array(DISPERSAL_COUNT);
  const cols = new Float32Array(DISPERSAL_COUNT * 3);
  for (let i = 0; i < DISPERSAL_COUNT; i++) {
    respawnSpark(i, srcs, base, pos, vel, life, maxLife, cols, /*initial*/ true);
  }
  return { srcs, pos, vel, life, maxLife, cols };
}

function respawnSpark(i, srcs, base, pos, vel, life, maxLife, cols, initial) {
  const s = srcs[i];
  const s3 = s * 3;
  const j = (Math.random() - 0.5) * 0.06;
  pos[i * 3]     = base[s3]     + j;
  pos[i * 3 + 1] = base[s3 + 1] + (Math.random() - 0.5) * 0.06;
  pos[i * 3 + 2] = base[s3 + 2] + (Math.random() - 0.5) * 0.06;
  // velocity: predominantly +x, with some radial outward bias from head center
  const cx = pos[i * 3];
  const cy = pos[i * 3 + 1];
  vel[i * 3]     = 0.30 + Math.random() * 0.55;
  vel[i * 3 + 1] = 0.18 * Math.sign(cy || 0.001) * Math.random() + (Math.random() - 0.5) * 0.15;
  vel[i * 3 + 2] = (Math.random() - 0.5) * 0.22;
  // life
  maxLife[i] = 0.9 + Math.random() * 1.6;
  life[i] = initial ? Math.random() * maxLife[i] : maxLife[i];
  // color (orange/red, brightness varies)
  const b = 0.7 + Math.random() * 0.4;
  cols[i * 3]     = 1.0 * b;
  cols[i * 3 + 1] = 0.45 * b;
  cols[i * 3 + 2] = 0.12 * b;
}

// ---------- halo ----------
function buildHalo() {
  const pos = new Float32Array(HALO_COUNT * 3);
  const vel = new Float32Array(HALO_COUNT * 3);
  for (let i = 0; i < HALO_COUNT; i++) {
    // Distribute outside a head-sized sphere
    let x, y, z, r2;
    do {
      x = gauss() * 1.4;
      y = gauss() * 1.4;
      z = gauss() * 0.9;
      r2 = x * x + y * y + z * z;
    } while (r2 < 1.9 || r2 > 6.5);
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    vel[i * 3]     = (Math.random() - 0.5) * 0.04;
    vel[i * 3 + 1] = (Math.random() - 0.5) * 0.03;
    vel[i * 3 + 2] = (Math.random() - 0.5) * 0.04;
  }
  return { pos, vel };
}

// ============================================================
// Renderer + animation
// ============================================================
export function init(canvas) {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(36, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 4.6);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);

  // ---- head surface ----
  const sample = sampleHead();
  basePositions = sample.positions;
  pointWeights = sample.weights;
  emotionDeltas = buildEmotionDeltas(basePositions, pointWeights);
  baseColors = buildColors(basePositions, pointWeights);

  const headGeom = new THREE.BufferGeometry();
  posAttr = new THREE.BufferAttribute(new Float32Array(basePositions), 3);
  headGeom.setAttribute('position', posAttr);
  headGeom.setAttribute('color', new THREE.BufferAttribute(baseColors, 3));
  headGeom.setAttribute('size', new THREE.BufferAttribute(sample.sizes, 1));

  // Custom shader: per-point size attribute + crisp circular sprite. Replaces
  // PointsMaterial whose uniform size + square sprites made features bloom
  // together. Feature points (larger size from sampleHead) now visibly stand
  // out from skin points (smaller), and the radial smoothstep + discard gives
  // a sharp edge instead of the fuzzy square sprite default.
  const headMat = new THREE.ShaderMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float size;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (320.0 / max(0.001, -mv.z));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float d = dot(c, c);
        if (d > 0.25) discard;
        float a = smoothstep(0.25, 0.06, d);
        gl_FragColor = vec4(vColor, a);
      }
    `,
  });
  surfacePoints = new THREE.Points(headGeom, headMat);

  headGroup = new THREE.Group();
  headGroup.add(surfacePoints);
  scene.add(headGroup);

  // ---- dispersal sparks ----
  const d = buildDispersal(basePositions);
  dispPos = d.pos; dispVel = d.vel; dispLife = d.life; dispMaxLife = d.maxLife; dispSrcIdx = d.srcs;
  const dispGeom = new THREE.BufferGeometry();
  dispGeom.setAttribute('position', new THREE.BufferAttribute(dispPos, 3));
  dispColorAttr = new THREE.BufferAttribute(d.cols, 3);
  dispGeom.setAttribute('color', dispColorAttr);
  const dispMat = new THREE.PointsMaterial({
    size: 0.028,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  dispersalPoints = new THREE.Points(dispGeom, dispMat);
  scene.add(dispersalPoints);

  // ---- halo ambient floaters ----
  const h = buildHalo();
  haloVel = h.vel;
  const haloGeom = new THREE.BufferGeometry();
  haloPosAttr = new THREE.BufferAttribute(h.pos, 3);
  haloGeom.setAttribute('position', haloPosAttr);
  const haloColors = new Float32Array(HALO_COUNT * 3);
  for (let i = 0; i < HALO_COUNT; i++) {
    // mostly cool, with a few warm ones
    const warm = Math.random() < 0.18;
    if (warm) {
      haloColors[i*3] = 1.0; haloColors[i*3+1] = 0.55; haloColors[i*3+2] = 0.18;
    } else {
      haloColors[i*3] = 0.55; haloColors[i*3+1] = 0.85; haloColors[i*3+2] = 1.0;
    }
  }
  haloGeom.setAttribute('color', new THREE.BufferAttribute(haloColors, 3));
  const haloMat = new THREE.PointsMaterial({
    size: 0.014,
    vertexColors: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  haloPoints = new THREE.Points(haloGeom, haloMat);
  scene.add(haloPoints);

  // Subtle cyan rim glow plate behind the head
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x5cf2ff, transparent: true, opacity: 0.05, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.55, 1.7, 64), ringMat);
  ring.position.z = -1.0;
  scene.add(ring);

  // events + resize
  window.addEventListener('resize', onResize);
  window.addEventListener('friday:amp', (e) => { visemeAmp = e.detail || 0; });
  window.addEventListener('friday:emotion', (e) => setEmotion(e.detail));

  lastT = performance.now();
  animate();
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

export function setEmotion(name) {
  if (!EMOTIONS.includes(name)) return;
  if (name === targetEmotion) return;
  targetEmotion = name;
  emoBlend = 0;
}

function animate() {
  const t = performance.now();
  const dt = Math.min(0.06, (t - lastT) / 1000);
  lastT = t;

  // Emotion blend toward target
  emoBlend = Math.min(1, emoBlend + dt * 1.6);
  if (emoBlend >= 1) currentEmotion = targetEmotion;
  const eCur = emotionDeltas[currentEmotion];
  const eTgt = emotionDeltas[targetEmotion];

  // Blink timing — random cadence, 180 ms close+open
  blinkTimer -= dt;
  if (blinkTimer <= 0 && blinkPhase <= 0) {
    blinkTimer = 2.4 + Math.random() * 3.6;
    blinkPhase = 1.0;
  }
  if (blinkPhase > 0) blinkPhase = Math.max(0, blinkPhase - dt * 8);
  const blinkAmt = blinkPhase > 0.5 ? (1 - (blinkPhase - 0.5) * 2) : (blinkPhase * 2); // 0→1→0 over the cycle

  // Gentle gaze saccades + idle sway
  saccadeT -= dt;
  if (saccadeT <= 0) {
    saccadeT = 1.5 + Math.random() * 3.0;
    saccadeX = (Math.random() - 0.5) * 0.05;
    saccadeY = (Math.random() - 0.5) * 0.025;
  }
  const sway = Math.sin(t * 0.00085) * 0.05;
  const bob  = Math.sin(t * 0.0011)  * 0.022;

  // Live amplitude-driven jaw drop (lip-sync)
  const amp = Math.max(0, Math.min(1.4, visemeAmp));

  // ----- update head surface positions -----
  const arr = posAttr.array;
  for (let i = 0; i < POINT_COUNT; i++) {
    const i3 = i * 3;
    const w = pointWeights[i];

    // Emotion delta (blend current → target)
    const ex = eCur[i3]     * (1 - emoBlend) + eTgt[i3]     * emoBlend;
    const ey = eCur[i3 + 1] * (1 - emoBlend) + eTgt[i3 + 1] * emoBlend;
    const ez = eCur[i3 + 2] * (1 - emoBlend) + eTgt[i3 + 2] * emoBlend;

    // Viseme: jaw drops, lower lip moves further down, upper lip rises slightly
    const vY = -amp * (0.14 * w.jaw + 0.06 * w.lower) + amp * 0.025 * w.upper;
    const vZ =  amp * 0.018 * (w.jaw + w.lower);

    // Blink: upper eyelid points drop
    const blY = -blinkAmt * 0.07 * (w.lidL + w.lidR);

    // Feature-aware hologram jitter: features stay crisp (lips, eyes, nose,
    // brow); skin keeps a subtle holographic shimmer. Without this, the
    // ±0.0035 uniform noise smeared the very edges that define the face.
    const isFeature = w.mouth > 0.25 || w.brow > 0.25
                   || w.lidL  > 0.15 || w.lidR > 0.15
                   || w.upperLip > 0.20 || w.lowerLip > 0.20;
    const jAmp = isFeature ? 0.0008 : 0.0022;
    const jx = (Math.random() - 0.5) * jAmp;
    const jy = (Math.random() - 0.5) * jAmp;
    const jz = (Math.random() - 0.5) * jAmp;

    arr[i3]     = basePositions[i3]     + ex + jx;
    arr[i3 + 1] = basePositions[i3 + 1] + ey + vY + blY + jy;
    arr[i3 + 2] = basePositions[i3 + 2] + ez + vZ + jz;
  }
  posAttr.needsUpdate = true;

  // Head rotation: idle sway + tiny saccade tilt
  headGroup.rotation.y = sway + saccadeX;
  headGroup.rotation.x = bob  + saccadeY;

  // ----- update dispersal sparks -----
  const dArr = dispersalPoints.geometry.attributes.position.array;
  const cArr = dispColorAttr.array;
  for (let i = 0; i < DISPERSAL_COUNT; i++) {
    dispLife[i] -= dt;
    if (dispLife[i] <= 0) {
      respawnSpark(i, dispSrcIdx, basePositions, dispPos, dispVel, dispLife, dispMaxLife, cArr, false);
      continue;
    }
    const i3 = i * 3;
    dispPos[i3]     += dispVel[i3]     * dt;
    dispPos[i3 + 1] += dispVel[i3 + 1] * dt;
    dispPos[i3 + 2] += dispVel[i3 + 2] * dt;
    dArr[i3]     = dispPos[i3];
    dArr[i3 + 1] = dispPos[i3 + 1];
    dArr[i3 + 2] = dispPos[i3 + 2];
    // fade brightness with life
    const f = dispLife[i] / dispMaxLife[i];
    cArr[i3]     = 1.0 * f;
    cArr[i3 + 1] = 0.45 * f;
    cArr[i3 + 2] = 0.12 * f;
  }
  dispersalPoints.geometry.attributes.position.needsUpdate = true;
  dispColorAttr.needsUpdate = true;

  // ----- halo drift (slow ambient motion) -----
  const hArr = haloPosAttr.array;
  for (let i = 0; i < HALO_COUNT; i++) {
    const i3 = i * 3;
    hArr[i3]     += haloVel[i3]     * dt;
    hArr[i3 + 1] += haloVel[i3 + 1] * dt;
    hArr[i3 + 2] += haloVel[i3 + 2] * dt;
    // wrap around when going too far
    const r2 = hArr[i3]*hArr[i3] + hArr[i3+1]*hArr[i3+1] + hArr[i3+2]*hArr[i3+2];
    if (r2 > 8) {
      hArr[i3]     *= 0.4;
      hArr[i3 + 1] *= 0.4;
      hArr[i3 + 2] *= 0.4;
    }
  }
  haloPosAttr.needsUpdate = true;

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
