const jwt = require('jsonwebtoken');

function getSecret() {
  return process.env.JWT_SECRET || 'dev-only-secret-change-me';
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
