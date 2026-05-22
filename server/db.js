// Pure-JS JSON file store.
//
// Replaces better-sqlite3 so the project has zero native dependencies and
// installs cleanly on any Node 20+ runtime — including a blank Replit Node
// template where .replit/replit.nix may have been stripped at import time.
//
// Exposes the same `q` API surface that the rest of the server uses
// (createUser.run, userByEmail.get, addMessage.run, recentMessages.all,
// addCreation.run, recentCreations.all, creationById.get) so callers in
// server/auth.js, server/chat.js and server/codegen.js need no changes.

const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'friday.json');

const EMPTY = () => ({
  users: [],
  conversations: [],
  creations: [],
  nextId: { user: 1, message: 1, creation: 1 },
});

let state;
try {
  if (fs.existsSync(DB_PATH)) {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    state = raw.trim() ? JSON.parse(raw) : EMPTY();
    // Defensive: ensure all shapes exist
    state.users        ||= [];
    state.conversations||= [];
    state.creations    ||= [];
    state.nextId       ||= { user: 1, message: 1, creation: 1 };
  } else {
    state = EMPTY();
  }
} catch (e) {
  console.warn('[db] failed to read', DB_PATH, '—', e.message, '(starting fresh)');
  state = EMPTY();
}

let saveTimer = null;
function save() {
  // Debounce writes — coalesces bursts of mutations into one fsync.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = DB_PATH + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, DB_PATH);
    } catch (e) {
      console.error('[db] save failed:', e.message);
    }
  }, 60);
}
// Flush on exit so in-flight writes are not lost.
function flush() {
  if (saveTimer) clearTimeout(saveTimer);
  try { fs.writeFileSync(DB_PATH, JSON.stringify(state)); } catch {}
}
process.on('exit', flush);
process.on('SIGINT', () => { flush(); process.exit(); });
process.on('SIGTERM', () => { flush(); process.exit(); });

const q = {
  createUser: {
    run(email, pw_hash, created_at) {
      const id = state.nextId.user++;
      state.users.push({ id, email, pw_hash, created_at });
      save();
      return { lastInsertRowid: id };
    },
  },
  userByEmail: {
    get(email) { return state.users.find(u => u.email === email); },
  },
  userById: {
    get(id) {
      const u = state.users.find(uu => uu.id === id);
      return u ? { id: u.id, email: u.email, created_at: u.created_at } : undefined;
    },
  },

  addMessage: {
    run(user_id, role, content, ts) {
      const id = state.nextId.message++;
      state.conversations.push({ id, user_id, role, content, ts });
      save();
      return { lastInsertRowid: id };
    },
  },
  recentMessages: {
    all(user_id, limit) {
      return state.conversations
        .filter(m => m.user_id === user_id)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit)
        .map(m => ({ role: m.role, content: m.content, ts: m.ts }));
    },
  },

  addCreation: {
    run(user_id, goal, files_json, ts) {
      const id = state.nextId.creation++;
      state.creations.push({ id, user_id, goal, files_json, ts });
      save();
      return { lastInsertRowid: id };
    },
  },
  recentCreations: {
    all(user_id, limit) {
      return state.creations
        .filter(c => c.user_id === user_id)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit)
        .map(c => ({ id: c.id, goal: c.goal, files_json: c.files_json, ts: c.ts }));
    },
  },
  creationById: {
    get(id, user_id) {
      const c = state.creations.find(cc => cc.id === id && cc.user_id === user_id);
      return c ? { id: c.id, goal: c.goal, files_json: c.files_json, ts: c.ts } : undefined;
    },
  },
};

// No-op kept for API compatibility with the previous module shape.
function initDb() {}

module.exports = { initDb, q };
