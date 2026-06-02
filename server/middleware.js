const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// JWT signing secret. Resolved in this order:
//   1) process.env.JWT_SECRET (explicit override)
//   2) data/.jwt-secret on disk (auto-generated on first boot)
//   3) freshly generate 96 hex chars, write to data/.jwt-secret
//
// This means a fresh Replit (or any fresh checkout) "just works" — no
// console step required to set a JWT_SECRET secret. The file is created
// inside `data/` which is already in .gitignore, so it never leaks.
let cachedSecret = null;
function getSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (cachedSecret) return cachedSecret;
  const dataDir = path.join(__dirname, '..', 'data');
  const file = path.join(dataDir, '.jwt-secret');
  try {
    if (fs.existsSync(file)) {
      const v = fs.readFileSync(file, 'utf8').trim();
      if (v.length >= 32) { cachedSecret = v; return cachedSecret; }
    }
  } catch (_) {}
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) {}
  cachedSecret = crypto.randomBytes(48).toString('hex');
  try { fs.writeFileSync(file, cachedSecret, { mode: 0o600 }); } catch (_) {}
  return cachedSecret;
}

function requireAuth(req, res, next) {
  const token = req.cookies?.fr_tok;
  if (!token) return res.status(401).json({ error: 'auth required' });
  try {
    const payload = jwt.verify(token, getSecret());
    req.user = { id: payload.sub, email: payload.email };
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
}

function sign(user) {
  return jwt.sign({ sub: user.id, email: user.email }, getSecret(), { expiresIn: '7d' });
}

module.exports = { requireAuth, sign };
