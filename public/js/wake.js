import * as api from './api.js';

const WAKE_WORDS = ['friday', 'frid', 'fryday'];
const SHUTDOWN_PHRASE = 'disconnect all systems';

let stream = null;
let muted = false;
let running = false;
let mode = 'idle'; // idle | listening | command
let recorder = null;
let chunks = [];
let webspeech = null;
let bargeAnalyser = null;
let bargeAmp = 0;
let useFallback = false;

const emit = (name, detail) => window.dispatchEvent(new CustomEvent('friday:' + name, { detail }));

async function getMic() {
  if (stream) return stream;
  stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  // Barge-in analyser
  const actx = new (window.AudioContext || window.webkitAudioContext)();
  const src = actx.createMediaStreamSource(stream);
  bargeAnalyser = actx.createAnalyser();
  bargeAnalyser.fftSize = 512;
  src.connect(bargeAnalyser);
  const buf = new Uint8Array(bargeAnalyser.frequencyBinCount);
  setInterval(() => {
    if (muted) { bargeAmp = 0; return; }
    bargeAnalyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
    bargeAmp = Math.sqrt(sum / buf.length);
  }, 50);
  return stream;
}

export function getMicAmp() { return bargeAmp; }

function pickMime() {
  const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const o of opts) if (window.MediaRecorder?.isTypeSupported?.(o)) return o;
  return '';
}

async function recordOnce(ms) {
  await getMic();
  return new Promise((resolve) => {
    const mime = pickMime();
    const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    recorder = rec;
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data?.size) parts.push(e.data); };
    rec.onstop = () => {
      const blob = new Blob(parts, { type: mime || 'audio/webm' });
      resolve(blob);
    };
    rec.start();
    setTimeout(() => { try { rec.state !== 'inactive' && rec.stop(); } catch {} }, ms);
  });
}

async function transcribe(blob) {
  if (useFallback) return null;
  try {
    const r = await api.stt(blob);
    if (r?.fallback) { useFallback = true; startWebSpeech(); return null; }
    return (r?.transcript || '').toLowerCase().trim();
  } catch { useFallback = true; startWebSpeech(); return null; }
}

function startWebSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { emit('status', 'speech recognition unavailable'); return; }
  if (webspeech) try { webspeech.stop(); } catch {}
  const r = new SR();
  r.continuous = true; r.interimResults = true; r.lang = 'en-US';
  let buffer = '';
  r.onresult = (ev) => {
    if (muted || !running) return;
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const txt = ev.results[i][0].transcript.toLowerCase().trim();
      if (ev.results[i].isFinal) {
        handleTranscript(txt, true);
        buffer = '';
      } else {
        buffer = txt;
      }
    }
  };
  r.onerror = () => {};
  r.onend = () => { if (running && useFallback) try { r.start(); } catch {} };
  try { r.start(); } catch {}
  webspeech = r;
}

function handleTranscript(text, final) {
  if (!text) return;
  const lower = text.toLowerCase();
  if (lower.includes(SHUTDOWN_PHRASE)) {
    emit('shutdown');
    return;
  }
  if (mode === 'listening' && WAKE_WORDS.some(w => lower.includes(w))) {
    // strip wake word; remainder may be the command in the same utterance
    let rest = lower;
    for (const w of WAKE_WORDS) rest = rest.replace(new RegExp('\\b' + w + '\\b', 'g'), '');
    rest = rest.trim();
    if (rest) emit('command', rest);
    else { mode = 'command'; emit('wake'); }
    return;
  }
  if (mode === 'command' && final) {
    emit('command', lower);
    mode = 'listening';
    return;
  }
  // Always interpret final utterances after wake even without exact substring
  if (mode === 'listening' && final && /\b(friday|fred|fri)\b/.test(lower)) {
    emit('wake');
    mode = 'command';
  }
}

async function loop() {
  while (running) {
    if (muted || useFallback) { await sleep(200); continue; }
    try {
      const blob = await recordOnce(2200);
      if (!running) break;
      const txt = await transcribe(blob);
      if (txt) handleTranscript(txt, true);
    } catch (e) { await sleep(300); }
    await sleep(150);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export async function start() {
  if (running) return;
  running = true; mode = 'listening';
  emit('status', 'listening');
  try { await getMic(); } catch (e) { emit('status', 'mic denied'); running = false; return; }
  if (useFallback) startWebSpeech(); else loop();
}

export function stop() {
  running = false; mode = 'idle';
  try { recorder?.stop(); } catch {}
  try { webspeech?.stop(); } catch {}
  emit('status', 'offline');
}

export function setMuted(v) { muted = !!v; emit('status', v ? 'muted' : 'listening'); }
export function getMuted() { return muted; }
export function isRunning() { return running; }
export function setCommandMode() { mode = 'command'; }
export function setListeningMode() { mode = 'listening'; }
export function getMode() { return mode; }

// Forced one-shot capture (used after barge-in)
export async function captureCommand(ms = 3500) {
  if (useFallback) return null;
  const blob = await recordOnce(ms);
  const txt = await transcribe(blob);
  return txt || null;
}
