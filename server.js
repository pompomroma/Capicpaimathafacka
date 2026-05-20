require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

require('./server/db'); // self-initializes data dir + schema
const auth = require('./server/auth');
const chat = require('./server/chat');
const vision = require('./server/vision');
const codegen = require('./server/codegen');
const voice = require('./server/voice');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(cookieParser());

app.use('/api', auth.router);
app.use('/api', chat.router);
app.use('/api', vision.router);
app.use('/api', codegen.router);
app.use('/api', voice.router);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use((err, req, res, next) => {
  console.error('[server]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message || 'internal error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Friday online at http://localhost:${PORT}`);
  const missing = [];
  if (!process.env.NIM_KEY_REASONING) missing.push('NIM_KEY_REASONING');
  if (!process.env.NIM_KEY_VISION) missing.push('NIM_KEY_VISION');
  if (!process.env.NIM_KEY_CODEGEN) missing.push('NIM_KEY_CODEGEN');
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  if (missing.length) {
    console.warn(`[warning] missing env vars: ${missing.join(', ')}. Some features will not work.`);
  }
});
