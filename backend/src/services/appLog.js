// src/services/appLog.js — structured application logger with auto-trim
// Phase 1: timestamps stored as UTC in DB; IST conversion at API layer.
// Log categories aligned with Phase 1 spec:
//   TASK      — monitoring task checks, fault/recovery/manual run/email events
//   ADMIN     — task CRUD, email toggle, activate/deactivate, backup, settings
//   AUTH      — login/logout/auth events; actor = 'admin' or actual username
//   SYSTEM    — scheduler/internal events
//   EMAIL     — mail send/fail events
//   BACKUP    — import/export events

const db = require('../db');
const { v4: uuidv4 } = require('uuid');

// Lazy-load to avoid circular dependency (logsController → appLog → logsController)
let _trimAppLogs   = null;
let _trimAuditLogs = null;

function getTrimFns() {
  if (!_trimAppLogs) {
    const lc = require('../controllers/logsController');
    _trimAppLogs   = lc.trimAppLogs;
    _trimAuditLogs = lc.trimAuditLogs;
  }
}

/**
 * Write a structured event to app_logs, then trim if needed.
 * Never throws — falls back to console on error.
 *
 * @param {'INFO'|'WARN'|'ERROR'} level
 * @param {string} category   One of: TASK, ADMIN, AUTH, SYSTEM, EMAIL, BACKUP
 * @param {string} actor      Username or 'system'/'scheduler'
 * @param {string|null} taskId
 * @param {string} message
 * @param {string|null} detail
 */
function log(level, category, actor, taskId, message, detail = null) {
  try {
    let taskName = null;
    if (taskId) {
      const t = db.prepare('SELECT name FROM tasks WHERE id=?').get(taskId);
      taskName = t ? t.name : null;
    }
    db.prepare(`
      INSERT INTO app_logs (id, level, category, actor, task_id, task_name, message, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(), level, category, actor || 'system',
      taskId || null, taskName, message, detail || null
    );

    try { getTrimFns(); _trimAppLogs && _trimAppLogs(); } catch {}
  } catch (err) {
    console.error('[AppLog FALLBACK]', level, category, message, err.message);
  }
}

/**
 * Write to audit_logs (AUTH category events).
 * actor should be the actual username or 'admin'.
 */
function audit(actor, action, detail = null) {
  try {
    db.prepare(`
      INSERT INTO audit_logs (id, actor, action, detail) VALUES (?, ?, ?, ?)
    `).run(uuidv4(), actor, action, detail);

    try { getTrimFns(); _trimAuditLogs && _trimAuditLogs(); } catch {}
  } catch (err) {
    console.error('[AuditLog FALLBACK]', actor, action, err.message);
  }
}

module.exports = { log, audit };
