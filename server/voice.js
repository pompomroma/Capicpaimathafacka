const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { requireAuth } = require('./middleware');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const TTS_URL = process.env.TTS_URL || 'https://ai.api.nvidia.com/v1/speech/synthesis';
const STT_URL = process.env.STT_URL || 'https://ai.api.nvidia.com/v1/speech/transcription';
const TTS_MODEL = process.env.TTS_MODEL || 'nvidia/fastpitch-hifigan-en-us';
const STT_MODEL = process.env.STT_MODEL || 'nvidia/parakeet-ctc-1.1b';
const TTS_VOICE = process.env.TTS_VOICE || 'English-US.Female-1';

router.post('/tts', requireAuth, async (req, res) => {
  if (!process.env.NIM_KEY_REASONING) return res.status(503).json({ fallback: 'webspeech', error: 'NIM_KEY_REASONING not set' });
  const text = (req.body?.text || '').toString().slice(0, 1500);
  if (!text) return res.status(400).json({ error: 'text required' });

  try {
    const upstream = await fetch(TTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.NIM_KEY_REASONING}`,
        'Content-Type': 'application/json',
        Accept: 'audio/wav',
      },
      body: JSON.stringify({ model: TTS_MODEL, text, voice: TTS_VOICE, encoding: 'wav', sample_rate: 22050 }),
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
  try {
    const fd = new FormData();
    fd.append('audio', req.file.buffer, { filename: 'clip.webm', contentType: req.file.mimetype || 'audio/webm' });
    fd.append('model', STT_MODEL);
    fd.append('language', 'en-US');
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
