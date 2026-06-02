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

// ---- wake matching (English + Korean) ----
// English: permissive list of common ASR mistranscriptions of "Friday".
const WAKE_PATTERNS = [
  /\bfriday'?s?\b/i,
  /\bfri[\s\-]day'?s?\b/i,
  /\bfry[\s\-]?day'?s?\b/i,
  /\bfree[\s\-]?day'?s?\b/i,
  /\bfr[ie][ei]da\b/i,
  /\bfridey\b/i,
  /\bfride\b/i,
  /\bfrydae\b/i,
  /\bfryde\b/i,
  /\bpriday\b/i,
  /\bpry\s+day\b/i,
  /\bfreeway\b/i,    // sometimes Chrome hears "Friday" as "freeway"
  /\bfryday\b/i,
];
// Korean: how Korean speakers address Friday in Hangul. Web Speech in
// ko-KR mode transcribes utterances as Hangul, so these patterns target
// the Hangul forms (vocative, casual, with optional "헤이/야" prefix).
// Broadened to cover the common ASR variants Chrome's Korean engine
// actually emits.
const KO_WAKE_PATTERNS = [
  /프라이데이/,
  /프라이대이/,
  /프라이디/,
  /프라이디이/,
  /후라이데이/,
  /후라이디/,
  /파라이데이/,
  /플라이데이/,
  /프라이데/,
  /프리데이/,
  /프리이데이/,
];
function detectWake(text) {
  for (const rx of WAKE_PATTERNS) if (rx.test(text)) return true;
  for (const rx of KO_WAKE_PATTERNS) if (rx.test(text)) return true;
  return false;
}
function stripWake(text) {
  let s = text;
  for (const rx of WAKE_PATTERNS) {
    s = s.replace(new RegExp(rx.source, rx.flags + (rx.flags.includes('g') ? '' : 'g')), ' ');
  }
  for (const rx of KO_WAKE_PATTERNS) {
    s = s.replace(new RegExp(rx.source, 'g'), ' ');
  }
  // Strip optional polite prefix in either language.
  s = s.replace(/^(?:\s*(?:hey|okay|ok|yo)\W*)+/i, ' ');
  s = s.replace(/^(?:\s*(?:헤이|야|어이|저기요?)\s*[,.]?\s*)+/, ' ');
  // Drop Korean vocative particles attached after the wake word ("프라이데이야/여/님").
  s = s.replace(/^\s*[야여님씨]\s+/, ' ');
  return s.replace(/\s+/g, ' ').trim();
}
const SHUTDOWN_PHRASE = 'disconnect all systems';
const KO_SHUTDOWN_PATTERNS = [
  /모든\s*시스템\s*종료/,
  /시스템\s*종료/,
  /프라이데이\s*종료/,
  /모든\s*시스템\s*오프/,
];
function detectShutdown(text) {
  if (text.includes(SHUTDOWN_PHRASE)) return true;
  for (const rx of KO_SHUTDOWN_PATTERNS) if (rx.test(text)) return true;
  return false;
}
// Active recognizer language. Defaults to en-US; user can switch with a
// voice or text command (handled in app.js via setLanguage()).
let currentLang = 'en-US';
export function getLanguage() { return currentLang; }
export function setLanguage(lang) {
  const next = (lang === 'ko-KR' || lang === 'ko') ? 'ko-KR' : 'en-US';
  if (next === currentLang) return currentLang;
  currentLang = next;
  LOG('language switched to', currentLang);
  // Rebuild the recognizer so it picks up the new lang setting.
  try { webspeech?.abort?.(); } catch (_) {}
  recognizerActive = false;
  webspeech = makeRecognizer();
  // Defer the start by 300 ms — gives Chrome time to finish tearing down
  // the old recognizer before the new one calls start(). The watchdog
  // (1.5 s) backstops this if the immediate restart loses the race.
  clearTimeout(resumeTimer);
  if (running && !muted && !speaking) {
    resumeTimer = setTimeout(() => safeStartRecognizer(), 300);
  }
  emit('language', currentLang);
  return currentLang;
}

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
  r.lang = currentLang; // 'en-US' or 'ko-KR' — switched via setLanguage()
  r.maxAlternatives = 1;
  r.onresult = (ev) => {
    if (muted || !running) return;
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      const txt = (res[0]?.transcript || '').trim();
      if (!txt) continue;
      LOG('heard', res.isFinal ? 'FINAL' : 'interim', JSON.stringify(txt), 'mode=', mode);
      // Auto-language detection: if Hangul (Korean) shows up while we are
      // running in en-US, switch to ko-KR so subsequent utterances are
      // transcribed properly. Symmetric for the reverse direction (long
      // ASCII transcript while in ko-KR).
      const hasHangul = /[가-힯]/.test(txt);
      if (hasHangul && currentLang === 'en-US') {
        LOG('auto-switch -> ko-KR (heard Hangul)');
        setLanguage('ko-KR');
      } else if (!hasHangul && currentLang === 'ko-KR' && res.isFinal && txt.length > 4 && /^[\x00-\x7F]+$/.test(txt)) {
        LOG('auto-switch -> en-US (heard ASCII while in ko-KR)');
        setLanguage('en-US');
      }
      emit('hearing', { text: txt, final: !!res.isFinal, mode, lang: currentLang });
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

let startRetries = 0;
let watchdogHandle = null;
let speakingSince = 0; // timestamp friday:speaking went true (for stuck-state recovery)

function safeStartRecognizer() {
  if (!webspeech || recognizerActive || muted || speaking || !running) {
    startRetries = 0;
    return;
  }
  try {
    webspeech.start();
    recognizerActive = true;
    startRetries = 0;
    LOG('recognizer started');
  } catch (e) {
    // InvalidStateError can fire during the brief transitional state right
    // after onend; retry with backoff. After several misses, rebuild the
    // recognizer instance — Chrome occasionally leaves it permanently stuck.
    LOG('recognizer start failed:', e?.message || e);
    if (++startRetries < 5) {
      setTimeout(safeStartRecognizer, 250 * startRetries);
    } else {
      LOG('recognizer start gave up; rebuilding instance');
      startRetries = 0;
      try { webspeech?.abort?.(); } catch (_) {}
      webspeech = makeRecognizer();
      setTimeout(safeStartRecognizer, 500);
    }
  }
}

function safeStopRecognizer() {
  // Use stop() not abort() so any in-flight final results still deliver.
  if (!webspeech || !recognizerActive) return;
  try { webspeech.stop(); } catch (_) {}
  recognizerActive = false;
  LOG('recognizer stopped');
}

// Watchdog: every 1.5 s, if we should be listening but the recognizer is
// not running, restart it. Catches the case where onend's scheduled restart
// silently failed (e.g. start() threw InvalidStateError and the retry chain
// gave up, or the speaking flag got temporarily stuck and then cleared).
function startWatchdog() {
  if (watchdogHandle) return;
  watchdogHandle = setInterval(() => {
    if (!running) return;
    // Recover from a stuck speaking state — e.g. a TTS utterance whose end
    // event never fired (Chrome speechSynthesis bug) or a stalled audio
    // stream. Left unhandled this pauses the recognizer forever, so wake
    // stops responding. If speaking has been true longer than any plausible
    // utterance, force it clear and let the recognizer restart below.
    if (speaking && performance.now() - speakingSince > 18000) {
      LOG('watchdog: speaking stuck >18s — forcing clear');
      speaking = false;
    }
    if (muted || speaking) return;
    if (!recognizerActive) {
      LOG('watchdog: recognizer should be active — restarting');
      safeStartRecognizer();
    }
  }, 1500);
}

function stopWatchdog() {
  if (watchdogHandle) {
    clearInterval(watchdogHandle);
    watchdogHandle = null;
  }
}

// Echo gating around Friday's own TTS.
window.addEventListener('friday:speaking', (e) => {
  const next = !!e.detail;
  if (next === speaking) return; // ignore duplicate events
  speaking = next;
  if (speaking) {
    speakingSince = performance.now();
    LOG('TTS speaking — pausing recognizer');
    safeStopRecognizer();
    // Acquire the barge-in analyser stream lazily, only now that Friday is
    // speaking — never while the recognizer is the sole mic consumer.
    getMic().catch(() => {});
  } else if (running && !muted) {
    LOG('TTS done — resuming recognizer in 350 ms');
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => safeStartRecognizer(), 350);
  }
});

// ---------- transcript routing ----------
function deliverCommand(text) {
  if (!text) return;
  LOG('command delivered:', text);
  clearTimeout(commandTimeoutHandle);
  commandTimeoutHandle = null;
  clearTimeout(captureInterimTimer);
  captureInterimTimer = null;
  captureInterimBuf = '';
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
    LOG('command capture timed out — falling back to last interim if any');
    // Last-ditch: deliver whatever stable interim we have instead of giving up.
    if (captureInterimBuf && captureInterimBuf.length >= 2) {
      const txt = captureInterimBuf;
      captureInterimBuf = '';
      clearTimeout(captureInterimTimer);
      captureInterimTimer = null;
      deliverCommand(txt);
      return;
    }
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

// Stable-interim buffer for capture mode: Web Speech does not always emit
// a final result for the post-wake utterance (short commands + ambient
// noise + Chrome quirks). If an interim transcript stops changing for
// ~1.1 s we treat that as "user finished speaking" and deliver it as the
// command, instead of waiting forever for a final that may never arrive.
let captureInterimBuf = '';
let captureInterimTimer = null;
const INTERIM_STABLE_MS = 1100;

function clearCaptureInterim() {
  clearTimeout(captureInterimTimer);
  captureInterimTimer = null;
  captureInterimBuf = '';
}

function handleTranscript(rawText, isFinal) {
  const text = rawText.toLowerCase();

  // Shutdown matches anywhere, anytime (English or Korean).
  if (detectShutdown(text)) {
    LOG('shutdown phrase detected');
    emit('shutdown');
    return;
  }

  if (mode === 'capturing') {
    const rest = detectWake(text) ? stripWake(text) : text.trim();
    if (isFinal) {
      clearCaptureInterim();
      if (rest && rest.length >= 2) {
        deliverCommand(rest);
      }
      return;
    }
    // Interim — start/refresh a stability timer. If the same text persists
    // for INTERIM_STABLE_MS, deliver it. Resets every time the interim
    // changes, so we only fire when the user has clearly stopped speaking.
    if (rest && rest.length >= 2) {
      if (rest !== captureInterimBuf) {
        captureInterimBuf = rest;
        LOG('capture interim buffered:', JSON.stringify(rest));
        clearTimeout(captureInterimTimer);
        captureInterimTimer = setTimeout(() => {
          if (mode !== 'capturing' || !captureInterimBuf) return;
          LOG('delivering stable interim:', captureInterimBuf);
          const txt = captureInterimBuf;
          captureInterimBuf = '';
          captureInterimTimer = null;
          deliverCommand(txt);
        }, INTERIM_STABLE_MS);
      }
    }
    return;
  }

  if (mode !== 'listening') return;

  // Wake detection — fire on interim too for snappy UX. The mode flip to
  // 'capturing' guards against double-fires from a subsequent final of
  // the same utterance.
  if (!detectWake(text)) return;

  const rest = stripWake(text);
  if (rest && rest.length >= 2) {
    // Same-utterance wake + command. Wait for final to avoid emitting a
    // half-formed command from a partial interim.
    if (!isFinal) return;
    LOG('wake + same-utterance command:', rest);
    emit('wake');
    emit('command', rest);
    return;
  }

  // Bare wake — switch to capturing state and arm the timeout.
  LOG('bare wake (isFinal=' + isFinal + ') — entering capture mode');
  emit('wake');
  mode = 'capturing';
  clearCaptureInterim();
  armCommandTimeout();
  // Belt-and-braces: kick the recognizer in case onend fires between
  // utterances and the restart races with this handler.
  setTimeout(safeStartRecognizer, 50);
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
  // NOTE: we deliberately do NOT open a getUserMedia stream here.
  // webkitSpeechRecognition manages its own microphone capture; holding a
  // second getUserMedia stream at the same time makes some browsers starve
  // the recognizer of audio (so "Friday" is never heard). The barge-in
  // analyser stream is acquired lazily only while Friday is speaking.
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
  startWatchdog();
  LOG('voice pipeline started');
}

export function stop() {
  running = false;
  mode = 'idle';
  safeStopRecognizer();
  stopWatchdog();
  clearTimeout(resumeTimer);
  clearTimeout(commandTimeoutHandle);
  if (pendingCommandResolver) { try { pendingCommandResolver(null); } catch {} pendingCommandResolver = null; }
  emit('status', 'offline');
  LOG('voice pipeline stopped');
}

// Emergency reset hatch — call from DevTools (`window.fridayResetVoice()`)
// to forcibly rebuild the recognizer if Web Speech ever gets wedged.
if (typeof window !== 'undefined') {
  window.fridayResetVoice = () => {
    LOG('manual voice reset requested');
    speaking = false;
    try { webspeech?.abort?.(); } catch (_) {}
    recognizerActive = false;
    webspeech = makeRecognizer();
    if (running) safeStartRecognizer();
    return { running, muted, speaking, mode, recognizerActive };
  };
}

export function setMuted(v) {
  muted = !!v;
  if (muted) safeStopRecognizer();
  else if (running && !speaking) safeStartRecognizer();
  emit('status', muted ? 'muted' : (running ? 'listening' : 'offline'));
}

export function getMuted() { return muted; }
export function isRunning() { return running; }
