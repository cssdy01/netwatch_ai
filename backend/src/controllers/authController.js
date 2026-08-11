// src/controllers/authController.js
const { Router } = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, requireAuth } = require('../middleware/auth');
const { log, audit } = require('../services/appLog');

const router = Router();
const attempts = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  const record = attempts.get(ip) || { count: 0, windowStart: now };
  if (now - record.windowStart > 60000) { record.count = 0; record.windowStart = now; }
  record.count++;
  attempts.set(ip, record);
  if (record.count > 5) return res.status(429).json({ error: 'Too many login attempts.' });
  next();
}

router.post('/login', rateLimit, async (req, res) => {
  const { username, password } = req.body;
  const ip = req.ip || req.socket.remoteAddress;

  if (!username || !password) {
    audit(username || 'unknown', 'LOGIN_FAILED', `Missing credentials | IP: ${ip}`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email=?').get(username);
  if (!user) {
    audit(username, 'LOGIN_FAILED', `User not found | IP: ${ip}`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    audit(username, 'LOGIN_FAILED', `Wrong password | IP: ${ip}`);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken({ username: user.email, role: user.role });
  const hours = parseInt(process.env.SESSION_HOURS || '8');

  res.cookie('netwatch_token', token, { httpOnly: true, sameSite: 'lax', maxAge: hours * 3600 * 1000 });
  
  log('INFO', 'AUTH', user.email, null, `Login successful from IP ${ip}`, null);
  audit(user.email, 'LOGIN_SUCCESS', `Email ID: ${user.email} | IP: ${ip}`);
  res.json({ ok: true, username: user.email, role: user.role });
});

router.post('/logout', (req, res) => {
  let username = 'unknown';
  try {
    const jwt = require('jsonwebtoken');
    if (req.cookies?.netwatch_token) {
      username = jwt.decode(req.cookies.netwatch_token)?.username || username;
    }
  } catch {}
  res.clearCookie('netwatch_token');
  audit(username, 'LOGOUT', `Session ended | Email ID: ${username}`);
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

module.exports = router;