const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { requireAuth } = require('./middleware');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const TTS_URL = process.env.TTS_URL || 'https://ai.api.nvidia.com/v1/speech/synthesis';
const STT_URL = process.env.STT_URL || 'https://ai.api.nvidia.com/v1/speech/transcription';
// English (default).
const TTS_MODEL = process.env.TTS_MODEL || 'nvidia/fastpitch-hifigan-en-us';
const STT_MODEL = process.env.STT_MODEL || 'nvidia/parakeet-ctc-1.1b';
const TTS_VOICE = process.env.TTS_VOICE || 'English-US.Female-1';
// Korean (env-overridable). Both default to Riva ko-KR identifiers; the
// route falls back to web-speech if upstream does not have the model.
const KO_TTS_MODEL = process.env.KO_TTS_MODEL || 'nvidia/fastpitch-hifigan-ko-kr';
const KO_TTS_VOICE = process.env.KO_TTS_VOICE || 'Korean-KR.Female-1';
const KO_STT_MODEL = process.env.KO_STT_MODEL || 'nvidia/parakeet-ctc-1.1b';

function pickTtsConfig(lang) {
  if (lang === 'ko-KR' || lang === 'ko') {
    return { model: KO_TTS_MODEL, voice: KO_TTS_VOICE, language: 'ko-KR' };
  }
  return { model: TTS_MODEL, voice: TTS_VOICE, language: 'en-US' };
}

router.post('/tts', requireAuth, async (req, res) => {
  if (!process.env.NIM_KEY_REASONING) return res.status(503).json({ fallback: 'webspeech', error: 'NIM_KEY_REASONING not set' });
  const text = (req.body?.text || '').toString().slice(0, 1500);
  if (!text) return res.status(400).json({ error: 'text required' });
  // Per-request language: explicit lang param, or auto-detect Hangul.
  const reqLang = (req.body?.lang || '').toString();
  const autoLang = /[가-힯]/.test(text) ? 'ko-KR' : 'en-US';
  const lang = reqLang || autoLang;
  const cfg = pickTtsConfig(lang);

  try {
    const upstream = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.NIM_KEY_REASONING}`,
        'Content-Type': 'application/json',
        Accept: 'audio/wav',
      },
      body: JSON.stringify({ model: cfg.model, text, voice: cfg.voice, language: cfg.language, encoding: 'wav', sample_rate: 22050 }),
    });
    if (!upstream.ok) {
      const detail = (await upstream.text().catch(() => '')).slice(0, 200);
      return res.status(503).json({ fallback: 'webspeech', error: `upstream ${upstream.status}`, detail });
    }
    res.setHeader('Content-Type', 'audio/wav');
    upstream.body.pipe(res);
  } catch (e) {
    res.status(503).json({ fallback: 'webspeech', error: e.message });
  }
});

router.post('/stt', requireAuth, upload.single('audio'), async (req, res) => {
  if (!process.env.NIM_KEY_REASONING) return res.status(503).json({ fallback: 'webspeech', error: 'NIM_KEY_REASONING not set' });
  if (!req.file) return res.status(400).json({ error: 'audio required' });
  // Per-request language for STT; defaults to en-US.
  const reqLang = (req.body?.lang || '').toString();
  const isKo = reqLang === 'ko-KR' || reqLang === 'ko';
  try {
    const fd = new FormData();
    fd.append('audio', req.file.buffer, { filename: 'clip.webm', contentType: req.file.mimetype || 'audio/webm' });
    fd.append('model', isKo ? KO_STT_MODEL : STT_MODEL);
    fd.append('language', isKo ? 'ko-KR' : 'en-US');
    const upstream = await fetch(STT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.NIM_KEY_REASONING}`, ...fd.getHeaders() },
      body: fd,
    });
    if (!upstream.ok) {
      const detail = (await upstream.text().catch(() => '')).slice(0, 200);
      return res.status(503).json({ fallback: 'webspeech', error: `upstream ${upstream.status}`, detail });
    }
    const j = await upstream.json().catch(() => ({}));
    const transcript = j.transcript || j.text || j.results?.[0]?.alternatives?.[0]?.transcript || '';
    res.json({ transcript });
  } catch (e) {
    res.status(503).json({ fallback: 'webspeech', error: e.message });
  }
});

module.exports = { router };
