import * as api from './api.js';
import * as voice from './voice.js';
import * as wake from './wake.js';
import './barge.js';
import * as face from './face.js';
import * as hud from './hud.js';
import * as camera from './camera.js';
import * as mb from './miniBrowser.js';
import * as vr from './vr.js';
import * as codegen from './codegen.js';
import * as attachments from './attachments.js';

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const chatLog = $('chat-log');
const chatForm = $('chat-form');
const chatInput = $('chat-input');
const statusText = $('status-text');
const userEmail = $('user-email');
const btnMic = $('btn-mic');
const btnWake = $('btn-wake');
const btnCamera = $('btn-camera');
const btnVR = $('btn-vr');
const btnCodegen = $('btn-codegen');
const btnHistory = $('btn-history');
const codegenPanel = $('codegen-panel');
const fileInput = $('file-input');
const attachBtn = $('attach-btn');
const attChips = $('chat-attachments');
const chatPanel = $('chat-panel');
const dropOverlay = $('chat-drop-overlay');
const historyPanel = $('history-panel');
const chatHistoryList = $('chat-history');
const creationHistoryList = $('creation-history');

// ---------- Auth gate ----------
(async () => {
  const user = await api.me();
  if (!user) { location.href = '/login'; return; }
  userEmail.textContent = user.email;
  init();
})();

function setStatus(state, label) {
  ['online', 'listening', 'speaking', 'alert'].forEach(c => document.body.classList.remove(c));
  if (state) document.body.classList.add(state);
  if (label) statusText.textContent = label;
}

// ---------- Chat ----------
function addBubble(role, text) {
  const b = document.createElement('div');
  b.className = 'bubble ' + role;
  b.textContent = text;
  chatLog.appendChild(b);
  chatLog.scrollTop = chatLog.scrollHeight;
  return b;
}
function addSys(text) { return addBubble('sys', text); }

let inflightBubble = null;
async function sendMessage(message) {
  // Even with no text, allow sending if attachments are present (rare).
  const atts = takePendingAttachments();
  if (!message || !message.trim()) {
    if (!atts.length) return;
    message = '';
  }
  const summary = atts.length ? ` [attached: ${atts.map(a => a.name).join(', ')}]` : '';
  addBubble('user', (message || '(attached files)') + summary);
  inflightBubble = addBubble('friday', '');
  let buf = '';
  try {
    for await (const delta of api.chatStream(message, atts.map(a => a.payload))) {
      buf += delta;
      if (inflightBubble) {
        // strip emotion tag from visible text
        inflightBubble.textContent = buf.replace(/\[\[emotion:[a-z]+\]\]/i, '').trim();
        chatLog.scrollTop = chatLog.scrollHeight;
      }
    }
  } catch (e) {
    const pretty = prettifyChatError(e?.message || String(e));
    if (inflightBubble) inflightBubble.remove();
    inflightBubble = null;
    addSys('⚠ ' + pretty);
    return;
  }
  if (!buf.trim() && inflightBubble) {
    // Empty stream means the upstream completed without producing any
    // content (rare but happens with some model errors). Surface it.
    inflightBubble.remove();
    inflightBubble = null;
    addSys('⚠ no reply from the language model — check the server logs.');
    return;
  }
  if (buf.trim()) await voice.speak(buf);
}

function prettifyChatError(raw) {
  if (/NIM_KEY_REASONING not set/i.test(raw)) {
    return 'NVIDIA NIM key not configured. Add NIM_KEY_REASONING to your Replit Secrets (or .env) and click Run again.';
  }
  if (/upstream 401/.test(raw)) return 'NVIDIA NIM rejected the key (401). Verify NIM_KEY_REASONING at build.nvidia.com — it may be rotated, expired, or have no model access.';
  if (/upstream 403/.test(raw)) return 'NVIDIA NIM forbidden (403). The key lacks access to the chat model.';
  if (/upstream 404/.test(raw)) return 'NVIDIA NIM model not found (404). Check LLM_MODEL — default is meta/llama-3.3-70b-instruct.';
  if (/upstream 429/.test(raw)) return 'NVIDIA NIM rate-limited (429). Wait a moment and try again.';
  if (/upstream 5\d\d/.test(raw)) return 'NVIDIA NIM upstream error. Try again in a moment.';
  if (/Failed to fetch|NetworkError/i.test(raw)) return 'Network error talking to the server. Is the Replit still running?';
  // Strip the noisy "chat 503: " prefix so the inner error is readable.
  return raw.replace(/^chat \d+:\s*/, '').replace(/^\{"?error"?:\s*"?/i, '').replace(/"?\}?$/, '');
}

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = chatInput.value.trim();
  if (!v && !pendingAttachments.length) return;
  chatInput.value = '';
  sendMessage(v);
});

// ---------- File attachments ----------
const pendingAttachments = []; // [{ id, file, payload, status: 'busy'|'ready'|'error', error? }]
let attachIdSeq = 1;

function takePendingAttachments() {
  // Return ready entries and clear the pending list (chips cleared too).
  const ready = pendingAttachments.filter(a => a.status === 'ready' && a.payload);
  pendingAttachments.length = 0;
  renderChips();
  return ready;
}

function removeAttachment(id) {
  const i = pendingAttachments.findIndex(a => a.id === id);
  if (i !== -1) { pendingAttachments.splice(i, 1); renderChips(); }
}

function renderChips() {
  if (!pendingAttachments.length) {
    attChips.hidden = true; attChips.innerHTML = '';
    return;
  }
  attChips.hidden = false;
  attChips.innerHTML = '';
  for (const a of pendingAttachments) {
    const chip = document.createElement('span');
    chip.className = 'att-chip' + (a.status === 'error' ? ' att-error' : a.status === 'busy' ? ' att-busy' : '');
    const meta = a.payload ? attachments.fmtSize(a.payload.size || 0) : '…';
    const icon = a.payload ? attachments.iconFor(a.payload) : '⏳';
    chip.innerHTML = `<span>${icon}</span><span class="att-name">${escapeHtml(a.file.name)}</span><span class="att-meta">${meta}</span>`;
    if (a.status === 'error') {
      const err = document.createElement('span');
      err.className = 'att-meta'; err.textContent = ' · ' + (a.error || 'error');
      chip.appendChild(err);
    }
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'att-x'; x.textContent = '×';
    x.title = 'remove'; x.addEventListener('click', () => removeAttachment(a.id));
    chip.appendChild(x);
    attChips.appendChild(chip);
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));
}

async function attachFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  // Add busy chips immediately
  const entries = files.map(file => ({
    id: attachIdSeq++, file, payload: null, status: 'busy',
  }));
  pendingAttachments.push(...entries);
  renderChips();
  // Process each in parallel
  await Promise.all(entries.map(async (entry) => {
    try {
      const payload = await attachments.processFile(entry.file);
      entry.payload = payload;
      if (payload.error) { entry.status = 'error'; entry.error = payload.error; }
      else entry.status = 'ready';
    } catch (e) {
      entry.status = 'error'; entry.error = e?.message || 'processing failed';
    }
    renderChips();
  }));
  // Enforce total-payload cap once everything's processed
  const capped = attachments.enforceTotalCap(pendingAttachments.filter(a => a.payload).map(a => a.payload));
  for (let i = 0; i < pendingAttachments.length; i++) {
    const a = pendingAttachments[i];
    if (!a.payload) continue;
    const c = capped[i];
    if (c?.error && !a.error) { a.status = 'error'; a.error = c.error; }
  }
  renderChips();
}

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  attachFiles(fileInput.files);
  fileInput.value = '';
});

// Drag-and-drop on chat panel
let dragDepth = 0;
chatPanel.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  chatPanel.classList.add('dragging');
  dropOverlay.hidden = false;
});
chatPanel.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
chatPanel.addEventListener('dragleave', (e) => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    chatPanel.classList.remove('dragging');
    dropOverlay.hidden = true;
  }
});
chatPanel.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  dragDepth = 0;
  chatPanel.classList.remove('dragging');
  dropOverlay.hidden = true;
  attachFiles(e.dataTransfer.files);
});

// ---------- Voice command routing ----------
function tryLocalCommand(text) {
  const t = text.toLowerCase().trim();
  if (!t) return false;

  // Camera mode
  if (/(camera|vision|visual)\s*mode/.test(t) || /enter (camera|vision)/.test(t)) {
    camera.enter().then((ok) => { if (ok) { btnCamera.classList.add('active'); btnVR.hidden = false; } });
    return true;
  }
  if (/exit (camera|vision)/.test(t) || /close (camera|vision)/.test(t)) {
    camera.exit(); btnCamera.classList.remove('active'); btnVR.hidden = true; vr.setVR(false);
    return true;
  }

  // VR mode
  if (/vr\s*mode|cardboard/.test(t)) {
    const on = vr.toggle();
    addSys(on ? 'VR mode engaged.' : 'VR mode disengaged.');
    return true;
  }
  if (/exit vr/.test(t)) { vr.setVR(false); return true; }

  // Mini-browser open / close
  const openMatch = t.match(/\bopen\s+(google|duckduckgo|ddg|bing|youtube|wikipedia|wiki)(?:\s+(?:for|about)?\s*(.+))?$/);
  if (openMatch) {
    const engine = openMatch[1];
    const query = (openMatch[2] || '').trim();
    mb.open(engine, query);
    addSys(`Opening ${engine}${query ? ' for "' + query + '"' : ''}.`);
    return true;
  }
  if (/close (web|browser)/.test(t)) { mb.close(); return true; }

  // Vision commands
  const visionMatch = t.match(/\b(?:analyze|analyse|scan)\b\s+(?:this\s+|the\s+)?(product|medication|med|movement|material|math|mathematics)/);
  if (visionMatch) {
    let cmd = visionMatch[1];
    if (cmd === 'med') cmd = 'medication';
    if (cmd === 'mathematics') cmd = 'math';
    camera.analyze(cmd, t).then((content) => {
      if (content) {
        addBubble('friday', content.replace(/\[\[emotion:[a-z]+\]\]/i, '').trim());
        voice.speak(content);
      }
    });
    return true;
  }

  // Mute
  if (/^mute(\s+mic)?$/.test(t)) { setMute(true); return true; }
  if (/^unmute/.test(t)) { setMute(false); return true; }

  return false;
}

function handleSpokenCommand(text) {
  if (!text) return;
  addSys(`heard: "${text}"`);
  if (tryLocalCommand(text)) return;
  if (voice.isSpeaking()) voice.stopSpeaking();
  sendMessage(text);
}

window.addEventListener('friday:command', (e) => handleSpokenCommand(e.detail));
window.addEventListener('friday:wake', () => {
  setStatus('listening', 'listening');
  // Only stop TTS if Friday is actually speaking — avoids dispatching a
  // spurious speaking=false event that schedules a recognizer-restart.
  if (voice.isSpeaking()) voice.stopSpeaking();
  addSys('— wake — listening for command…');
  hud.setReadout?.('Wake acknowledged. Awaiting command.');
});
window.addEventListener('friday:command-timeout', () => {
  addSys('(no command heard — back to standby)');
});
window.addEventListener('friday:shutdown', () => {
  addSys('— shutdown received —');
  voice.speak('Standing down, sir. Disconnecting all systems.');
  wake.stop();
  btnWake.classList.remove('active');
  setStatus(null, 'offline');
});
window.addEventListener('friday:status', (e) => { setStatus(null, e.detail); });
window.addEventListener('friday:speaking', (e) => {
  if (e.detail) setStatus('speaking', 'speaking');
  else if (wake.isRunning()) setStatus('listening', 'listening');
});
window.addEventListener('friday:barge', () => {
  addSys('— interrupted —');
});

// ---------- Mute / wake buttons ----------
function setMute(v) {
  wake.setMuted(v);
  btnMic.classList.toggle('muted', v);
  btnMic.querySelector('.lbl').textContent = v ? 'unmute' : 'mute';
}
btnMic.addEventListener('click', () => setMute(!wake.getMuted()));

btnWake.addEventListener('click', async () => {
  if (wake.isRunning()) {
    wake.stop(); btnWake.classList.remove('active');
  } else {
    await wake.start();
    if (wake.isRunning()) {
      btnWake.classList.add('active');
      setStatus('listening', 'listening');
      addSys('Listening. Say "Friday" to begin.');
    }
  }
});

// ---------- Camera button ----------
btnCamera.addEventListener('click', async () => {
  if (camera.isActive()) {
    camera.exit(); btnCamera.classList.remove('active'); btnVR.hidden = true; vr.setVR(false);
  } else {
    const ok = await camera.enter();
    if (ok) { btnCamera.classList.add('active'); btnVR.hidden = false; }
  }
});

// ---------- VR button ----------
btnVR.addEventListener('click', () => vr.toggle());

// ---------- Panels ----------
function togglePanel(panel, btn) {
  const open = !panel.hidden;
  panel.hidden = open;
  btn.classList.toggle('active', !open);
}
btnCodegen.addEventListener('click', () => togglePanel(codegenPanel, btnCodegen));
btnHistory.addEventListener('click', async () => {
  togglePanel(historyPanel, btnHistory);
  if (!historyPanel.hidden) loadHistory();
});
document.querySelectorAll('[data-close]').forEach(el => {
  el.addEventListener('click', () => {
    const p = document.getElementById(el.dataset.close);
    p.hidden = true;
  });
});
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    chatHistoryList.hidden = tab.dataset.tab !== 'chat-history';
    creationHistoryList.hidden = tab.dataset.tab !== 'creation-history';
  });
});

async function loadHistory() {
  const ch = await api.chatHistory();
  chatHistoryList.innerHTML = (ch.messages || [])
    .map(m => `<li><span style="color:var(--cyan)">${m.role}</span>: ${escape(m.content).slice(0, 240)}</li>`).join('') || '<li class="muted">no chats yet</li>';
  const cr = await api.creationHistory();
  creationHistoryList.innerHTML = (cr.creations || [])
    .map(c => `<li data-id="${c.id}">⌬ ${escape(c.goal).slice(0, 80)} <span class="muted small">${new Date(c.ts).toLocaleString()}</span></li>`).join('') || '<li class="muted">no creations yet</li>';
  creationHistoryList.querySelectorAll('li[data-id]').forEach(li => {
    li.addEventListener('click', async () => {
      try {
        const rec = await api.creation(li.dataset.id);
        codegen.loadCreation(rec);
        historyPanel.hidden = true; btnHistory.classList.remove('active');
        codegenPanel.hidden = false; btnCodegen.classList.add('active');
      } catch (e) { /* ignore */ }
    });
  });
}
function escape(s) { return String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])); }

// ---------- Logout ----------
$('logout-btn').addEventListener('click', async () => {
  await api.logout(); location.href = '/login';
});

// ---------- Boot ----------
function init() {
  const canvas = document.getElementById('face-canvas');
  face.init(canvas);
  document.body.classList.remove('boot');
  setStatus('online', 'standby');
  addSys('Friday online. Press the power icon to begin listening, or type below.');
  // Restore last 8 chat messages
  api.chatHistory().then(({ messages = [] }) => {
    messages.slice(-8).forEach(m => addBubble(m.role === 'assistant' ? 'friday' : m.role, (m.content || '').replace(/\[\[emotion:[a-z]+\]\]/i, '').trim()));
  });
}
