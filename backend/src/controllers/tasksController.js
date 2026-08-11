// src/controllers/tasksController.js
const { Router } = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { validateTask } = require('../middleware/validateTask');
const { log } = require('../services/appLog');
const { manualRun, testTask } = require('../services/monitoringService');

const router = Router();

// ── Helper ─────────────────────────────────────────────────────────────────────

function enrichTask(task) {
  const incident = db.prepare('SELECT * FROM incident_state WHERE task_id=?').get(task.id);
  const lastCheck = db.prepare(`
    SELECT result, response_ms, error_raw, endpoint_results, checked_at
    FROM checks WHERE task_id=? ORDER BY checked_at DESC LIMIT 1
  `).get(task.id);

  let incidentDuration = null;
  if (incident) {
    const ms = Date.now() - new Date(incident.t0).getTime();
    const h  = Math.floor(ms / 3600000);
    const m  = Math.floor((ms % 3600000) / 60000);
    incidentDuration = h ? `${h}h ${m}m` : `${m}m`;
  }

  return {
    ...task,
    email_enabled:         task.email_enabled === 1,
    is_vm:                 task.is_vm === 1,
    is_active:             task.is_active !== 0,
    host_mapping_enabled:  task.host_mapping_enabled === 1,
    host_mapping_hostname: task.host_mapping_hostname || '',
    host_mapping_ip:       task.host_mapping_ip       || '',
    last_result:           lastCheck?.result       || null,
    last_response_ms:      lastCheck?.response_ms  || null,
    last_error_raw:        lastCheck?.error_raw    || null,
    last_endpoint_results: lastCheck?.endpoint_results ? JSON.parse(lastCheck.endpoint_results) : null,
    last_checked_at:       lastCheck?.checked_at   || null,
    incident_duration:     incidentDuration,
    t0:                    incident?.t0             || null,
    incident: incident ? {
      t0:           incident.t0,
      l1_sent_at:   incident.l1_sent_at,
      l2_sent_at:   incident.l2_sent_at,
      l3_sent_at:   incident.l3_sent_at,
      alerted_tiers:incident.alerted_tiers,
    } : null,
  };
}

// ── PUBLIC ROUTES — declared BEFORE /:id ──────────────────────────────────────

// GET /api/tasks/public/summary
router.get('/public/summary', (_req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY name').all();
  res.json(tasks.map(t => {
    // Fetch the last 10 checks instead of just 1
    const checks = db.prepare(`
      SELECT result, response_ms, checked_at FROM checks
      WHERE task_id=? ORDER BY checked_at DESC LIMIT 10
    `).all(t.id);
    
    const incident = db.prepare('SELECT t0 FROM incident_state WHERE task_id=?').get(t.id);
    let incidentDuration = null;
    if (incident) {
      const ms = Date.now() - new Date(incident.t0).getTime();
      const h  = Math.floor(ms / 3600000);
      const m  = Math.floor((ms % 3600000) / 60000);
      incidentDuration = h ? `${h}h ${m}m` : `${m}m`;
    }

    const lastCheck = checks[0] || null;

    return {
      id: t.id, name: t.name, type: t.type, target: t.target,
      status: t.status, last_checked: t.last_checked,
      is_active:         t.is_active !== 0,
      last_result:       lastCheck?.result        || null,
      last_response_ms:  lastCheck?.response_ms   || null,
      incident_duration: incidentDuration,
      // Map the results and reverse them so oldest is first (left to right for the UI candles)
      history:           checks.map(c => c.result).reverse()
    };
  }));
});

// GET /api/tasks/public/:id
router.get('/public/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const checks = db.prepare(`
    SELECT result, response_ms, error_raw, endpoint_results, checked_at
    FROM checks WHERE task_id=? ORDER BY checked_at DESC LIMIT 15
  `).all(task.id);

  const incident = db.prepare('SELECT * FROM incident_state WHERE task_id=?').get(task.id);

  let incidentDuration = null;
  if (incident) {
    const ms = Date.now() - new Date(incident.t0).getTime();
    const h  = Math.floor(ms / 3600000);
    const m  = Math.floor((ms % 3600000) / 60000);
    incidentDuration = h ? `${h}h ${m}m` : `${m}m`;
  }

  const lastCheck = checks[0] || null;

  res.json({
    id: task.id, name: task.name, type: task.type, target: task.target,
    os_type:   task.os_type,
    status:    task.status,
    is_active: task.is_active !== 0,
    url:             task.url,
    expected_status: task.expected_status,
    timeout_sec:     task.timeout_sec,
    host_mapping_enabled:  task.host_mapping_enabled === 1,
    host_mapping_hostname: task.host_mapping_hostname || '',
    host_mapping_ip:       task.host_mapping_ip       || '',
    last_result:           lastCheck?.result        || null,
    last_response_ms:      lastCheck?.response_ms   || null,
    last_error_raw:        lastCheck?.error_raw     || null,
    last_endpoint_results: lastCheck?.endpoint_results ? JSON.parse(lastCheck.endpoint_results) : null,
    last_checked_at:       lastCheck?.checked_at    || null,
    incident_duration:     incidentDuration,
    t0:        incident?.t0 || null,
    incident:  incident ? {
      t0:            incident.t0,
      l1_sent_at:    incident.l1_sent_at,
      l2_sent_at:    incident.l2_sent_at,
      l3_sent_at:    incident.l3_sent_at,
      alerted_tiers: incident.alerted_tiers,
    } : null,
    checks: checks.map(c => ({
      ...c,
      endpoint_results: c.endpoint_results ? JSON.parse(c.endpoint_results) : null,
    })),
  });
});

// POST /api/tasks/test
router.post('/test', requireAuth, async (req, res) => {
  try {
    const result = await testTask(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AUTHENTICATED ROUTES ───────────────────────────────────────────────────────

// GET /api/tasks
router.get('/', requireAuth, (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY name').all();
  res.json(tasks.map(enrichTask));
});

// GET /api/tasks/bin
router.get('/bin', requireAuth, (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all();
  res.json(tasks.map(enrichTask));
});

// GET /api/tasks/:id
router.get('/:id', requireAuth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const checks = db.prepare(`
    SELECT * FROM checks WHERE task_id=? ORDER BY checked_at DESC LIMIT 100
  `).all(task.id);

  const incident  = db.prepare('SELECT * FROM incident_state WHERE task_id=?').get(task.id);
  const faultStats = db.prepare(`
    SELECT date(checked_at) as day, COUNT(*) as faults
    FROM checks
    WHERE task_id=? AND result='FAIL' AND checked_at >= datetime('now', '-30 days')
    GROUP BY day ORDER BY day
  `).all(task.id);

  res.json({
    ...enrichTask(task),
    checks: checks.map(c => ({
      ...c,
      endpoint_results: c.endpoint_results ? JSON.parse(c.endpoint_results) : null,
    })),
    incident,
    fault_stats: faultStats,
  });
});

// ── Helper: parse host mapping fields from request body ─────────────────────────

function parseHostMapping(body, type) {
  if (type !== 'APPLICATION') {
    return { host_mapping_enabled: 0, host_mapping_hostname: '', host_mapping_ip: '' };
  }
  const raw = body.host_mapping_enabled;
  const enabled = (raw === true || raw === 1 || raw === '1' || raw === 'true') ? 1 : 0;
  return {
    host_mapping_enabled:  enabled,
    host_mapping_hostname: enabled ? String(body.host_mapping_hostname || '').trim() : '',
    host_mapping_ip:       enabled ? String(body.host_mapping_ip       || '').trim() : '',
  };
}

// POST /api/tasks — CREATE
router.post('/', requireAuth, validateTask, (req, res) => {
  const {
    name, type, target, url, expected_status, timeout_sec, os_type, is_vm,
    interval_min, n_threshold, l2_delay_min, l3_repeat_min,
    email_l1, email_l2, email_l3, email_enabled, is_active,
  } = req.body;

  const DEFAULT_N = parseInt(process.env.DEFAULT_N_THRESHOLD || '2');
  const id = uuidv4();
  const hm = parseHostMapping(req.body, type);

  db.prepare(`
    INSERT INTO tasks (
      id, name, type, target, url, expected_status, timeout_sec, os_type, is_vm,
      interval_min, n_threshold, l2_delay_min, l3_repeat_min,
      email_l1, email_l2, email_l3, email_enabled, is_active,
      host_mapping_enabled, host_mapping_hostname, host_mapping_ip
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, name.trim(), type, target.trim(), url ? url.trim() : '', 
    expected_status ? parseInt(expected_status) : null, 
    timeout_sec ? parseInt(timeout_sec) : 15, 
    os_type || null, is_vm ? 1 : 0,
    parseInt(interval_min), n_threshold ? parseInt(n_threshold) : DEFAULT_N,
    parseInt(l2_delay_min), parseInt(l3_repeat_min),
    email_l1 || '', email_l2 || '', email_l3 || '',
    email_enabled === false || email_enabled === 0 ? 0 : 1,
    is_active === false || is_active === 0 ? 0 : 1,
    hm.host_mapping_enabled, hm.host_mapping_hostname, hm.host_mapping_ip
  );

  const created = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  log('INFO', 'ADMIN', req.user.username, id, `Task "${name}" created`, null);
  res.status(201).json(enrichTask(created));
});

// PUT /api/tasks/:id — UPDATE
router.put('/:id', requireAuth, validateTask, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const {
    name, type, target, url, expected_status, timeout_sec, os_type, is_vm,
    interval_min, n_threshold, l2_delay_min, l3_repeat_min,
    email_l1, email_l2, email_l3, email_enabled, is_active,
  } = req.body;

  const DEFAULT_N = parseInt(process.env.DEFAULT_N_THRESHOLD || '2');
  const hm = parseHostMapping(req.body, type);

  db.prepare(`
    UPDATE tasks SET
      name=?, type=?, target=?, url=?, expected_status=?, timeout_sec=?, os_type=?, is_vm=?,
      interval_min=?, n_threshold=?, l2_delay_min=?, l3_repeat_min=?,
      email_l1=?, email_l2=?, email_l3=?, email_enabled=?, is_active=?,
      host_mapping_enabled=?, host_mapping_hostname=?, host_mapping_ip=?,
      updated_at=datetime('now')
    WHERE id=?
  `).run(
    name.trim(), type, target.trim(), url ? url.trim() : '', 
    expected_status ? parseInt(expected_status) : null, 
    timeout_sec ? parseInt(timeout_sec) : 15, 
    os_type || null, is_vm ? 1 : 0,
    parseInt(interval_min), n_threshold ? parseInt(n_threshold) : DEFAULT_N,
    parseInt(l2_delay_min), parseInt(l3_repeat_min),
    email_l1 || '', email_l2 || '', email_l3 || '',
    email_enabled === false || email_enabled === 0 ? 0 : 1,
    is_active  === false || is_active  === 0 ? 0 : 1,
    hm.host_mapping_enabled, hm.host_mapping_hostname, hm.host_mapping_ip,
    req.params.id
  );

  log('INFO', 'ADMIN', req.user.username, req.params.id, `Task "${name}" updated`, null);
  const updated = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  res.json(enrichTask(updated));
});

// DELETE /api/tasks/:id (soft delete → Recycle Bin)
router.delete('/:id', requireAuth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  db.prepare(`UPDATE tasks SET deleted_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
    .run(req.params.id);
  log('INFO', 'ADMIN', req.user.username, task.id, `Task "${task.name}" moved to bin`, null);
  res.json({ ok: true });
});

// POST /api/tasks/:id/restore
router.post('/:id/restore', requireAuth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND deleted_at IS NOT NULL').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found in bin' });

  db.prepare(`UPDATE tasks SET deleted_at=NULL, updated_at=datetime('now') WHERE id=?`)
    .run(req.params.id);
  log('INFO', 'ADMIN', req.user.username, task.id, `Task "${task.name}" restored`, null);
  res.json({ ok: true });
});

// DELETE /api/tasks/:id/hard (permanent)
router.delete('/:id/hard', requireAuth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  db.prepare('DELETE FROM tasks WHERE id=?').run(req.params.id);
  log('INFO', 'ADMIN', req.user.username, null, `Task "${task.name}" permanently deleted`, null);
  res.json({ ok: true });
});

// POST /api/tasks/:id/run (manual run)
router.post('/:id/run', requireAuth, async (req, res) => {
  try {
    const result = await manualRun(req.params.id, req.user.username);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/tasks/:id/email-toggle
router.patch('/:id/email-toggle', requireAuth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const newVal = task.email_enabled === 1 ? 0 : 1;
  db.prepare(`UPDATE tasks SET email_enabled=?, updated_at=datetime('now') WHERE id=?`)
    .run(newVal, task.id);

  log('INFO', 'ADMIN', req.user.username, task.id,
    `Email ${newVal ? 'enabled' : 'disabled'} for "${task.name}"`, null);
  
  res.json({ email_enabled: newVal === 1 });
});

// PATCH /api/tasks/:id/active-toggle
router.patch('/:id/active-toggle', requireAuth, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const newVal = (task.is_active === 0 || task.is_active === false) ? 1 : 0;
  db.prepare(`UPDATE tasks SET is_active=?, updated_at=datetime('now') WHERE id=?`)
    .run(newVal, task.id);

  if (newVal === 0) {
    db.prepare('DELETE FROM incident_state WHERE task_id=?').run(task.id);
    db.prepare(`UPDATE tasks SET cfc=0, status='OK', updated_at=datetime('now') WHERE id=?`).run(task.id);
  }

  log('INFO', 'ADMIN', req.user.username, task.id,
    `Task "${task.name}" ${newVal ? 'activated' : 'deactivated (paused)'}`, null);
  
  res.json({ is_active: newVal === 1 });
});

module.exports = router;