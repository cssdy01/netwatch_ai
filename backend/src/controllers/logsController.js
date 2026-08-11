// src/controllers/logsController.js
const { Router } = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { sendTestEmail } = require('../mail/mailService');
const { log } = require('../services/appLog');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const router = Router();

const LOG_RETENTION_DAYS = 15;
const APP_LOG_MAX    = 5000;
const APP_LOG_TRIM   = 500;
const AUDIT_LOG_MAX  = 2000;
const AUDIT_LOG_TRIM = 200;

const LOG_ARCHIVE_DIR = process.env.LOG_ARCHIVE_DIR || (db.LOG_ARCHIVE_DIR) || path.join(process.env.DATA_DIR || './data', 'log-archives');

function toIST(utcStr) {
  if (!utcStr) return null;
  try {
    return new Date(utcStr).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }).replace(/\//g, '-') + ' IST';
  } catch { return utcStr; }
}

function convertLogsToIST(logs) {
  return logs.map(row => ({ ...row, created_at_ist: toIST(row.created_at), created_at: row.created_at }));
}

function trimAppLogs() {
  if (db.prepare('SELECT COUNT(*) as c FROM app_logs').get().c > APP_LOG_MAX) {
    db.prepare(`DELETE FROM app_logs WHERE id IN (SELECT id FROM app_logs ORDER BY created_at ASC LIMIT ?)`).run(APP_LOG_TRIM);
  }
}

function trimAuditLogs() {
  if (db.prepare('SELECT COUNT(*) as c FROM audit_logs').get().c > AUDIT_LOG_MAX) {
    db.prepare(`DELETE FROM audit_logs WHERE id IN (SELECT id FROM audit_logs ORDER BY created_at ASC LIMIT ?)`).run(AUDIT_LOG_TRIM);
  }
}

module.exports.trimAppLogs   = trimAppLogs;
module.exports.trimAuditLogs = trimAuditLogs;

const TASK_CATEGORIES  = ['TASK', 'MONITORING', 'EMAIL'];
const ADMIN_CATEGORIES = ['ADMIN', 'BACKUP', 'SYSTEM'];

function istDaysAgoCutoff(days) {
  const now = new Date();
  const istNow = new Date(now.getTime() + 330 * 60 * 1000);
  const istTarget = new Date(istNow);
  istTarget.setDate(istTarget.getDate() - days);
  istTarget.setHours(0, 0, 0, 0);
  return new Date(istTarget.getTime() - 330 * 60 * 1000).toISOString();
}

function todayIST() {
  return new Date(new Date().getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

// GET /api/logs/app
router.get('/app', requireAuth, (req, res) => {
  const { level, category, task_name, group, actor, page = 0, limit = 25 } = req.query;
  const PAGE_SIZE = parseInt(limit, 10) || 25;
  const offset = parseInt(page) * PAGE_SIZE;
  const where  = [];
  const params = [];

  if (group === 'TASK_LOGS') {
    where.push(`category IN (${TASK_CATEGORIES.map(() => '?').join(',')})`);
    params.push(...TASK_CATEGORIES);
  } else if (group === 'ADMIN_LOGS') {
    where.push(`category IN (${ADMIN_CATEGORIES.map(() => '?').join(',')})`);
    params.push(...ADMIN_CATEGORIES);
  }

  if (level && level !== 'ALL') { where.push('level=?'); params.push(level); }
  if (category && category !== 'ALL') { where.push('category=?'); params.push(category); }
  if (task_name) { where.push('task_name LIKE ?'); params.push(`%${task_name}%`); }
  if (actor) { where.push('actor LIKE ?'); params.push(`%${actor}%`); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM app_logs ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, PAGE_SIZE, offset);
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM app_logs ${whereClause}`).get(...params).cnt;

  res.json({ logs: convertLogsToIST(rows), total, page: parseInt(page), pageSize: PAGE_SIZE, totalPages: Math.ceil(total / PAGE_SIZE) });
});

// GET /api/logs/audit
router.get('/audit', requireAuth, (req, res) => {
  const { page = 0, limit = 25, actor, action } = req.query;
  const PAGE_SIZE = parseInt(limit, 10) || 25;
  const offset = parseInt(page) * PAGE_SIZE;
  
  const where = [];
  const params = [];
  
  if (actor) { where.push('actor LIKE ?'); params.push(`%${actor}%`); }
  if (action) { where.push('action LIKE ?'); params.push(`%${action}%`); }
  
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`SELECT * FROM audit_logs ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, PAGE_SIZE, offset);
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM audit_logs ${whereClause}`).get(...params).cnt;

  res.json({ logs: convertLogsToIST(rows), total, page: parseInt(page), pageSize: PAGE_SIZE, totalPages: Math.ceil(total / PAGE_SIZE) });
});

// GET /api/logs/download
router.get('/download', requireAuth, (req, res) => {
  const { range = 'today', category = 'ALL', format = 'json' } = req.query;
  let cutoff = range === '7d' ? istDaysAgoCutoff(7) : (range === '15d' ? istDaysAgoCutoff(15) : istDaysAgoCutoff(1));
  let appLogs = [], auditLogs = [];

  if (category === 'AUTH_LOGS' || category === 'ALL') {
    auditLogs = db.prepare('SELECT * FROM audit_logs WHERE created_at >= ? ORDER BY created_at DESC').all(cutoff);
  }

  if (category !== 'AUTH_LOGS') {
    const where = ['created_at >= ?'], params = [cutoff];
    if (category === 'TASK_LOGS') { where.push(`category IN (${TASK_CATEGORIES.map(() => '?').join(',')})`); params.push(...TASK_CATEGORIES); } 
    else if (category === 'ADMIN_LOGS') { where.push(`category IN (${ADMIN_CATEGORIES.map(() => '?').join(',')})`); params.push(...ADMIN_CATEGORIES); }
    appLogs = db.prepare(`SELECT * FROM app_logs WHERE ${where.join(' AND ')} ORDER BY created_at DESC`).all(...params);
  }

  const filename = `netwatch-logs-${range === 'today' ? 'today' : `last-${range}`}-${category.toLowerCase().replace('_', '-')}-${todayIST()}`;

  if (format === 'csv') {
    const lines = ['timestamp_utc,timestamp_ist,level,category,actor,task_name,message,detail'];
    for (const r of appLogs) lines.push([r.created_at, toIST(r.created_at), r.level, r.category, r.actor || '', (r.task_name || '').replace(/,/g, ';'), (r.message || '').replace(/,/g, ';').replace(/\n/g, ' '), (r.detail || '').replace(/,/g, ';').replace(/\n/g, ' ')].join(','));
    for (const r of auditLogs) lines.push([r.created_at, toIST(r.created_at), 'INFO', 'AUTH', r.actor || '', '', (r.action || '').replace(/,/g, ';'), (r.detail || '').replace(/,/g, ';').replace(/\n/g, ' ')].join(','));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
    return res.send(lines.join('\n'));
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.json"`);
  res.json({ generated_at_ist: toIST(new Date().toISOString()), range, category, app_logs: convertLogsToIST(appLogs), audit_logs: convertLogsToIST(auditLogs), totals: { app_logs: appLogs.length, audit_logs: auditLogs.length } });
});

// GET /api/logs/archives
router.get('/archives', requireAuth, (req, res) => {
  const archives = db.prepare('SELECT * FROM log_archives ORDER BY archive_date DESC LIMIT 50').all();
  res.json({ archives: archives.map(a => ({ ...a, created_at_ist: toIST(a.created_at) })), archive_dir: LOG_ARCHIVE_DIR });
});

// POST /api/logs/archives/trigger (MANUAL ARCHIVE)
router.post('/archives/trigger', requireAuth, async (req, res) => {
  try {
    await archiveLogs();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/logs/archives/:id/download
router.get('/archives/:id/download', requireAuth, (req, res) => {
  const archive = db.prepare('SELECT * FROM log_archives WHERE id=?').get(req.params.id);
  if (!archive || !fs.existsSync(archive.filepath)) return res.status(404).json({ error: 'Archive file not found' });
  res.download(archive.filepath, archive.filename);
});

// POST /api/logs/test-email
router.post('/test-email', requireAuth, async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'Recipient email required' });
  try { await sendTestEmail(to); res.json({ ok: true }); } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/logs/health
router.get('/health', requireAuth, (req, res) => {
  const { execSync } = require('child_process');
  const activeTasks   = db.prepare('SELECT COUNT(*) as cnt FROM tasks WHERE deleted_at IS NULL').get().cnt;
  const faultTasks    = db.prepare("SELECT COUNT(*) as cnt FROM tasks WHERE status='FAULT' AND deleted_at IS NULL").get().cnt;
  const openIncidents = db.prepare('SELECT COUNT(*) as cnt FROM incident_state').get().cnt;
  const dbSize        = db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get();

  res.json({ status: 'ok', activeTasks, faultTasks, openIncidents, dbSizeKb: Math.round((dbSize?.size || 0) / 1024), uptime: Math.floor(process.uptime()), monitorHost: process.env.MONITOR_HOST || 'not-set' });
});

async function archiveLogs() {
  if (!fs.existsSync(LOG_ARCHIVE_DIR)) fs.mkdirSync(LOG_ARCHIVE_DIR, { recursive: true });
  const today = todayIST(), cutoff = istDaysAgoCutoff(0);

  const archiveSets = [
    { category: 'TASK_LOGS',  categories: TASK_CATEGORIES },
    { category: 'ADMIN_LOGS', categories: ADMIN_CATEGORIES },
    { category: 'AUTH_LOGS',  categories: null },
    { category: 'ALL',        categories: null },
  ];

  for (const set of archiveSets) {
    let appLogs = [], auditLogs = [];
    if (set.category === 'AUTH_LOGS') auditLogs = db.prepare('SELECT * FROM audit_logs WHERE created_at >= ? ORDER BY created_at ASC').all(cutoff);
    else if (set.category === 'ALL') { appLogs = db.prepare('SELECT * FROM app_logs WHERE created_at >= ? ORDER BY created_at ASC').all(cutoff); auditLogs = db.prepare('SELECT * FROM audit_logs WHERE created_at >= ? ORDER BY created_at ASC').all(cutoff); }
    else appLogs = db.prepare(`SELECT * FROM app_logs WHERE created_at >= ? AND category IN (${set.categories.map(() => '?').join(',')}) ORDER BY created_at ASC`).all(cutoff, ...set.categories);

    if (appLogs.length === 0 && auditLogs.length === 0) continue;

    const filename = `netwatch-logs-${today}-${set.category.toLowerCase().replace('_', '-')}.json`;
    const filepath = path.join(LOG_ARCHIVE_DIR, filename);

    fs.writeFileSync(filepath, JSON.stringify({ archive_date_ist: today, category: set.category, generated_at_ist: toIST(new Date().toISOString()), app_logs: convertLogsToIST(appLogs), audit_logs: convertLogsToIST(auditLogs) }, null, 2), 'utf8');
    const sizeBytes = fs.statSync(filepath).size;

    const existing = db.prepare('SELECT id FROM log_archives WHERE archive_date=? AND category=?').get(today, set.category);
    if (existing) db.prepare('UPDATE log_archives SET filename=?, filepath=?, size_bytes=?, created_at=datetime(\'now\') WHERE id=?').run(filename, filepath, sizeBytes, existing.id);
    else db.prepare(`INSERT INTO log_archives (id, archive_date, filename, filepath, category, size_bytes) VALUES (?, ?, ?, ?, ?, ?)`).run(uuidv4(), today, filename, filepath, set.category, sizeBytes);
  }
}

module.exports.archiveLogs = archiveLogs;
module.exports = Object.assign(router, { trimAppLogs, trimAuditLogs, archiveLogs });