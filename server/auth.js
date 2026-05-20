const express = require('express');
const bcrypt = require('bcryptjs');
const { q } = require('./db');
const { sign, requireAuth } = require('./middleware');

const router = express.Router();
const COOKIE = { httpOnly: true, sameSite: 'lax', secure: false, maxAge: 7 * 24 * 3600 * 1000 };

function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || '')); }

router.post('/register', async (req, res) => {
  const { email, password } = req.body || {};
  if (!isEmail(email) || !password || password.length < 6) {
    return res.status(400).json({ error: 'invalid email or password (min 6 chars)' });
  }
  const existing = q.userByEmail.get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'email already registered' });
  const hash = await bcrypt.hash(password, 12);
  const info = q.createUser.run(email.toLowerCase(), hash, Date.now());
  const user = { id: info.lastInsertRowid, email: email.toLowerCase() };
  res.cookie('fr_tok', sign(user), COOKIE);
  res.json({ user });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!isEmail(email) || !password) return res.status(400).json({ error: 'invalid input' });
  const row = q.userByEmail.get(email.toLowerCase());
  if (!row) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, row.pw_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  res.cookie('fr_tok', sign({ id: row.id, email: row.email }), COOKIE);
  res.json({ user: { id: row.id, email: row.email } });
});

router.post('/logout', (req, res) => {
  res.clearCookie('fr_tok');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const u = q.userById.get(req.user.id);
  if (!u) return res.status(401).json({ error: 'user gone' });
  res.json({ user: u });
});

module.exports = { router };
