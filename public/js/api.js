export async function me() {
  const r = await fetch('/api/me', { credentials: 'include' });
  if (!r.ok) return null;
  return (await r.json()).user;
}

export async function logout() {
  await fetch('/api/logout', { method: 'POST', credentials: 'include' });
}

export async function* chatStream(message, attachments) {
  const body = (attachments && attachments.length) ? { message, attachments } : { message };
  const r = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`chat ${r.status}: ${txt.slice(0, 200)}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload) continue;
      let j;
      try { j = JSON.parse(payload); } catch { continue; }
      // Surface server-emitted error events (sent as `data: {"error":"..."}`
      // after the SSE stream already started, e.g. when NVIDIA NIM rejects
      // the upstream request with 401/404/429/5xx). Without this, the
      // client silently swallowed those and the reply bubble stayed blank.
      if (j.error) throw new Error(j.error);
      if (j.delta) yield j.delta;
    }
  }
}

export async function tts(text) {
  const r = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ text }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    if (j.fallback === 'webspeech') return { fallback: true };
    throw new Error(j.error || `tts ${r.status}`);
  }
  const blob = await r.blob();
  return { url: URL.createObjectURL(blob) };
}

export async function stt(audioBlob) {
  const fd = new FormData();
  fd.append('audio', audioBlob, 'clip.webm');
  const r = await fetch('/api/stt', { method: 'POST', body: fd, credentials: 'include' });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    if (j.fallback === 'webspeech') return { fallback: true };
    throw new Error(j.error || `stt ${r.status}`);
  }
  return r.json();
}

export async function vision(blob, command, note = '') {
  const fd = new FormData();
  fd.append('frame', blob, 'frame.jpg');
  fd.append('command', command);
  if (note) fd.append('note', note);
  const r = await fetch('/api/vision', { method: 'POST', body: fd, credentials: 'include' });
  if (!r.ok) throw new Error((await r.text()).slice(0, 200));
  return r.json();
}

export async function codegen(goal) {
  const r = await fetch('/api/codegen', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ goal }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || `codegen ${r.status}`);
  }
  return r.json();
}

export async function chatHistory() {
  const r = await fetch('/api/history/chat', { credentials: 'include' });
  if (!r.ok) return { messages: [] };
  return r.json();
}

export async function creationHistory() {
  const r = await fetch('/api/history/creations', { credentials: 'include' });
  if (!r.ok) return { creations: [] };
  return r.json();
}

export async function creation(id) {
  const r = await fetch('/api/creation/' + encodeURIComponent(id), { credentials: 'include' });
  if (!r.ok) throw new Error(`creation ${r.status}`);
  return r.json();
}
