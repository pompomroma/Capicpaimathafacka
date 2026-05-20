const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'friday.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    pw_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_conv_user_ts ON conversations(user_id, ts);
  CREATE TABLE IF NOT EXISTS creations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    goal TEXT NOT NULL,
    files_json TEXT NOT NULL,
    ts INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_creations_user_ts ON creations(user_id, ts);
`);

function initDb() { /* schema already ensured at require time */ }

const q = {
  createUser: db.prepare('INSERT INTO users (email, pw_hash, created_at) VALUES (?, ?, ?)'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userById: db.prepare('SELECT id, email, created_at FROM users WHERE id = ?'),

  addMessage: db.prepare('INSERT INTO conversations (user_id, role, content, ts) VALUES (?, ?, ?, ?)'),
  recentMessages: db.prepare('SELECT role, content, ts FROM conversations WHERE user_id = ? ORDER BY ts DESC LIMIT ?'),

  addCreation: db.prepare('INSERT INTO creations (user_id, goal, files_json, ts) VALUES (?, ?, ?, ?)'),
  recentCreations: db.prepare('SELECT id, goal, files_json, ts FROM creations WHERE user_id = ? ORDER BY ts DESC LIMIT ?'),
  creationById: db.prepare('SELECT id, goal, files_json, ts FROM creations WHERE id = ? AND user_id = ?'),
};

module.exports = { db, initDb, q };
