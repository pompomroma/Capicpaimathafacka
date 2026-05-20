const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const { requireAuth } = require('./middleware');
const { VISION_PROMPTS } = require('./prompts');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024 } });

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = process.env.VISION_MODEL || 'meta/llama-3.2-90b-vision-instruct';

router.post('/vision', requireAuth, upload.single('frame'), async (req, res) => {
  if (!process.env.NIM_KEY_VISION) return res.status(503).json({ error: 'NIM_KEY_VISION not set' });
  if (!req.file) return res.status(400).json({ error: 'frame image required' });
  const command = (req.body?.command || 'general').toLowerCase();
  const promptHead = VISION_PROMPTS[command] || VISION_PROMPTS.general;
  const userNote = (req.body?.note || '').slice(0, 500);

  const dataUrl = `data:${req.file.mimetype || 'image/jpeg'};base64,${req.file.buffer.toString('base64')}`;

  try {
    const upstream = await fetch(NIM_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.NIM_KEY_VISION}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: `${promptHead}\n\nAdditional context from user: ${userNote || 'none'}` },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0.4,
        max_tokens: 350,
        stream: false,
      }),
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return res.status(502).json({ error: `upstream ${upstream.status}`, detail: text.slice(0, 300) });
    }
    const data = await upstream.json();
    const content = data.choices?.[0]?.message?.content || '';
    res.json({ command, content });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router };
