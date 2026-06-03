const express = require('express');
const fetch = require('node-fetch');
const { q } = require('./db');
const { requireAuth } = require('./middleware');
const { SYSTEM_FRIDAY } = require('./prompts');

const router = express.Router();

const NIM_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const CHAT_MODEL = process.env.LLM_MODEL || 'meta/llama-3.3-70b-instruct';
const VISION_MODEL = process.env.VISION_MODEL || 'meta/llama-3.2-90b-vision-instruct';

// Word/phrase trigger that switches an image-bearing turn over to the
// vision model. Anything outside this set is treated as a normal chat
// turn — the image is mentioned in metadata but not actually shown to
// the model. Cues are taken from natural English phrasing.
const VISION_TRIGGER_RE = /\b(analyze|analyse|scan|look(\s+at)?|describe|identify|examine|inspect|read(\s+this)?|see|view|what(\s+(is|are|does|do|s|'s))?|tell\s+me\s+about|recognize|recognise|what's\s+in)\b/i;

function fmtBytes(n) {
  if (!n && n !== 0) return '?';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// Render a single non-image attachment as plain text the model can read.
function renderEmbedded(att) {
  const head = `[FILE: ${att.name} (${att.type || 'unknown'}, ${fmtBytes(att.size)})`
             + (att.pages ? `, ${att.pages} pages` : '') + ']';
  if (att.kind === 'text' && att.text) {
    return head + '\n' + att.text + '\n[END FILE]';
  }
  if (att.kind === 'audio' && att.transcript) {
    return head + '\n[TRANSCRIPT] ' + att.transcript + '\n[END FILE]';
  }
  // meta or empty text/audio: just metadata
  return `[FILE: ${att.name} (${att.type || 'binary'}, ${fmtBytes(att.size)})] (content not extracted)`;
}

// Build the user-turn content. Returns:
//   {
//     route: 'chat' | 'vision',
//     contentParts: <string for chat>  |  <array for vision multimodal>,
//     summaryNote: '[attached: foo.png, bar.md]' (for history persistence),
//   }
function buildUserTurn(message, attachments) {
  const atts = Array.isArray(attachments) ? attachments : [];
  const images = atts.filter(a => a && a.kind === 'image' && a.dataUrl);
  const others = atts.filter(a => a && a.kind !== 'image');
  const trigger = VISION_TRIGGER_RE.test(message || '');
  const useVision = images.length > 0 && trigger;
  const summary = atts.length ? ' [attached: ' + atts.map(a => a.name).join(', ') + ']' : '';

  // Build the text part: user message + embedded non-image attachments.
  // For the chat route we also note image attachments as metadata since
  // the chat model cannot actually see them.
  const textChunks = [];
  if (message && message.trim()) textChunks.push(message.trim());
  for (const a of others) textChunks.push(renderEmbedded(a));
  if (!useVision) {
    for (const img of images) {
      textChunks.push(`[image attached: ${img.name} (${img.type || 'image'}, ${fmtBytes(img.size)})]`);
    }
  }
  const text = textChunks.join('\n\n').trim() || '(no message)';

  if (useVision) {
    const parts = [{ type: 'text', text }];
    for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
    return { route: 'vision', contentParts: parts, summaryNote: summary };
  }
  return { route: 'chat', contentParts: text, summaryNote: summary };
}

router.post('/chat', requireAuth, async (req, res) => {
  const { message, attachments, userLang } = req.body || {};
  const userText = typeof message === 'string' ? message : '';
  const hasAtts = Array.isArray(attachments) && attachments.length > 0;
  if (!userText.trim() && !hasAtts) {
    return res.status(400).json({ error: 'message or attachments required' });
  }

  const turn = buildUserTurn(userText, attachments);

  // Language lock — figure out the language the user is actually using and
  // force the model to reply in it. Llama 3.3 70B follows the soft
  // bilingual hint in SYSTEM_FRIDAY only intermittently, especially on
  // short messages, so we layer a hard per-turn system message on top.
  // Trigger: explicit userLang hint from the client OR Hangul in the
  // typed/spoken text.
  const hasHangul = /[가-힯]/.test(userText);
  const replyKo = (userLang === 'ko-KR' || userLang === 'ko') || hasHangul;

  // Route-aware key + model selection.
  const route = turn.route;
  const key = route === 'vision' ? process.env.NIM_KEY_VISION : process.env.NIM_KEY_REASONING;
  const model = route === 'vision' ? VISION_MODEL : CHAT_MODEL;
  if (!key) {
    return res.status(503).json({
      error: route === 'vision' ? 'NIM_KEY_VISION not set' : 'NIM_KEY_REASONING not set',
    });
  }

  // Persist the human turn — just the typed message + a short attachment
  // summary so disk doesn't fill with embedded file content. Empty
  // typed-message + attachments-only sends are stored as the summary alone.
  const storedUser = (userText.trim() || '(attached files)') + turn.summaryNote;
  q.addMessage.run(req.user.id, 'user', storedUser, Date.now());

  // History for the model: prior turns from db + the new user message
  // with its full (possibly multimodal) content. Vision-route turns send
  // only the current user message (some vision models don't accept long
  // text-only history alongside multimodal content).
  const messages = [{ role: 'system', content: SYSTEM_FRIDAY }];
  if (replyKo) {
    // Hard language lock — overrides the soft bilingual hint in
    // SYSTEM_FRIDAY when the user is in Korean mode or wrote Hangul.
    messages.push({
      role: 'system',
      content: '이번 응답은 반드시 자연스러운 한국어 존댓말로만 작성하세요. 영어로 답변하지 마세요. 주인님을 "주인님" 또는 "사장님"으로 부르고, JARVIS 스타일의 위트와 간결함을 유지하세요. 마지막에는 [[emotion:X]] 태그를 영어 형식 그대로 한 줄 붙이세요.\n\n[Reply in Korean only. Use natural 존댓말. Do not mix English. Keep the JARVIS-style wit + brevity. End with the literal [[emotion:X]] tag on its own line.]',
    });
  }
  if (route === 'chat') {
    const recent = q.recentMessages.all(req.user.id, 20).reverse();
    // The latest entry IS the message we just persisted; replace its
    // content with the full embedded text so the model sees attachments.
    for (let i = 0; i < recent.length - 1; i++) {
      messages.push({ role: recent[i].role, content: recent[i].content });
    }
    messages.push({ role: 'user', content: turn.contentParts });
  } else {
    messages.push({ role: 'user', content: turn.contentParts });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  let upstream;
  try {
    upstream = await fetch(NIM_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 700,
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
