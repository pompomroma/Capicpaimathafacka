// Cardboard-style stereoscopic split. The camera <video> is duplicated into
// a right-eye background image via a periodic frame capture, since CSS
// cannot mirror a <video> element directly.

let frameTimer = null;

export function toggle() {
  const on = !document.body.classList.contains('vr');
  setVR(on);
  return on;
}

export function setVR(on) {
  document.body.classList.toggle('vr', !!on);
  if (on) startMirror();
  else stopMirror();
}

function startMirror() {
  const stage = document.getElementById('camera-stage');
  const video = document.getElementById('camera-video');
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  function tick() {
    if (!document.body.classList.contains('vr')) return;
    if (video.readyState >= 2 && video.videoWidth) {
      c.width = video.videoWidth / 2;
      c.height = video.videoHeight / 2;
      ctx.drawImage(video, 0, 0, c.width, c.height);
      stage.style.setProperty('--vr-mirror', `url(${c.toDataURL('image/jpeg', 0.6)})`);
    }
    frameTimer = setTimeout(tick, 100);
  }
  tick();
}

function stopMirror() {
  if (frameTimer) clearTimeout(frameTimer);
  frameTimer = null;
  document.getElementById('camera-stage').style.removeProperty('--vr-mirror');
}

export function isOn() { return document.body.classList.contains('vr'); }
