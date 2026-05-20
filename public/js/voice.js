import * as api from './api.js';

const audioEl = document.getElementById('tts-audio');

let actx = null;
let analyser = null;
let srcNode = null;
let lastAmp = 0;
let useFallback = false;

function ensureCtx() {
  if (actx) return;
  actx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = actx.createAnalyser();
  analyser.fftSize = 256;
  srcNode = actx.createMediaElementSource(audioEl);
  srcNode.connect(analyser);
  analyser.connect(actx.destination);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  function loop() {
    if (!audioEl.paused) {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      lastAmp = Math.min(1, Math.sqrt(sum / buf.length) * 2.5);
    } else {
      lastAmp *= 0.85;
    }
    window.dispatchEvent(new CustomEvent('friday:amp', { detail: lastAmp }));
    requestAnimationFrame(loop);
  }
  loop();
}

function stripEmotion(text) {
  const m = text.match(/\[\[emotion:([a-z]+)\]\]/i);
  if (m) {
    window.dispatchEvent(new CustomEvent('friday:emotion', { detail: m[1].toLowerCase() }));
    return text.replace(m[0], '').trim();
  }
  return text;
}

function speakFallback(text) {
  return new Promise((resolve) => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05; u.pitch = 1.05;
      u.onstart = () => window.dispatchEvent(new CustomEvent('friday:speaking', { detail: true }));
      u.onend = () => { window.dispatchEvent(new CustomEvent('friday:speaking', { detail: false })); resolve(); };
      u.onerror = () => { window.dispatchEvent(new CustomEvent('friday:speaking', { detail: false })); resolve(); };
      // synthetic amp loop
      const start = performance.now();
      const fakeLoop = () => {
        if (!speechSynthesis.speaking) { lastAmp *= 0.85; return; }
        const t = (performance.now() - start) / 200;
        lastAmp = 0.35 + 0.25 * Math.abs(Math.sin(t)) + 0.15 * Math.random();
        window.dispatchEvent(new CustomEvent('friday:amp', { detail: lastAmp }));
        requestAnimationFrame(fakeLoop);
      };
      fakeLoop();
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
    } catch (e) { resolve(); }
  });
}

export async function speak(text) {
  const clean = stripEmotion(text);
  if (!clean) return;
  ensureCtx();
  if (useFallback) return speakFallback(clean);
  try {
    const res = await api.tts(clean);
    if (res.fallback) { useFallback = true; return speakFallback(clean); }
    return await new Promise((resolve) => {
      audioEl.src = res.url;
      audioEl.onended = () => { window.dispatchEvent(new CustomEvent('friday:speaking', { detail: false })); resolve(); };
      audioEl.onerror = () => { window.dispatchEvent(new CustomEvent('friday:speaking', { detail: false })); resolve(); };
      audioEl.play()
        .then(() => window.dispatchEvent(new CustomEvent('friday:speaking', { detail: true })))
        .catch(() => { useFallback = true; speakFallback(clean).then(resolve); });
    });
  } catch (e) {
    useFallback = true;
    return speakFallback(clean);
  }
}

export function stopSpeaking() {
  try { audioEl.pause(); audioEl.currentTime = 0; } catch {}
  try { speechSynthesis.cancel(); } catch {}
  window.dispatchEvent(new CustomEvent('friday:speaking', { detail: false }));
}

export function isSpeaking() {
  return (audioEl && !audioEl.paused) || (window.speechSynthesis && speechSynthesis.speaking);
}

export function setFallback(v) { useFallback = !!v; }
