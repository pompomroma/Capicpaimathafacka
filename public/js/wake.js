// Voice input pipeline.
//
// Primary listener: Web Speech API (continuous, interim results, en-US).
//   - Cheap, low-latency, runs entirely in the browser.
//   - Used for wake-word detection AND fallback command transcription.
// On wake: open a VAD-endpointed MediaRecorder, ship to /api/stt for high-
//   quality Riva transcription. If Riva is unavailable, fall back to the
//   next Web Speech `isFinal` result.
// Echo gating: pause Web Speech while Friday is speaking (so the mic does
//   not re-capture TTS output and trigger itself).

import * as api from './api.js';

// ---- wake matching ----
// Be permissive: ASR commonly mistranscribes "Friday" as one of these.
const WAKE_RE = /(^|\W)(hey\s+|okay\s+|ok\s+)?(friday|fri[\s-]?day|fry[\s-]?day|free\s+day|frieda|fridey|frydae|fryde|fride|priday|pry\s+day)(\W|$)/i;
const SHUTDOWN_PHRASE = 'disconnect all systems';

// ---- state ----
let stream = null;
let bargeAnalyser = null;
let bargeAmp = 0;
let muted = false;
let running = false;
let speaking = false;        // gated by friday:speaking events
let webspeech = null;
let recognizerActive = false; // whether Web Speech is currently started
let resumeTimer = null;
let mode = 'idle';            // 'idle' | 'listening' | 'capturing'

// While capturing, we want the next Web Speech final result to be treated
// as the command (fallback path).
let pendingCommandResolver = null;

const emit = (name, detail) => window.dispatchEvent(new CustomEvent('friday:' + name, { detail }));

// ---------- microphone ----------
async function getMic() {
  if (stream) return stream;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
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
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    bargeAmp = Math.sqrt(sum / buf.length);
  }, 50);
  return stream;
}

export function getMicAmp() { return bargeAmp; }

// ---------- Web Speech recognizer ----------
function makeRecognizer() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.lang = 'en-US';
  r.maxAlternatives = 1;
  r.onresult = (ev) => {
    if (muted || !running) return;
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      const txt = (res[0]?.transcript || '').trim();
      if (!txt) continue;
      handleTranscript(txt, !!res.isFinal);
    }
  };
  r.onerror = (ev) => {
    // 'no-speech', 'audio-capture', 'not-allowed', 'aborted', ...
    if (ev.error === 'not-allowed' || ev.error === 'audio-capture') {
      emit('status', 'mic blocked');
      running = false;
    }
  };
  r.onend = () => {
    recognizerActive = false;
    if (running && !muted && !speaking) {
      // Browsers stop the recognizer every ~1 minute. Restart with backoff.
      clearTimeout(resumeTimer);
      resumeTimer = setTimeout(() => safeStartRecognizer(), 150);
    }
  };
  return r;
}

function safeStartRecognizer() {
  if (!webspeech || recognizerActive || muted || speaking || !running) return;
  try { webspeech.start(); recognizerActive = true; }
  catch (_) { /* InvalidStateError if already started */ }
}

function safeStopRecognizer() {
  if (!webspeech || !recognizerActive) return;
  try { webspeech.abort(); } catch (_) {}
  recognizerActive = false;
}

// Echo gating: pause/resume around Friday's own speech.
window.addEventListener('friday:speaking', (e) => {
  speaking = !!e.detail;
  if (speaking) {
    safeStopRecognizer();
  } else if (running && !muted) {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => safeStartRecognizer(), 350); // tail bleed
  }
});

// ---------- transcript routing ----------
function stripWake(text) {
  // Remove the wake-word match and any leading polite prefix, return the rest.
  return text.replace(WAKE_RE, ' ').replace(/\s+/g, ' ').trim();
}

function handleTranscript(rawText, isFinal) {
  const text = rawText.toLowerCase();

  // Shutdown — works in any mode.
  if (text.includes(SHUTDOWN_PHRASE)) {
    emit('shutdown');
    return;
  }

  // If we're waiting for a command (Riva unavailable path), forward the
  // next final result to the pending resolver.
  if (mode === 'capturing' && pendingCommandResolver && isFinal) {
    const rest = WAKE_RE.test(text) ? stripWake(text) : text.trim();
    if (rest) {
      const r = pendingCommandResolver;
      pendingCommandResolver = null;
      r(rest);
      return;
    }
  }

  if (mode !== 'listening') return;
  if (!isFinal && !WAKE_RE.test(text)) return; // wait for wake or final

  if (WAKE_RE.test(text)) {
    const rest = stripWake(text);
    if (rest && rest.split(' ').length >= 1 && rest.length >= 2) {
      // wake + command in one breath
      emit('wake');
      emit('command', rest);
    } else {
      // bare wake — start command capture
      emit('wake');
      mode = 'capturing';
      captureCommand().then((cmd) => {
        mode = 'listening';
        if (cmd) emit('command', cmd);
      });
    }
  }
}

// ---------- VAD-endpointed command capture ----------
function pickMime() {
  const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const o of opts) if (window.MediaRecorder?.isTypeSupported?.(o)) return o;
  return '';
}

const VAD_HEAD = 0.04;      // headroom above noise floor to count as speech
const VAD_SILENCE_MS = 750; // how long of quiet before we end the utterance
const VAD_MAX_MS = 8000;    // hard ceiling on a single command
const VAD_INITIAL_WAIT = 2500; // how long to wait for speech to start

async function captureViaMediaRecorder() {
  await getMic();
  const mime = pickMime();
  const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data?.size) parts.push(e.data); };

  return new Promise((resolve) => {
    let started = false;
    let lastVoiced = 0;
    let startWallclock = performance.now();
    let pollHandle = null;
    let initialFloor = bargeAmp || 0.02;
    // Snapshot a fresh noise floor over 200 ms.
    const floorSamples = [];
    const floorStart = performance.now();

    rec.onstop = () => {
      clearInterval(pollHandle);
      const blob = new Blob(parts, { type: mime || 'audio/webm' });
      resolve(blob);
    };

    rec.start(100); // 100 ms timeslices

    pollHandle = setInterval(() => {
      if (muted || !running) { try { rec.stop(); } catch {} return; }
      const now = performance.now();
      if (now - floorStart < 200) {
        floorSamples.push(bargeAmp);
        return;
      }
      if (floorSamples.length) {
        // Use the median as the noise floor.
        floorSamples.sort((a, b) => a - b);
        initialFloor = Math.max(0.005, floorSamples[Math.floor(floorSamples.length / 2)]);
        floorSamples.length = 0;
      }
      const threshold = initialFloor + VAD_HEAD;
      if (bargeAmp > threshold) {
        if (!started) { started = true; startWallclock = now; }
        lastVoiced = now;
      }
      if (started && now - lastVoiced > VAD_SILENCE_MS) { try { rec.stop(); } catch {} return; }
      if (started && now - startWallclock > VAD_MAX_MS) { try { rec.stop(); } catch {} return; }
      if (!started && now - startWallclock > VAD_INITIAL_WAIT) { try { rec.stop(); } catch {} return; }
    }, 50);
  });
}

async function captureViaWebSpeech() {
  return new Promise((resolve) => {
    pendingCommandResolver = resolve;
    setTimeout(() => {
      if (pendingCommandResolver === resolve) {
        pendingCommandResolver = null;
        resolve(null);
      }
    }, 6500);
  });
}

// VAD-endpointed capture + Riva transcription. Public for barge.js.
export async function captureCommand() {
  if (!running) return null;
  // Pause Web Speech so it does not race the MediaRecorder for the mic.
  safeStopRecognizer();
  try {
    const blob = await captureViaMediaRecorder();
    let transcript = '';
    if (blob && blob.size > 1200) {
      try {
        const r = await api.stt(blob);
        if (r && !r.fallback) transcript = (r.transcript || '').trim();
      } catch (_) { /* fall through to webspeech */ }
    }
    if (!transcript) {
      // Resume recognizer and wait for the next final utterance.
      safeStartRecognizer();
      transcript = (await captureViaWebSpeech()) || '';
    }
    return transcript || null;
  } finally {
    // Always make sure the recognizer is running again.
    setTimeout(() => safeStartRecognizer(), 250);
  }
}

// ---------- lifecycle ----------
export async function start() {
  if (running) return;
  try { await getMic(); }
  catch (e) { emit('status', 'mic denied'); return; }
  running = true;
  mode = 'listening';
  emit('status', 'listening');
  if (!webspeech) webspeech = makeRecognizer();
  if (!webspeech) {
    emit('status', 'speech recognition unavailable');
    running = false;
    return;
  }
  safeStartRecognizer();
}

export function stop() {
  running = false;
  mode = 'idle';
  safeStopRecognizer();
  clearTimeout(resumeTimer);
  if (pendingCommandResolver) { try { pendingCommandResolver(null); } catch {} pendingCommandResolver = null; }
  emit('status', 'offline');
}

export function setMuted(v) {
  muted = !!v;
  if (muted) safeStopRecognizer();
  else if (running && !speaking) safeStartRecognizer();
  emit('status', muted ? 'muted' : (running ? 'listening' : 'offline'));
}

export function getMuted() { return muted; }
export function isRunning() { return running; }
