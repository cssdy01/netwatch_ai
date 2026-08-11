// src/controllers/hostMappingsController.js
// Phase 1: Host mappings for hostname-based Application URL monitoring.
// Allows private hostnames (e.g. dev.uimcn.tsaro.com) to resolve to
// specific IPs inside the Docker container without editing /etc/hosts.
// The web agent reads these mappings at check time.

const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { log, audit } = require('../services/appLog');

const router = Router();

function toIST(utcStr) {
  if (!utcStr) return null;
  return new Date(utcStr).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-') + ' IST';
}

function enrichMapping(m) {
  return { ...m, created_at_ist: toIST(m.created_at), updated_at_ist: toIST(m.updated_at) };
}

function validateHostname(hostname) {
  // Basic hostname validation: letters, digits, dots, hyphens
  return /^[a-zA-Z0-9]([a-zA-Z0-9\-.]*[a-zA-Z0-9])?$/.test(hostname);
}

function validateIp(ip) {
  // IPv4 only for now
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip);
}

// GET /api/host-mappings
router.get('/', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM host_mappings ORDER BY hostname').all();
  res.json(rows.map(enrichMapping));
});

// GET /api/host-mappings/:id
router.get('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM host_mappings WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Host mapping not found' });
  res.json(enrichMapping(row));
});

// POST /api/host-mappings
router.post('/', requireAuth, (req, res) => {
  const { hostname, ip_address, note } = req.body;

  if (!hostname || !hostname.trim()) {
    return res.status(400).json({ error: 'Hostname is required' });
  }
  if (!validateHostname(hostname.trim())) {
    return res.status(400).json({ error: 'Invalid hostname format' });
  }
  if (!ip_address || !ip_address.trim()) {
    return res.status(400).json({ error: 'IP address is required' });
  }
  if (!validateIp(ip_address.trim())) {
    return res.status(400).json({ error: 'Invalid IP address format (IPv4 required)' });
  }

  // Check uniqueness
  const existing = db.prepare('SELECT id FROM host_mappings WHERE hostname=?').get(hostname.trim().toLowerCase());
  if (existing) {
    return res.status(409).json({ error: `Host mapping for "${hostname}" already exists` });
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO host_mappings (id, hostname, ip_address, note)
    VALUES (?, ?, ?, ?)
  `).run(id, hostname.trim().toLowerCase(), ip_address.trim(), note?.trim() || null);

  const created = db.prepare('SELECT * FROM host_mappings WHERE id=?').get(id);
  log('INFO', 'ADMIN', req.user.username, null,
    `Host mapping created: ${hostname} → ${ip_address}`, null);
  audit(req.user.username, 'HOST_MAPPING_CREATED', `${hostname} → ${ip_address}`);
  res.status(201).json(enrichMapping(created));
});

// PUT /api/host-mappings/:id
router.put('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM host_mappings WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Host mapping not found' });

  const { hostname, ip_address, note } = req.body;

  if (!hostname || !hostname.trim()) {
    return res.status(400).json({ error: 'Hostname is required' });
  }
  if (!validateHostname(hostname.trim())) {
    return res.status(400).json({ error: 'Invalid hostname format' });
  }
  if (!ip_address || !ip_address.trim()) {
    return res.status(400).json({ error: 'IP address is required' });
  }
  if (!validateIp(ip_address.trim())) {
    return res.status(400).json({ error: 'Invalid IP address format' });
  }

  // Check uniqueness (exclude self)
  const conflict = db.prepare(
    'SELECT id FROM host_mappings WHERE hostname=? AND id != ?'
  ).get(hostname.trim().toLowerCase(), req.params.id);
  if (conflict) {
    return res.status(409).json({ error: `Host mapping for "${hostname}" already exists` });
  }

  db.prepare(`
    UPDATE host_mappings SET hostname=?, ip_address=?, note=?, updated_at=datetime('now')
    WHERE id=?
  `).run(hostname.trim().toLowerCase(), ip_address.trim(), note?.trim() || null, req.params.id);

  const updated = db.prepare('SELECT * FROM host_mappings WHERE id=?').get(req.params.id);
  log('INFO', 'ADMIN', req.user.username, null,
    `Host mapping updated: ${hostname} → ${ip_address}`, null);
  audit(req.user.username, 'HOST_MAPPING_UPDATED', `${row.hostname} → ${hostname}:${ip_address}`);
  res.json(enrichMapping(updated));
});

// DELETE /api/host-mappings/:id
router.delete('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM host_mappings WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Host mapping not found' });

  db.prepare('DELETE FROM host_mappings WHERE id=?').run(req.params.id);
  log('INFO', 'ADMIN', req.user.username, null,
    `Host mapping deleted: ${row.hostname} → ${row.ip_address}`, null);
  audit(req.user.username, 'HOST_MAPPING_DELETED', `${row.hostname} → ${row.ip_address}`);
  res.json({ ok: true });
});

module.exports = router;
