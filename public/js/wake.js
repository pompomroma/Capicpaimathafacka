// Voice input pipeline (round 3).
//
// Web Speech API is the SOLE realtime source for both wake detection AND
// command capture. The recognizer is NEVER stopped during command capture,
// so a final result containing the user's command is guaranteed to deliver.
//
// Wake fires on FINAL results only (no interims), eliminating the
// same-utterance race where firing on an interim would abort the recognizer
// before the still-pending final arrived.
//
// Riva STT is kept as an OPTIONAL parallel quality upgrade: a VAD-endpointed
// MediaRecorder runs alongside Web Speech and races with it; whichever
// returns a non-empty transcript first wins. If Riva is unreachable (503
// fallback), Web Speech still wins — the user is never blocked.
//
// All key state transitions are logged with a [friday] prefix so the user
// can diagnose issues from the browser console without reading source.

import * as api from './api.js';

const LOG = (...a) => { try { console.log('[friday]', ...a); } catch {} };

// ---- wake matching ----
const WAKE_RE = /(^|\W)(hey\s+|okay\s+|ok\s+)?(friday|fri[\s-]?day|fry[\s-]?day|free\s+day|frieda|fridey|frydae|fryde|fride|priday|pry\s+day)(\W|$)/i;
const SHUTDOWN_PHRASE = 'disconnect all systems';

// ---- timing ----
const COMMAND_TIMEOUT_MS = 10000; // how long to wait for a command after bare wake
const RIVA_DEADLINE_MS   = 4000;  // give Riva up to this long; otherwise Web Speech wins

// ---- state ----
let stream = null;
let bargeAnalyser = null;
let bargeAmp = 0;
let muted = false;
let running = false;
let speaking = false;
let webspeech = null;
let recognizerActive = false;
let resumeTimer = null;
let mode = 'idle';        // 'idle' | 'listening' | 'capturing'

let pendingCommandResolver = null;
let commandTimeoutHandle = null;

const emit = (name, detail) => window.dispatchEvent(new CustomEvent('friday:' + name, { detail }));

// ---------- microphone + barge analyser ----------
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
    LOG('recognizer error:', ev.error);
    if (ev.error === 'not-allowed' || ev.error === 'audio-capture') {
      emit('status', 'mic blocked');
      running = false;
    }
  };
  r.onend = () => {
    recognizerActive = false;
    LOG('recognizer ended, mode=', mode);
    if (running && !muted && !speaking) {
      clearTimeout(resumeTimer);
      // While capturing, restart with zero delay so a follow-up command
      // is not lost during the engine cycle.
      const delay = mode === 'capturing' ? 0 : 120;
      resumeTimer = setTimeout(() => safeStartRecognizer(), delay);
    }
  };
  return r;
}

function safeStartRecognizer() {
  if (!webspeech || recognizerActive || muted || speaking || !running) return;
  try { webspeech.start(); recognizerActive = true; LOG('recognizer started'); }
  catch (_) { /* InvalidStateError if already started */ }
}

function safeStopRecognizer() {
  // Use stop() not abort() so any in-flight final results still deliver.
  if (!webspeech || !recognizerActive) return;
  try { webspeech.stop(); } catch (_) {}
  recognizerActive = false;
  LOG('recognizer stopped');
}

// Echo gating around Friday's own TTS.
window.addEventListener('friday:speaking', (e) => {
  const next = !!e.detail;
  if (next === speaking) return; // ignore duplicate events
  speaking = next;
  if (speaking) {
    LOG('TTS speaking — pausing recognizer');
    safeStopRecognizer();
  } else if (running && !muted) {
    LOG('TTS done — resuming recognizer in 350 ms');
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => safeStartRecognizer(), 350);
  }
});

// ---------- transcript routing ----------
function stripWake(text) {
  return text.replace(WAKE_RE, ' ').replace(/\s+/g, ' ').trim();
}

function deliverCommand(text) {
  if (!text) return;
  LOG('command delivered:', text);
  clearTimeout(commandTimeoutHandle);
  commandTimeoutHandle = null;
  if (pendingCommandResolver) {
    const r = pendingCommandResolver;
    pendingCommandResolver = null;
    try { r(text); } catch {}
  }
  mode = 'listening';
  emit('command', text);
}

function armCommandTimeout() {
  clearTimeout(commandTimeoutHandle);
  commandTimeoutHandle = setTimeout(() => {
    if (mode !== 'capturing') return;
    LOG('command capture timed out');
    if (pendingCommandResolver) {
      const r = pendingCommandResolver;
      pendingCommandResolver = null;
      try { r(null); } catch {}
    }
    mode = 'listening';
    emit('status', 'listening');
    emit('command-timeout');
  }, COMMAND_TIMEOUT_MS);
}

function handleTranscript(rawText, isFinal) {
  const text = rawText.toLowerCase();

  // Shutdown matches anywhere, anytime.
  if (text.includes(SHUTDOWN_PHRASE)) {
    LOG('shutdown phrase detected');
    emit('shutdown');
    return;
  }

  // While capturing, the next final wins. (Interims kept for UI feedback
  // if needed in future; for now only finals deliver.)
  if (mode === 'capturing') {
    if (!isFinal) return;
    const rest = WAKE_RE.test(text) ? stripWake(text) : text.trim();
    if (rest && rest.length >= 2) {
      deliverCommand(rest);
    }
    return;
  }

  // Wake detection — final results only to avoid the same-utterance race.
  if (mode !== 'listening') return;
  if (!isFinal) return;

  if (!WAKE_RE.test(text)) return;

  const rest = stripWake(text);
  if (rest && rest.length >= 2) {
    // Same-utterance wake + command.
    LOG('wake + same-utterance command:', rest);
    emit('wake');
    emit('command', rest);
    return;
  }

  // Bare wake — switch to capturing state and arm the timeout.
  LOG('bare wake — entering capture mode');
  emit('wake');
  mode = 'capturing';
  armCommandTimeout();
}

// ---------- VAD-endpointed MediaRecorder (Riva quality upgrade) ----------
function pickMime() {
  const opts = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const o of opts) if (window.MediaRecorder?.isTypeSupported?.(o)) return o;
  return '';
}

const VAD_HEAD = 0.04;
const VAD_SILENCE_MS = 750;
const VAD_MAX_MS = 8000;
const VAD_INITIAL_WAIT = 2500;

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
    const floorSamples = [];
    const floorStart = performance.now();

    rec.onstop = () => {
      clearInterval(pollHandle);
      const blob = new Blob(parts, { type: mime || 'audio/webm' });
      resolve(blob);
    };

    rec.start(100);

    pollHandle = setInterval(() => {
      if (muted || !running || mode !== 'capturing') {
        try { rec.stop(); } catch {}
        return;
      }
      const now = performance.now();
      if (now - floorStart < 200) {
        floorSamples.push(bargeAmp);
        return;
      }
      if (floorSamples.length) {
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

async function tryRivaInParallel() {
  // Race the MediaRecorder + Riva path against a deadline. Returns the
  // transcript string on success, null on failure / timeout / empty.
  const deadline = new Promise((resolve) => setTimeout(() => resolve(null), RIVA_DEADLINE_MS + VAD_MAX_MS));
  const work = (async () => {
    try {
      const blob = await captureViaMediaRecorder();
      if (!blob || blob.size < 1200) return null;
      const r = await Promise.race([
        api.stt(blob),
        new Promise((resolve) => setTimeout(() => resolve({ fallback: true }), RIVA_DEADLINE_MS)),
      ]);
      if (!r || r.fallback) { LOG('riva stt fallback / unavailable'); return null; }
      const text = (r.transcript || '').trim();
      if (!text) return null;
      LOG('riva stt success:', text);
      return text;
    } catch (e) {
      LOG('riva stt error', e?.message || e);
      return null;
    }
  })();
  return Promise.race([work, deadline]);
}

// ---------- public captureCommand (used by barge.js + internal wake flow) ----------
export async function captureCommand() {
  if (!running) return null;
  // Make sure the recognizer is running so the next final delivers.
  safeStartRecognizer();

  // Set capture mode synchronously so any final result that arrives during
  // this function's lifetime is routed correctly.
  mode = 'capturing';

  const webSpeechWait = new Promise((resolve) => {
    pendingCommandResolver = resolve;
  });
  armCommandTimeout();

  // Kick off Riva in parallel; treat null as "not yet".
  const rivaPromise = tryRivaInParallel();

  // First non-empty wins. We wrap both so the loser's empty result
  // does not preempt the winner.
  const winner = await new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    webSpeechWait.then((t) => { if (t) finish(t); });
    rivaPromise.then((t) => { if (t) finish(t); });
    // If both come back null, fall through to the timeout below.
    Promise.all([webSpeechWait, rivaPromise]).then(([w, r]) => finish(w || r || null));
  });

  // Clean up any unresolved resolver.
  if (pendingCommandResolver) {
    pendingCommandResolver = null;
  }
  clearTimeout(commandTimeoutHandle);
  commandTimeoutHandle = null;
  if (mode === 'capturing') mode = 'listening';
  return winner || null;
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
  LOG('voice pipeline started');
}

export function stop() {
  running = false;
  mode = 'idle';
  safeStopRecognizer();
  clearTimeout(resumeTimer);
  clearTimeout(commandTimeoutHandle);
  if (pendingCommandResolver) { try { pendingCommandResolver(null); } catch {} pendingCommandResolver = null; }
  emit('status', 'offline');
  LOG('voice pipeline stopped');
}

export function setMuted(v) {
  muted = !!v;
  if (muted) safeStopRecognizer();
  else if (running && !speaking) safeStartRecognizer();
  emit('status', muted ? 'muted' : (running ? 'listening' : 'offline'));
}

export function getMuted() { return muted; }
export function isRunning() { return running; }
