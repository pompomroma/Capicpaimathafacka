// 3D particle hologram face. Three.js Points with procedurally generated
// base, emotion, and viseme positions. Lip-sync from TTS amplitude.

const POINT_COUNT = 2800;

const EMOTIONS = ['neutral', 'focused', 'amused', 'concerned', 'alert'];

let scene, camera, renderer, points, geometry, baseGeom;
let posAttr, basePositions, emotionTargets, visemeTargets;
let currentEmotion = 'neutral';
let targetEmotion = 'neutral';
let emoBlend = 0;
let visemeAmp = 0;
let lastT = 0;

const tmpV = { x: 0, y: 0, z: 0 };

function rand(a, b) { return a + Math.random() * (b - a); }

// Implicit face SDF — combine a head ellipsoid, two eye sockets, a nose,
// and a mouth slit. We sample points by accepting random candidates near the
// surface.
function sampleFace(seed) {
  // Returns Float32Array of size POINT_COUNT*3
  const out = new Float32Array(POINT_COUNT * 3);
  let i = 0;
  let attempts = 0;
  while (i < POINT_COUNT * 3 && attempts < POINT_COUNT * 60) {
    attempts++;
    const x = rand(-1.1, 1.1);
    const y = rand(-1.5, 1.4);
    const z = rand(-0.7, 0.9);
    // Head ellipsoid
    const head = (x * x) / (1.0 * 1.0) + (y * y) / (1.25 * 1.25) + (z * z) / (0.85 * 0.85) - 1.0;
    if (Math.abs(head) > 0.05) continue;
    // Carve features
    // eyes
    const eyeL = Math.hypot(x + 0.42, (y - 0.25) * 1.3, (z - 0.55) * 1.2);
    const eyeR = Math.hypot(x - 0.42, (y - 0.25) * 1.3, (z - 0.55) * 1.2);
    if (eyeL < 0.22 || eyeR < 0.22) continue;
    // mouth slit
    if (Math.abs(y + 0.6) < 0.07 && Math.abs(x) < 0.45 && z > 0.2) continue;
    out[i++] = x; out[i++] = y; out[i++] = z;
  }
  // fill any remaining slots
  while (i < out.length) { out[i++] = rand(-0.5, 0.5); out[i++] = rand(-0.5, 0.5); out[i++] = rand(-0.5, 0.5); }
  return out;
}

// Build delta offsets per emotion (small global deformations).
function buildEmotionTargets(base) {
  const targets = {};
  for (const name of EMOTIONS) {
    const arr = new Float32Array(base.length);
    for (let i = 0; i < base.length; i += 3) {
      const x = base[i], y = base[i + 1], z = base[i + 2];
      let dx = 0, dy = 0, dz = 0;
      switch (name) {
        case 'focused':
          // narrow brows: pull points above eyes downward a hair
          if (y > 0.5 && Math.abs(x) < 0.6) dy -= 0.04;
          // slight forward tilt
          dz += 0.02 * (y * 0.5);
          break;
        case 'amused':
          // raise corners of mouth
          if (y < -0.45 && y > -0.85 && Math.abs(x) > 0.2 && Math.abs(x) < 0.55) {
            dy += 0.07 * (Math.abs(x) - 0.2);
          }
          // slight cheek lift
          if (y < -0.1 && y > -0.5 && Math.abs(x) > 0.3) dy += 0.025;
          break;
        case 'concerned':
          // brows arch inward
          if (y > 0.45 && Math.abs(x) < 0.45) { dy -= 0.05; dx -= Math.sign(x) * 0.04; }
          // mouth corners down
          if (y < -0.5 && Math.abs(x) > 0.25 && Math.abs(x) < 0.55) dy -= 0.05;
          break;
        case 'alert':
          // eyes wider — push surrounding points outward
          if (Math.abs(y - 0.25) < 0.2 && Math.abs(x) > 0.25 && Math.abs(x) < 0.65) {
            dx += Math.sign(x) * 0.025;
            dy += 0.02;
          }
          break;
        case 'neutral':
        default: break;
      }
      arr[i] = dx; arr[i + 1] = dy; arr[i + 2] = dz;
    }
    targets[name] = arr;
  }
  return targets;
}

// Build viseme target — open mouth deformation.
function buildVisemeTarget(base) {
  const arr = new Float32Array(base.length);
  for (let i = 0; i < base.length; i += 3) {
    const x = base[i], y = base[i + 1], z = base[i + 2];
    // Affect mouth region only
    if (y < -0.45 && y > -0.85 && Math.abs(x) < 0.5 && z > 0.1) {
      const closeness = 1 - Math.hypot((x) / 0.5, (y + 0.65) / 0.25);
      if (closeness > 0) {
        arr[i] = 0;
        arr[i + 1] = -0.16 * closeness; // lower jaw drops
        arr[i + 2] = -0.04 * closeness;
      }
    }
    // tiny global breath
    arr[i + 2] += 0.005 * Math.sin(y * 4);
  }
  return arr;
}

export function init(canvas) {
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 4.2);
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);

  basePositions = sampleFace();
  emotionTargets = buildEmotionTargets(basePositions);
  visemeTargets = buildVisemeTarget(basePositions);

  geometry = new THREE.BufferGeometry();
  posAttr = new THREE.BufferAttribute(new Float32Array(basePositions), 3);
  geometry.setAttribute('position', posAttr);

  // Subtle color variation per point
  const colors = new Float32Array(POINT_COUNT * 3);
  for (let i = 0; i < POINT_COUNT; i++) {
    const t = Math.random();
    colors[i * 3] = 0.36 * t;
    colors[i * 3 + 1] = 0.95;
    colors[i * 3 + 2] = 1.0;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.PointsMaterial({
    size: 0.025,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  points = new THREE.Points(geometry, material);
  scene.add(points);

  // Glow halo behind face
  const haloGeom = new THREE.RingGeometry(1.4, 1.55, 64);
  const haloMat = new THREE.MeshBasicMaterial({ color: 0x5cf2ff, transparent: true, opacity: 0.08, side: THREE.DoubleSide });
  const halo = new THREE.Mesh(haloGeom, haloMat);
  halo.position.z = -0.8;
  scene.add(halo);

  window.addEventListener('resize', onResize);
  window.addEventListener('friday:amp', (e) => { visemeAmp = e.detail || 0; });
  window.addEventListener('friday:emotion', (e) => {
    if (EMOTIONS.includes(e.detail)) {
      targetEmotion = e.detail;
      emoBlend = 0;
    }
  });

  lastT = performance.now();
  animate();
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
  const t = performance.now();
  const dt = Math.min(0.08, (t - lastT) / 1000);
  lastT = t;

  emoBlend = Math.min(1, emoBlend + dt * 1.6);
  if (emoBlend >= 1) currentEmotion = targetEmotion;

  const arr = posAttr.array;
  const eCur = emotionTargets[currentEmotion];
  const eTgt = emotionTargets[targetEmotion];
  const vAmp = Math.max(0, Math.min(1.4, visemeAmp));

  // Slow rotation + idle sway
  const sway = Math.sin(t * 0.001) * 0.05;
  points.rotation.y = sway;
  points.rotation.x = Math.sin(t * 0.0007) * 0.03;

  for (let i = 0; i < basePositions.length; i++) {
    const eDelta = eCur[i] * (1 - emoBlend) + eTgt[i] * emoBlend;
    const vDelta = visemeTargets[i] * vAmp;
    const jitter = (Math.random() - 0.5) * 0.0035;
    arr[i] = basePositions[i] + eDelta + vDelta + jitter;
  }
  posAttr.needsUpdate = true;

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

export function setEmotion(name) {
  if (EMOTIONS.includes(name)) { targetEmotion = name; emoBlend = 0; }
}
