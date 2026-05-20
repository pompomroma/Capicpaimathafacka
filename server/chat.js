const express = require('express');
const fetch = require('node-fetch');
const { q } = require('./db');
const { requireAuth } = require('./middleware');
const { SYSTEM_FRIDAY } = require('./prompts');

const router = express.Router();

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = process.env.LLM_MODEL || 'meta/llama-3.3-70b-instruct';

router.post('/chat', requireAuth, async (req, res) => {
  const { message } = req.body || {};
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message required' });
  if (!process.env.NIM_KEY_REASONING) return res.status(503).json({ error: 'NIM_KEY_REASONING not set' });

  q.addMessage.run(req.user.id, 'user', message, Date.now());

  const recent = q.recentMessages.all(req.user.id, 20).reverse();
  const history = recent.map(r => ({ role: r.role, content: r.content }));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let upstream;
  try {
    upstream = await fetch(NIM_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.NIM_KEY_REASONING}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: SYSTEM_FRIDAY }, ...history],
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 512,
        stream: true,
      }),
    });
  } catch (e) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`);
    return res.end();
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    res.write(`event: error\ndata: ${JSON.stringify({ error: `upstream ${upstream.status}: ${text.slice(0, 200)}` })}\n\n`);
    return res.end();
  }

  let full = '';
  let buffer = '';
  upstream.body.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') {
        res.write('event: done\ndata: {}\n\n');
        continue;
      }
      try {
        const j = JSON.parse(payload);
        const delta = j.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          res.write(`data: ${JSON.stringify({ delta })}\n\n`);
        }
      } catch { /* ignore */ }
    }
  });

  upstream.body.on('end', () => {
    if (full) q.addMessage.run(req.user.id, 'assistant', full, Date.now());
    res.end();
  });

  upstream.body.on('error', (err) => {
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  });

  req.on('close', () => { try { upstream.body.destroy(); } catch {} });
});

router.get('/history/chat', requireAuth, (req, res) => {
  const rows = q.recentMessages.all(req.user.id, 100).reverse();
  res.json({ messages: rows });
});

module.exports = { router };
