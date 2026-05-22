const express = require('express');
const fetch = require('node-fetch');
const { q } = require('./db');
const { requireAuth } = require('./middleware');
const { CODEGEN_SYSTEM } = require('./prompts');

const router = express.Router();

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = process.env.CODEGEN_MODEL || 'qwen/qwen3-coder-480b-a35b-instruct';

// ---------- Parsers ----------

// New: delimited-block format produced by the updated CODEGEN_SYSTEM
// prompt. Far more robust than JSON because file content does not need
// any escaping — long source files with quotes, backslashes and
// newlines just pass through verbatim.
function parseBlocks(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.replace(/\r\n/g, '\n');
  const fileRe = /=== FILE:\s*([^=\n]+?)\s*===\n([\s\S]*?)\n=== END FILE ===/g;
  const files = [];
  let m;
  while ((m = fileRe.exec(text)) !== null) {
    const path = m[1].trim().replace(/^\/+/, '').replace(/\.\.\//g, '');
    const content = m[2];
    if (path) files.push({ path, content });
  }
  if (!files.length) return null;
  const pick = (label) => {
    const re = new RegExp('=== ' + label + ':\\s*([^=\\n]+?)\\s*===');
    const mm = text.match(re);
    return mm ? mm[1].trim() : '';
  };
  return {
    files,
    entry: pick('ENTRY'),
    stack: pick('STACK'),
    run:   pick('RUN'),
    notes: pick('NOTES'),
  };
}

// Backward-compat: previous prompt asked for a JSON envelope. If a model
// still returns that shape, accept it.
function extractJson(s) {
  if (!s) return null;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) s = fenced[1];
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

// ---------- Model call ----------

async function callModel(goal, retryHint) {
  const baseMsg = `Build the following.\n\nGoal: ${goal}`;
  const userMsg = retryHint
    ? `${baseMsg}\n\n${retryHint}`
    : baseMsg;
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
        { role: 'user', content: userMsg },
      ],
      temperature: 0.2,
      top_p: 0.9,
      max_tokens: 16384,
      stream: false,
    }),
  });
  if (!r.ok) throw new Error(`upstream ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return j.choices?.[0]?.message?.content || '';
}

// ---------- Helpers ----------

function pickEntry(files, explicit) {
  if (explicit && files.some(f => f.path === explicit)) return explicit;
  const preferences = [
    /^index\.html$/i,
    /^main\.py$/i,
    /^index\.js$/i,
    /^app\.py$/i,
    /^main\.go$/i,
    /^src\/main\.rs$/i,
    /^src\/index\.js$/i,
    /package\.json$/i,
    /^Cargo\.toml$/i,
  ];
  for (const re of preferences) {
    const hit = files.find(f => re.test(f.path));
    if (hit) return hit.path;
  }
  return files[0].path;
}

// ---------- Route ----------

router.post('/codegen', requireAuth, async (req, res) => {
  if (!process.env.NIM_KEY_CODEGEN) return res.status(503).json({ error: 'NIM_KEY_CODEGEN not set' });
  const goal = (req.body?.goal || '').toString().trim();
  if (!goal || goal.length < 4) return res.status(400).json({ error: 'goal required' });

  let raw = '';
  try {
    raw = await callModel(goal);
    let parsed = parseBlocks(raw) || extractJson(raw);

    if (!parsed?.files?.length) {
      // Retry with a stronger format reminder.
      raw = await callModel(
        goal,
        'Your previous output had no parseable FILE blocks. Use the exact === FILE: <path> === / === END FILE === format from the system prompt. Do not use markdown code fences. Do not wrap the result in JSON. Output only the blocks plus the trailing ENTRY/STACK/RUN/NOTES markers.',
      );
      parsed = parseBlocks(raw) || extractJson(raw);
    }

    if (!parsed?.files?.length) {
      return res.status(502).json({
        error: 'model returned no parseable files',
        raw: raw.slice(0, 600),
      });
    }

    // Sanitize files
    parsed.files = parsed.files
      .filter(f => f && typeof f.path === 'string' && typeof f.content === 'string' && f.content.trim().length > 0)
      .slice(0, 16)
      .map(f => ({
        path: f.path.replace(/^\/+/, '').replace(/\.\.\//g, '').slice(0, 200),
        content: f.content.slice(0, 64 * 1024),
      }));

    if (!parsed.files.length) {
      return res.status(502).json({
        error: 'model emitted only empty files',
        raw: raw.slice(0, 600),
      });
    }

    parsed.entry = pickEntry(parsed.files, parsed.entry);

    // Persist (used by history)
    q.addCreation.run(req.user.id, goal, JSON.stringify(parsed), Date.now());
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message, raw: raw.slice(0, 400) });
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
