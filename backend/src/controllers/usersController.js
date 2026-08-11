// src/controllers/usersController.js
const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireSuperAdmin } = require('../middleware/auth');
const { log } = require('../services/appLog');

const router = Router();

router.get('/', requireSuperAdmin, (req, res) => {
  const users = db.prepare('SELECT id, email, role, created_at FROM users ORDER BY created_at DESC').all();
  res.json(users);
});

router.post('/', requireSuperAdmin, async (req, res) => {
  const { email, password, role } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email);
  if (existing) return res.status(400).json({ error: 'User already exists' });

  const hash = await bcrypt.hash(password, 12);
  const id = uuidv4();
  db.prepare('INSERT INTO users (id, email, password, role) VALUES (?, ?, ?, ?)')
    .run(id, email, hash, role === 'superadmin' ? 'superadmin' : 'user');

  log('INFO', 'ADMIN', req.user.username, null, `Created user: ${email}`, null);
  res.json({ id, email, role });
});

router.put('/:id', requireSuperAdmin, async (req, res) => {
  const { password, role } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let hash = user.password;
  if (password) hash = await bcrypt.hash(password, 12);

  db.prepare('UPDATE users SET password=?, role=? WHERE id=?')
    .run(hash, role === 'superadmin' ? 'superadmin' : 'user', req.params.id);

  log('INFO', 'ADMIN', req.user.username, null, `Updated user: ${user.email}`, null);
  res.json({ ok: true });
});

router.delete('/:id', requireSuperAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  if (user.email === process.env.ADMIN_USER) {
    return res.status(400).json({ error: 'Cannot delete the primary root superadmin' });
  }

  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  log('INFO', 'ADMIN', req.user.username, null, `Deleted user: ${user.email}`, null);
  res.json({ ok: true });
});

module.exports = router;