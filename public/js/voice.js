// TTS output. Riva (server-side) preferred; Web Speech API as fallback.
// Locked to American English: en-US lang + best-available US voice +
// natural cadence + text normalization for cleaner pronunciation.

import * as api from './api.js';

const audioEl = document.getElementById('tts-audio');

let actx = null;
let analyser = null;
let lastAmp = 0;
let useFallback = false;
let pickedVoice = null;
let warmedUp = false;

// ---------- Web Audio analyser for lip-sync ----------
function ensureCtx() {
  if (actx) return;
  actx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = actx.createAnalyser();
  analyser.fftSize = 256;
  const srcNode = actx.createMediaElementSource(audioEl);
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

// ---------- voice picker ----------
const PREFERRED_VOICES = [
  /^Google US English$/i,
  /Microsoft Aria.*United States/i,
  /Microsoft Jenny.*United States/i,
  /Microsoft Guy.*United States/i,
  /^Samantha$/i,
  /^Allison$/i,
  /^Ava$/i,
];

function pickBestVoice() {
  const voices = (window.speechSynthesis?.getVoices?.() || []).filter(Boolean);
  if (!voices.length) return null;
  for (const rx of PREFERRED_VOICES) {
    const v = voices.find((vv) => rx.test(vv.name));
    if (v) return v;
  }
  const usExact = voices.find((v) => v.lang === 'en-US');
  if (usExact) return usExact;
  const anyEn = voices.find((v) => /^en[-_]/i.test(v.lang));
  return anyEn || voices[0];
}

function refreshVoice() {
  const v = pickBestVoice();
  if (v && v !== pickedVoice) {
    pickedVoice = v;
    try { console.log('[voice] using', v.name, v.lang); } catch {}
  }
}

if (typeof window !== 'undefined' && window.speechSynthesis) {
  refreshVoice();
  try { window.speechSynthesis.onvoiceschanged = refreshVoice; } catch {}
}

// ---------- one-time warm-up on first user gesture ----------
function warmUp() {
  if (warmedUp) return;
  warmedUp = true;
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.lang = 'en-US';
    u.volume = 0;
    window.speechSynthesis.speak(u);
  } catch {}
  // Resume an AudioContext that was suspended due to autoplay policy.
  try { actx?.resume?.(); } catch {}
}
if (typeof window !== 'undefined') {
  const onFirstGesture = () => {
    warmUp();
    window.removeEventListener('click', onFirstGesture);
    window.removeEventListener('keydown', onFirstGesture);
    window.removeEventListener('touchstart', onFirstGesture);
  };
  window.addEventListener('click', onFirstGesture);
  window.addEventListener('keydown', onFirstGesture);
  window.addEventListener('touchstart', onFirstGesture);
}

// ---------- text normalization ----------
const ACRONYMS = {
  AI: 'A.I.', API: 'A.P.I.', URL: 'U.R.L.', UI: 'U.I.', UX: 'U.X.',
  TTS: 'T.T.S.', STT: 'S.T.T.', HUD: 'H.U.D.', VR: 'V.R.', AR: 'A.R.',
  LLM: 'L.L.M.', CPU: 'C.P.U.', GPU: 'G.P.U.', RAM: 'R.A.M.', SSD: 'S.S.D.',
  USB: 'U.S.B.', PDF: 'P.D.F.', HTML: 'H.T.M.L.', CSS: 'C.S.S.',
  JS: 'JavaScript', SQL: 'S.Q.L.', JSON: 'jay-son', HTTP: 'H.T.T.P.',
  HTTPS: 'H.T.T.P.S.', NIM: 'N.I.M.',
};

function normalizeForSpeech(text) {
  if (!text) return '';
  let s = String(text);
  // Strip emotion tag.
  s = s.replace(/\[\[emotion:[a-z]+\]\]/ig, '');
  // Strip markdown emphasis and inline code.
  s = s.replace(/```[\s\S]*?```/g, ' ');                  // code blocks → drop
  s = s.replace(/`([^`]+)`/g, '$1');                       // inline code → text
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');                 // bold
  s = s.replace(/(?<!\*)\*(?!\*)([^*]+)\*(?!\*)/g, '$1');  // italic
  s = s.replace(/^[ \t]*[-*•]\s+/gm, '');                  // list bullets
  s = s.replace(/^#{1,6}\s+/gm, '');                       // markdown headings
  // Punctuation normalization.
  s = s.replace(/[—–]/g, ', ');
  s = s.replace(/\.{3,}/g, ', ');
  s = s.replace(/\s+&\s+/g, ' and ');
  // Acronyms — whole-word only.
  s = s.replace(/\b([A-Z]{2,5})\b/g, (m) => ACRONYMS[m] || m);
  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function dispatchEmotion(text) {
  const m = text.match(/\[\[emotion:([a-z]+)\]\]/i);
  if (m) window.dispatchEvent(new CustomEvent('friday:emotion', { detail: m[1].toLowerCase() }));
}

// ---------- Web Speech speak (sentence queue) ----------
function splitSentences(text) {
  // Keep punctuation with the sentence; split on . ! ? followed by space/newline.
  const out = [];
  const re = /[^.!?\n]+[.!?]?(?:\s+|$)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const seg = m[0].trim();
    if (seg) out.push(seg);
  }
  return out.length ? out : [text];
}

function speakSentenceWebSpeech(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) { resolve(); return; }
    if (!pickedVoice) refreshVoice();
    let done = false;
    // Chrome's speechSynthesis sometimes never fires onend (a long-standing
    // engine bug). Without a guard the speak queue hangs forever, which keeps
    // friday:speaking=true and leaves the wake recognizer permanently paused.
    // Force-resolve after an estimated max duration (~100 ms/char + 2 s,
    // capped at 30 s) and cancel the stuck utterance.
    const estMs = Math.min(30000, 2000 + text.length * 100);
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try { window.speechSynthesis.cancel(); } catch {}
      finish();
    }, estMs);
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      if (pickedVoice) u.voice = pickedVoice;
      u.rate = 0.98;
      u.pitch = 1.0;
      u.volume = 1.0;
      u.onend = finish;
      u.onerror = finish;
      window.speechSynthesis.speak(u);
    } catch { finish(); }
  });
}

function speakFallback(text) {
  return new Promise(async (resolve) => {
    try { window.speechSynthesis?.cancel?.(); } catch {}
    window.dispatchEvent(new CustomEvent('friday:speaking', { detail: true }));
    // Synthetic amplitude loop for lip-sync since Web Speech audio is not
    // exposed via Web Audio.
    let synthRunning = true;
    const start = performance.now();
    const fakeLoop = () => {
      if (!synthRunning) { lastAmp *= 0.85; return; }
      const t = (performance.now() - start) / 180;
      lastAmp = 0.32 + 0.28 * Math.abs(Math.sin(t)) + 0.12 * Math.random();
      window.dispatchEvent(new CustomEvent('friday:amp', { detail: lastAmp }));
      requestAnimationFrame(fakeLoop);
    };
    fakeLoop();
    const sentences = splitSentences(text);
    for (const s of sentences) {
      await speakSentenceWebSpeech(s);
    }
    synthRunning = false;
    window.dispatchEvent(new CustomEvent('friday:speaking', { detail: false }));
    resolve();
  });
}

// ---------- public speak (streaming-friendly queue) ----------
//
// speakChunk(text) appends to a FIFO queue and starts a single drain
// loop that plays each chunk through Riva (or Web Speech fallback) in
// order. This lets the chat reply start being spoken as soon as the
// first sentence streams in, instead of waiting for the full reply.
//
// speak(text) keeps the original "speak this whole thing and resolve
// when done" semantics by enqueuing then awaiting the drain.

const speakQueue = [];
let drainPromise = null;

async function speakOnce(clean) {
  // The actual single-utterance play path. `clean` is already passed
  // through normalizeForSpeech by the caller (speakChunk).
  ensureCtx();
  if (useFallback) return speakFallback(clean);
  try {
    const res = await api.tts(clean);
    if (res?.fallback) { useFallback = true; return speakFallback(clean); }
    return await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(safety);
        window.dispatchEvent(new CustomEvent('friday:speaking', { detail: false }));
        resolve();
      };
      // Absolute safety cap so a stalled audio stream can never hang the
      // queue and leave friday:speaking=true (which would pause the
      // wake recognizer indefinitely).
      const safety = setTimeout(finish, 60000);
      audioEl.src = res.url;
      audioEl.onended = finish;
      audioEl.onerror = finish;
      audioEl.play()
        .then(() => window.dispatchEvent(new CustomEvent('friday:speaking', { detail: true })))
        .catch(() => { clearTimeout(safety); useFallback = true; speakFallback(clean).then(finish); });
    });
  } catch (e) {
    useFallback = true;
    return speakFallback(clean);
  }
}

function startDraining() {
  if (drainPromise) return drainPromise;
  drainPromise = (async () => {
    try {
      while (speakQueue.length) {
        const next = speakQueue.shift();
        try { await speakOnce(next); } catch (_) {}
      }
    } finally {
      drainPromise = null;
    }
  })();
  return drainPromise;
}

// Append a chunk (sentence, partial reply, etc.) to the speech queue.
// Safe to call repeatedly as deltas arrive from a streaming chat reply.
export function speakChunk(rawText) {
  if (!rawText) return;
  dispatchEmotion(rawText);
  const clean = normalizeForSpeech(rawText);
  if (!clean) return;
  speakQueue.push(clean);
  startDraining();
}

// Original "speak whole thing" API — equivalent to speakChunk + await
// queue drain. Kept so existing call sites (camera analyze, shutdown
// acknowledgement, etc.) work without changes.
export async function speak(rawText) {
  speakChunk(rawText);
  if (drainPromise) await drainPromise;
}

export function stopSpeaking() {
  // Drop any pending chunks so a barge-in doesn't get followed by the
  // tail of the previous reply.
  speakQueue.length = 0;
  try { audioEl.pause(); audioEl.currentTime = 0; } catch {}
  try { window.speechSynthesis?.cancel?.(); } catch {}
  window.dispatchEvent(new CustomEvent('friday:speaking', { detail: false }));
}

export function isSpeaking() {
  return (audioEl && !audioEl.paused) || !!(window.speechSynthesis && window.speechSynthesis.speaking) || speakQueue.length > 0;
}

export function setFallback(v) { useFallback = !!v; }
