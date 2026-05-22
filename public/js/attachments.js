// File-attachment processing pipeline.
//
// Per File, produce one of these payload shapes ready for /api/chat:
//   { kind: 'image', name, size, type, dataUrl }     image/*
//   { kind: 'text',  name, size, type, text }        text/code OR pdf
//   { kind: 'audio', name, size, type, transcript }  audio/*
//   { kind: 'meta',  name, size, type }              everything else
//
// pdfjs is lazy-loaded from CDN on first PDF; audio transcription uses
// the existing /api/stt endpoint.

import * as api from './api.js';

const TEXT_EXTS = new Set([
  'txt','md','markdown','json','csv','tsv','yml','yaml','toml','ini','log',
  'js','mjs','cjs','ts','jsx','tsx','py','rb','go','rs','java','kt','swift',
  'c','h','cc','cpp','hpp','cs','php','lua','dart','scala','clj','ex','exs',
  'html','htm','css','scss','sass','less','sh','bash','zsh','fish','ps1',
  'sql','xml','svg','vue','svelte','astro','env','gitignore','dockerignore',
  'gradle','properties','conf',
]);

const MAX_PER_FILE = 10 * 1024 * 1024;       // 10 MB
const MAX_TEXT_BYTES = 30 * 1024;            // 30 KB embedded as text
const MAX_TOTAL_PAYLOAD = 12 * 1024 * 1024;  // 12 MB encoded across all files in a turn

function extOf(name) {
  const m = String(name || '').toLowerCase().match(/\.([^.]+)$/);
  return m ? m[1] : '';
}

function isTextish(file) {
  const t = (file.type || '').toLowerCase();
  if (t.startsWith('text/')) return true;
  if (/(json|xml|yaml|toml|csv|x-sh|javascript|typescript)/.test(t)) return true;
  return TEXT_EXTS.has(extOf(file.name));
}

function isImage(file) { return (file.type || '').startsWith('image/'); }
function isAudio(file) { return (file.type || '').startsWith('audio/'); }
function isPdf(file)   { return file.type === 'application/pdf' || extOf(file.name) === 'pdf'; }

function readAsText(file, maxBytes = MAX_TEXT_BYTES) {
  return new Promise((resolve, reject) => {
    const blob = file.slice(0, maxBytes);
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsText(blob);
  });
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || ''));
    r.onerror = () => reject(r.error || new Error('read failed'));
    r.readAsDataURL(file);
  });
}

// ---------- PDF text extraction via pdfjs (lazy) ----------
let pdfjsPromise = null;
async function loadPdfjs() {
  if (pdfjsPromise) return pdfjsPromise;
  pdfjsPromise = (async () => {
    const mod = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.min.mjs');
    mod.GlobalWorkerOptions.workerSrc =
      'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs';
    return mod;
  })();
  return pdfjsPromise;
}

async function extractPdfText(file) {
  const pdfjs = await loadPdfjs();
  const buf = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const parts = [];
  let total = 0;
  const maxPages = Math.min(doc.numPages, 50);
  for (let p = 1; p <= maxPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const pageText = content.items.map(it => it.str).join(' ');
    if (pageText.trim()) parts.push(`--- page ${p} ---\n${pageText}`);
    total += pageText.length;
    if (total >= MAX_TEXT_BYTES) break;
  }
  let out = parts.join('\n\n');
  if (out.length > MAX_TEXT_BYTES) out = out.slice(0, MAX_TEXT_BYTES) + '\n...[truncated]';
  return { text: out, pages: doc.numPages };
}

// ---------- audio transcription via Riva ----------
async function transcribeAudio(file) {
  try {
    const r = await api.stt(file);
    if (r?.fallback) return null;
    return (r?.transcript || '').trim() || null;
  } catch { return null; }
}

// ---------- friendly size formatter ----------
export function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// ---------- main entry — turn a File into a payload entry ----------
export async function processFile(file) {
  const meta = { name: file.name, size: file.size, type: file.type || 'application/octet-stream' };
  if (file.size > MAX_PER_FILE) {
    return { ...meta, kind: 'meta', error: 'too large (>10 MB)' };
  }
  try {
    if (isImage(file)) {
      const dataUrl = await readAsDataUrl(file);
      return { ...meta, kind: 'image', dataUrl };
    }
    if (isPdf(file)) {
      const { text, pages } = await extractPdfText(file);
      return { ...meta, kind: 'text', text, pages };
    }
    if (isAudio(file)) {
      const transcript = await transcribeAudio(file);
      return { ...meta, kind: 'audio', transcript: transcript || '(transcription unavailable)' };
    }
    if (isTextish(file)) {
      const text = await readAsText(file);
      return { ...meta, kind: 'text', text };
    }
    return { ...meta, kind: 'meta' };
  } catch (e) {
    return { ...meta, kind: 'meta', error: e?.message || 'processing failed' };
  }
}

// ---------- enforce total-payload cap across the pending set ----------
export function enforceTotalCap(entries) {
  let total = 0;
  const kept = [];
  for (const e of entries) {
    const size = e.kind === 'image' ? (e.dataUrl?.length || 0)
              : e.kind === 'text'  ? (e.text?.length || 0) * 2
              : e.kind === 'audio' ? (e.transcript?.length || 0) * 2
              : 0;
    if (total + size > MAX_TOTAL_PAYLOAD) {
      kept.push({ ...e, error: e.error || 'payload cap reached (12 MB total)' });
      continue;
    }
    total += size;
    kept.push(e);
  }
  return kept;
}

// ---------- short chip icon per kind ----------
export function iconFor(entry) {
  if (entry.kind === 'image') return '🖼';
  if (entry.kind === 'audio') return '🎵';
  if (entry.kind === 'text')  return entry.pages ? '📄' : '📝';
  return '📎';
}
