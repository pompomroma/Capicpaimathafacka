// Single continuous hologram HEAD MESH (replaces the old particle cloud).
//
// The previous version rendered the head as ~5000 additive point sprites;
// overlapping sprites blurred the mouth/eyes/nose no matter how they were
// tuned. This version renders the head as ONE watertight surface mesh, so
// features read as crisp continuous forms, while the mouth and eyes still
// animate by deforming the mesh vertices.
//
// Shape: the mesh is built by ray-marching the exact same implicit head
// SDF used before (skull + jaw + nose + brow + lips + chin + cheekbones +
// ears, with eye sockets and a mouth slit carved out), so the face profile
// is unchanged — only the rendering technique changed.
//
// Look: a holographic ShaderMaterial — cyan→orange left-to-right gradient,
// fresnel rim glow (edges + forms glow brightest), horizontal scanlines,
// additive blending on a double-sided surface for a volumetric hologram.
//
// Animation (unchanged behaviour, now on mesh vertices):
//   - Live lip-sync: jaw + lower lip drop driven by TTS amplitude
//   - Eye blinks on a randomized cadence
//   - Emotion morphs (neutral/focused/amused/concerned/alert)
//   - Idle head sway + gaze saccades
//
// Public API (preserved): init(canvas), setEmotion(name).
// Events (preserved): window 'friday:amp' (0..1), 'friday:emotion' (string).

const LON = 128;  // sphere longitude segments (mesh resolution around)
const LAT = 96;   // sphere latitude segments (mesh resolution top-bottom)

const EMOTIONS = ['neutral', 'focused', 'amused', 'concerned', 'alert'];

// ---------- module state ----------
let scene, camera, renderer, headGroup, mesh, geom, posAttr, normAttr;
let basePositions;   // Float32Array, the rest-pose vertex positions
let vertexWeights;   // per-vertex region-weight objects (from classify)
let emotionDeltas;   // map emotion -> Float32Array XYZ offsets
let uniforms;        // shader uniforms (uTime)

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

// ---------- implicit head surface (identical shape to the particle version) ----------
function headSDF(x, y, z) {
  let d = ellipsoidD(x, y, z,  0,  0.16, -0.04,  0.72, 0.95, 0.78);   // skull
  d = smin(d, ellipsoidD(x, y, z,  0, -0.46,  0.02,  0.55, 0.5, 0.62), 0.18); // jaw
  d = smin(d, ellipsoidD(x, y, z,  0,  0.04,  0.66,  0.075, 0.30, 0.16), 0.05); // nose bridge
  d = smin(d, ellipsoidD(x, y, z,  0, -0.19,  0.80,  0.10, 0.085, 0.10), 0.04); // nose tip
  d = smin(d, ellipsoidD(x, y, z,  0,  0.30,  0.56,  0.45, 0.07, 0.18), 0.06); // brow ridge
  d = smin(d, ellipsoidD(x, y, z,  0, -0.39,  0.62,  0.17, 0.04, 0.08), 0.03); // upper lip
  d = smin(d, ellipsoidD(x, y, z,  0, -0.47,  0.60,  0.17, 0.06, 0.08), 0.03); // lower lip
  d = smin(d, ellipsoidD(x, y, z,  0, -0.72,  0.42,  0.20, 0.19, 0.22), 0.08); // chin
  d = smin(d, ellipsoidD(x, y, z, -0.42, -0.12, 0.40,  0.18, 0.20, 0.20), 0.10); // cheekbone L
  d = smin(d, ellipsoidD(x, y, z,  0.42, -0.12, 0.40,  0.18, 0.20, 0.20), 0.10); // cheekbone R
  d = smin(d, ellipsoidD(x, y, z, -0.72,  0.06,-0.12,  0.08, 0.18, 0.10), 0.07); // ear L
  d = smin(d, ellipsoidD(x, y, z,  0.72,  0.06,-0.12,  0.08, 0.18, 0.10), 0.07); // ear R
  const eyeL = ellipsoidD(x, y, z, -0.27, 0.12, 0.60, 0.14, 0.09, 0.10);
  const eyeR = ellipsoidD(x, y, z,  0.27, 0.12, 0.60, 0.14, 0.09, 0.10);
  d = Math.max(d, -eyeL - 0.015);  // carve eye sockets
  d = Math.max(d, -eyeR - 0.015);
  const mouthSlit = ellipsoidD(x, y, z, 0, -0.43, 0.65, 0.13, 0.012, 0.05);
  d = Math.max(d, -mouthSlit);     // carve mouth slit
  return d;
}

// ---------- per-vertex region weights (identical to particle version) ----------
function classify(x, y, z) {
  const mDist = Math.hypot((x) / 0.28, (y + 0.43) / 0.13, (z - 0.62) / 0.16);
  const mouth = Math.max(0, 1 - mDist);
  const upper = mouth * Math.max(0, Math.min(1, (y + 0.42) / 0.06));
  const lower = mouth * Math.max(0, Math.min(1, (-(y + 0.42)) / 0.06));
  const jaw = Math.max(0, Math.min(1, ((-0.3) - y) / 0.45));
  const bDist = Math.hypot(x / 0.45, (y - 0.30) / 0.1);
  const brow = Math.max(0, 1 - bDist);
  const browInner = brow * Math.max(0, 1 - Math.abs(x) / 0.22);
  const browOuter = brow * Math.min(1, Math.abs(x) / 0.32);
  const elD = Math.hypot((x + 0.27) / 0.17, (y - 0.12) / 0.08);
  const erD = Math.hypot((x - 0.27) / 0.17, (y - 0.12) / 0.08);
  const lidL = Math.max(0, 1 - elD) * Math.max(0, Math.min(1, (y - 0.10) / 0.08));
  const lidR = Math.max(0, 1 - erD) * Math.max(0, Math.min(1, (y - 0.10) / 0.08));
  const chL = Math.max(0, 1 - Math.hypot((x + 0.4) / 0.22, (y + 0.15) / 0.22));
  const chR = Math.max(0, 1 - Math.hypot((x - 0.4) / 0.22, (y + 0.15) / 0.22));
  const cornerL = mouth * Math.max(0, (-x - 0.07) / 0.18);
  const cornerR = mouth * Math.max(0, (x - 0.07) / 0.18);
  return { mouth, upper, lower, jaw, brow, browInner, browOuter, lidL, lidR, chL, chR, cornerL, cornerR };
}

// ---------- emotion delta tables (per-vertex offsets) ----------
function buildEmotionDeltas(base, weights) {
  const n = weights.length;
  const out = {};
  for (const name of EMOTIONS) {
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      const w = weights[i];
      let dx = 0, dy = 0, dz = 0;
      switch (name) {
        case 'focused':
          dy -= 0.045 * w.browInner;
          dx -= Math.sign(base[i3]) * 0.025 * w.browInner;
          dy += 0.005 * w.upper;
          dy -= 0.005 * w.lower;
          dz += 0.01 * w.jaw;
          break;
        case 'amused':
          dy += 0.08 * w.cornerL;  dx -= 0.04 * w.cornerL;
          dy += 0.08 * w.cornerR;  dx += 0.04 * w.cornerR;
          dy += 0.05 * w.chL;
          dy += 0.05 * w.chR;
          dy -= 0.015 * w.lidL;
          dy -= 0.015 * w.lidR;
          dy += 0.012 * w.browOuter;
          break;
        case 'concerned':
          dy += 0.04 * w.browInner;
          dy -= 0.05 * w.cornerL;
          dy -= 0.05 * w.cornerR;
          dy -= 0.01 * w.jaw;
          dz -= 0.008 * w.jaw;
          break;
        case 'alert':
          dy += 0.05 * w.brow;
          dy += 0.03 * (w.lidL + w.lidR);
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

// ---------- ray-march the SDF surface along a direction from an interior point ----------
const HEAD_CENTER = [0, -0.05, 0.05]; // a point safely inside the head mass
function surfaceT(dx, dy, dz) {
  const [cx, cy, cz] = HEAD_CENTER;
  const step = 0.03, maxT = 2.4;
  let tPrev = 0;
  // headSDF at the interior center is negative; march outward to the first
  // sign change (negative -> positive), then bisect for precision.
  for (let t = step; t <= maxT; t += step) {
    const d = headSDF(cx + dx * t, cy + dy * t, cz + dz * t);
    if (d >= 0) {
      let lo = tPrev, hi = t;
      for (let k = 0; k < 9; k++) {
        const mid = (lo + hi) * 0.5;
        const dm = headSDF(cx + dx * mid, cy + dy * mid, cz + dz * mid);
        if (dm < 0) lo = mid; else hi = mid;
      }
      return (lo + hi) * 0.5;
    }
    tPrev = t;
  }
  return maxT;
}

// ---------- build the head mesh geometry ----------
function buildHeadGeometry() {
  // Start from a UV sphere; each vertex direction is ray-marched onto the
  // head SDF surface, turning the sphere into the head shape while keeping
  // the sphere's triangle topology (watertight, no seams to manage).
  const sphere = new THREE.SphereGeometry(1, LON, LAT);
  const sp = sphere.attributes.position;
  const n = sp.count;
  const base = new Float32Array(n * 3);
  const weights = new Array(n);
  const [cx, cy, cz] = HEAD_CENTER;

  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    // sphere vertex is already unit-length => use it as the ray direction
    let dx = sp.array[i3], dy = sp.array[i3 + 1], dz = sp.array[i3 + 2];
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    const t = surfaceT(dx, dy, dz);
    const x = cx + dx * t, y = cy + dy * t, z = cz + dz * t;
    base[i3] = x; base[i3 + 1] = y; base[i3 + 2] = z;
    weights[i] = classify(x, y, z);
  }

  sphere.setAttribute('position', new THREE.BufferAttribute(new Float32Array(base), 3));
  sphere.computeVertexNormals();
  return { geometry: sphere, base, weights };
}

// ============================================================
// Renderer + animation
// ============================================================
export function init(canvas) {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(34, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 4.4);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);

  const built = buildHeadGeometry();
  geom = built.geometry;
  basePositions = built.base;
  vertexWeights = built.weights;
  emotionDeltas = buildEmotionDeltas(basePositions, vertexWeights);
  posAttr = geom.attributes.position;
  normAttr = geom.attributes.normal;

  uniforms = { uTime: { value: 0 } };

  // Holographic surface shader.
  const headMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms,
    vertexShader: `
      varying vec3 vViewPos;
      varying vec3 vNormalV;
      varying float vX;
      varying float vWorldY;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        vNormalV = normalize(normalMatrix * normal);
        vX = position.x;
        vWorldY = (modelMatrix * vec4(position, 1.0)).y;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      precision mediump float;
      uniform float uTime;
      varying vec3 vViewPos;
      varying vec3 vNormalV;
      varying float vX;
      varying float vWorldY;
      void main() {
        vec3 V = normalize(-vViewPos);
        vec3 N = normalize(vNormalV);
        // Fresnel rim — forms and silhouette glow brightest, giving the
        // hologram its volume and making features read as bright contours.
        float rim = pow(1.0 - abs(dot(N, V)), 2.0);
        // Left-to-right cyan -> orange gradient (matches the reference).
        float gx = smoothstep(-0.22, 0.5, vX);
        vec3 cyan = vec3(0.30, 0.85, 1.0);
        vec3 orange = vec3(1.0, 0.45, 0.12);
        vec3 col = mix(cyan, orange, gx);
        // Horizontal scanlines for the holographic shimmer.
        float scan = 0.82 + 0.18 * sin(vWorldY * 130.0 - uTime * 4.0);
        // Body fill is faint; rim dominates.
        float a = (0.05 + rim * 0.95) * scan;
        col *= (0.45 + rim * 1.4) * scan;
        gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
      }
    `,
  });

  mesh = new THREE.Mesh(geom, headMat);
  headGroup = new THREE.Group();
  headGroup.add(mesh);
  scene.add(headGroup);

  // Faint cyan glow ring behind the head for ambiance.
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x5cf2ff, transparent: true, opacity: 0.05, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(new THREE.RingGeometry(1.5, 1.66, 64), ringMat);
  ring.position.z = -1.1;
  scene.add(ring);

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
  uniforms.uTime.value = t * 0.001;

  // Emotion blend toward target
  emoBlend = Math.min(1, emoBlend + dt * 1.6);
  if (emoBlend >= 1) currentEmotion = targetEmotion;
  const eCur = emotionDeltas[currentEmotion];
  const eTgt = emotionDeltas[targetEmotion];

  // Blink timing — random cadence, quick close+open
  blinkTimer -= dt;
  if (blinkTimer <= 0 && blinkPhase <= 0) {
    blinkTimer = 2.4 + Math.random() * 3.6;
    blinkPhase = 1.0;
  }
  if (blinkPhase > 0) blinkPhase = Math.max(0, blinkPhase - dt * 8);
  const blinkAmt = blinkPhase > 0.5 ? (1 - (blinkPhase - 0.5) * 2) : (blinkPhase * 2);

  // Gaze saccades + idle sway
  saccadeT -= dt;
  if (saccadeT <= 0) {
    saccadeT = 1.5 + Math.random() * 3.0;
    saccadeX = (Math.random() - 0.5) * 0.05;
    saccadeY = (Math.random() - 0.5) * 0.025;
  }
  const sway = Math.sin(t * 0.00085) * 0.05;
  const bob  = Math.sin(t * 0.0011)  * 0.022;

  const amp = Math.max(0, Math.min(1.4, visemeAmp));

  // Deform mesh vertices: emotion morph + viseme (jaw/lip) + blink.
  const arr = posAttr.array;
  const n = vertexWeights.length;
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const w = vertexWeights[i];

    const ex = eCur[i3]     * (1 - emoBlend) + eTgt[i3]     * emoBlend;
    const ey = eCur[i3 + 1] * (1 - emoBlend) + eTgt[i3 + 1] * emoBlend;
    const ez = eCur[i3 + 2] * (1 - emoBlend) + eTgt[i3 + 2] * emoBlend;

    // Viseme: jaw + lower lip drop, upper lip rises slightly (lip-sync)
    const vY = -amp * (0.14 * w.jaw + 0.06 * w.lower) + amp * 0.025 * w.upper;
    const vZ =  amp * 0.018 * (w.jaw + w.lower);

    // Blink: upper eyelid drops
    const blY = -blinkAmt * 0.07 * (w.lidL + w.lidR);

    arr[i3]     = basePositions[i3]     + ex;
    arr[i3 + 1] = basePositions[i3 + 1] + ey + vY + blY;
    arr[i3 + 2] = basePositions[i3 + 2] + ez + vZ;
  }
  posAttr.needsUpdate = true;
  // Recompute normals so the fresnel rim follows the deforming mouth/eyes.
  geom.computeVertexNormals();
  normAttr.needsUpdate = true;

  // Idle head motion
  headGroup.rotation.y = sway + saccadeX;
  headGroup.rotation.x = bob  + saccadeY;

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
