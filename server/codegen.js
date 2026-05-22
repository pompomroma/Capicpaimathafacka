const express = require('express');
const fetch = require('node-fetch');
const { q } = require('./db');
const { requireAuth } = require('./middleware');
const { CODEGEN_SYSTEM } = require('./prompts');

const router = express.Router();

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = process.env.CODEGEN_MODEL || 'qwen/qwen3-coder-480b-a35b-instruct';

function extractJson(s) {
  if (!s) return null;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) s = fenced[1];
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

async function callModel(goal) {
  const r = await fetch(NIM_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.NIM_KEY_CODEGEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: CODEGEN_SYSTEM },
        { role: 'user', content: `Build the following. Return JSON only.\n\nGoal: ${goal}` },
      ],
      temperature: 0.3,
      max_tokens: 4096,
      stream: false,
    }),
  });
  if (!r.ok) throw new Error(`upstream ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content || '';
}

router.post('/codegen', requireAuth, async (req, res) => {
  if (!process.env.NIM_KEY_CODEGEN) return res.status(503).json({ error: 'NIM_KEY_CODEGEN not set' });
  const goal = (req.body?.goal || '').toString().trim();
  if (!goal || goal.length < 4) return res.status(400).json({ error: 'goal required' });

  try {
    let raw = await callModel(goal);
    let parsed = extractJson(raw);
    if (!parsed?.files?.length) {
      raw = await callModel(goal + '\n\nReturn only the JSON object. No prose.');
      parsed = extractJson(raw);
    }
    if (!parsed?.files?.length) return res.status(502).json({ error: 'model returned no parseable files', raw: raw.slice(0, 400) });

    parsed.files = parsed.files
      .filter(f => f && typeof f.path === 'string' && typeof f.content === 'string')
      .slice(0, 12)
      .map(f => ({ path: f.path.replace(/^\/+/, ''), content: f.content }));
    if (!parsed.entry) parsed.entry = parsed.files.find(f => /index\.html$/i.test(f.path))?.path || parsed.files[0].path;

    q.addCreation.run(req.user.id, goal, JSON.stringify(parsed), Date.now());
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/history/creations', requireAuth, (req, res) => {
  const rows = q.recentCreations.all(req.user.id, 50).map(r => ({
    id: r.id, goal: r.goal, ts: r.ts,
  }));
  res.json({ creations: rows });
});

router.get('/creation/:id', requireAuth, (req, res) => {
  const row = q.creationById.get(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  try { res.json({ id: row.id, goal: row.goal, ts: row.ts, ...JSON.parse(row.files_json) }); }
  catch { res.status(500).json({ error: 'corrupt record' }); }
});

module.exports = { router };
