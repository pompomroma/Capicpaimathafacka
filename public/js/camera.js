import * as api from './api.js';
import * as hud from './hud.js';

const stage = document.getElementById('camera-stage');
const video = document.getElementById('camera-video');
let stream = null;
let active = false;

export function isActive() { return active; }

export async function enter() {
  if (active) return;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
  } catch (e) {
    window.dispatchEvent(new CustomEvent('friday:status', { detail: 'camera denied' }));
    return false;
  }
  stage.hidden = false;
  active = true;
  document.body.classList.add('camera');
  hud.buildBaseHud();
  hud.setReadout('Vision module engaged. Awaiting command — try "analyze product" or "open google".');
  return true;
}

export function exit() {
  if (!active) return;
  active = false;
  stage.hidden = true;
  document.body.classList.remove('camera');
  hud.clearReticles();
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  video.srcObject = null;
  document.body.classList.remove('vr');
}

export function captureFrame() {
  if (!active) throw new Error('camera not active');
  const w = video.videoWidth || 1280;
  const h = video.videoHeight || 720;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(video, 0, 0, w, h);
  return new Promise((resolve) => c.toBlob(b => resolve(b), 'image/jpeg', 0.85));
}

export async function analyze(command, note = '') {
  if (!active) { await enter(); }
  hud.setReadout(`Scanning… (${command})`);
  hud.showReticle(0.5, 0.5, command.toUpperCase());
  try {
    const blob = await captureFrame();
    const res = await api.vision(blob, command, note);
    hud.setReadout(res.content || '(no response)');
    // Stick a small reticle off-center as visual marker
    hud.showReticle(0.32 + Math.random() * 0.36, 0.3 + Math.random() * 0.4, command);
    return res.content;
  } catch (e) {
    hud.setReadout('Scan failed: ' + e.message);
    return null;
  }
}
