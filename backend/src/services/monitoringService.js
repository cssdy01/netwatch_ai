// src/services/monitoringService.js
// Monitoring state machine and escalation policy.
// Phase 1 changes:
//   - MIN_INTERVAL_MIN updated to 3 (was 5); MAX_INTERVAL_MIN enforced at 15
//   - IST timestamps used for all log messages and email data
//   - is_vm field no longer required or enforced for Ping tasks

const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { log } = require('./appLog');
const pingAgent = require('../agents/pingAgent');
const webAgent  = require('../agents/webAgent');
const mailService = require('../mail/mailService');

const DEFAULT_N        = parseInt(process.env.DEFAULT_N_THRESHOLD || '2');
const POLL_CYCLE_CRON  = process.env.POLL_CYCLE_CRON || '*/3 * * * *'; // check every 3 minutes
const MIN_INTERVAL_MIN = parseInt(process.env.MIN_MONITOR_INTERVAL_MIN || '3');
const MAX_INTERVAL_MIN = parseInt(process.env.MAX_MONITOR_INTERVAL_MIN || '15');
const L2_DELAY_MS      = 48 * 60 * 60 * 1000;
const L3_REPEAT_MS     = 48 * 60 * 60 * 1000;

// L1 cooldown: minimum time between L1 alerts for the same incident.
const L1_COOLDOWN_MS = parseInt(process.env.L1_COOLDOWN_MIN || '60') * 60 * 1000;

let schedulersStarted   = false;
let pollRunning         = false;
let escalationRunning   = false;

async function dispatchAgent(task) {
  if (task.type === 'PING')        return pingAgent.run(task);
  if (task.type === 'APPLICATION') return webAgent.run(task);
  throw new Error(`Unknown task type: ${task.type}`);
}

function nowIso() {
  return new Date().toISOString();
}

function appendTier(existing, tier) {
  const set = new Set(String(existing || '').split(',').map(x => x.trim()).filter(Boolean));
  set.add(tier);
  return [...set].join(',');
}

async function processResult(task, agentResult) {
  const { result, responseMs, errorRaw, endpointResults } = agentResult;
  const checkedAt = nowIso();

  db.prepare(`
    INSERT INTO checks (id, task_id, checked_at, result, response_ms, error_raw, endpoint_results)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(), task.id, checkedAt, result,
    responseMs ?? null, errorRaw ?? null,
    endpointResults ? JSON.stringify(endpointResults) : null
  );

  const current = db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id);
  if (!current || current.deleted_at || current.is_active === 0) return agentResult;

  const prevStatus = current.status || 'OK';
  const prevCfc    = current.cfc    || 0;
  let newCfc    = prevCfc;
  let newStatus = prevStatus;

  if (result === 'PASS') {
    newCfc = 0;
    if (prevStatus === 'FAULT') {
      newStatus = 'OK';
      log('INFO', 'TASK', 'scheduler', current.id,
        `"${current.name}" FAULT → OK`, null);
      await handleRecovery(current);
    }
  } else {
    newCfc = prevCfc + 1;
    const threshold = current.n_threshold || DEFAULT_N;

    if (newCfc < threshold) {
      log('WARN', 'TASK', 'scheduler', current.id,
        `"${current.name}" failure ${newCfc}/${threshold} — below alert threshold`, errorRaw || null);
    } else if (prevStatus !== 'FAULT') {
      newStatus = 'FAULT';
      log('INFO', 'TASK', 'scheduler', current.id,
        `"${current.name}" OK → FAULT (CFC=${newCfc})`, errorRaw || null);
      await handleFaultStart(current, errorRaw);
    }
    // Task already in FAULT — escalation handles L2/L3.
  }

  db.prepare(`
    UPDATE tasks SET status=?, cfc=?, last_checked=?, updated_at=? WHERE id=?
  `).run(newStatus, newCfc, checkedAt, checkedAt, current.id);

  return { ...agentResult, newStatus, newCfc };
}

async function handleFaultStart(task, errorRaw) {
  const now = nowIso();

  // Guard: never open a second incident for the same task
  const existing = db.prepare('SELECT id FROM incident_state WHERE task_id=?').get(task.id);
  if (existing) {
    log('WARN', 'EMAIL', 'scheduler', task.id,
      `L1 skipped — incident already open for "${task.name}"`, null);
    return;
  }

  db.prepare(`
    INSERT INTO incident_state (id, task_id, t0, was_alerted, alerted_tiers)
    VALUES (?, ?, ?, 0, '')
  `).run(uuidv4(), task.id, now);

  const emailOn = task.email_enabled && task.email_enabled !== 0;
  if (!emailOn) {
    log('WARN', 'EMAIL', 'scheduler', task.id,
      `L1 skipped — email disabled for "${task.name}"`, null);
    return;
  }

  const incident = db.prepare('SELECT * FROM incident_state WHERE task_id=?').get(task.id);

  if (incident && incident.l1_sent_at) {
    const age = Date.now() - new Date(incident.l1_sent_at).getTime();
    if (age < L1_COOLDOWN_MS) {
      log('WARN', 'EMAIL', 'scheduler', task.id,
        `L1 suppressed for "${task.name}" — previous L1 was ${Math.round(age / 60000)}m ago (cooldown: ${Math.round(L1_COOLDOWN_MS / 60000)}m)`, null);
      return;
    }
  }

  try {
    const sent = await mailService.sendAlert({ task, incidentState: incident || { t0: now }, tier: 'L1', errorRaw });
    if (sent) {
      db.prepare(`
        UPDATE incident_state SET l1_sent_at=?, was_alerted=1, alerted_tiers=? WHERE task_id=?
      `).run(now, appendTier(incident ? incident.alerted_tiers : '', 'L1'), task.id);
    }
  } catch (err) {
    log('ERROR', 'EMAIL', 'scheduler', task.id,
      `L1 mail FAILED for "${task.name}": ${err.message}`, err.stack);
  }
}

async function handleRecovery(task) {
  const incident = db.prepare('SELECT * FROM incident_state WHERE task_id=?').get(task.id);
  if (!incident) return;

  const emailOn = task.email_enabled && task.email_enabled !== 0;
  if (emailOn && incident.was_alerted) {
    try {
      await mailService.sendAllClear({ task, t0: incident.t0 });
    } catch (err) {
      log('ERROR', 'EMAIL', 'scheduler', task.id,
        `All Clear mail FAILED for "${task.name}": ${err.message}`, err.stack);
    }
  }

  db.prepare('DELETE FROM incident_state WHERE task_id=?').run(task.id);
}

async function runPollCycle() {
  if (pollRunning) {
    log('WARN', 'SYSTEM', 'scheduler', null, 'Poll cycle skipped — previous cycle still running', null);
    return;
  }
  pollRunning = true;

  try {
    const activeTasks = db.prepare(`
      SELECT * FROM tasks WHERE deleted_at IS NULL AND is_active = 1
    `).all();

    const now = Date.now();
    for (const task of activeTasks) {
      // Clamp interval to allowed range
      const rawInterval  = task.interval_min || MIN_INTERVAL_MIN;
      const intervalMin  = Math.min(Math.max(rawInterval, MIN_INTERVAL_MIN), MAX_INTERVAL_MIN);
      const intervalMs   = intervalMin * 60 * 1000;
      const lastChecked  = task.last_checked ? new Date(task.last_checked).getTime() : 0;
      if (now - lastChecked < intervalMs) continue;

      try {
        const agentResult = await dispatchAgent(task);
        await processResult(task, agentResult);
      } catch (err) {
        log('ERROR', 'TASK', 'scheduler', task.id,
          `Agent error for "${task.name}": ${err.message}`, err.stack);
      }
    }
  } finally {
    pollRunning = false;
  }
}

async function runEscalationCheck() {
  if (escalationRunning) {
    log('WARN', 'SYSTEM', 'scheduler', null, 'Escalation cycle skipped — previous cycle still running', null);
    return;
  }
  escalationRunning = true;

  try {
    const rows = db.prepare(`
      SELECT i.task_id
      FROM incident_state i
      JOIN tasks t ON t.id = i.task_id
      WHERE t.deleted_at IS NULL AND t.is_active = 1 AND t.status = 'FAULT'
    `).all();

    for (const row of rows) {
      const inc  = db.prepare('SELECT * FROM incident_state WHERE task_id=?').get(row.task_id);
      const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(row.task_id);
      if (!inc || !task) continue;

      const elapsed = Date.now() - new Date(inc.t0).getTime();
      const emailOn = task.email_enabled && task.email_enabled !== 0;
      const lastError = db.prepare(`SELECT error_raw FROM checks WHERE task_id=? AND result='FAIL' ORDER BY checked_at DESC LIMIT 1`).get(task.id)?.error_raw || 'No error details';

      // Use the task's custom dynamic timings (convert min to MS)
      const dynamicL2Ms = (task.l2_delay_min || 2880) * 60 * 1000;
      const dynamicL3Ms = (task.l3_repeat_min || 2880) * 60 * 1000;

      if (elapsed >= dynamicL2Ms && !inc.l2_sent_at) {
        const sentAt = nowIso();
        if (emailOn) {
          try {
            await mailService.sendAlert({ task, incidentState: inc, tier: 'L2', errorRaw: lastError });
          } catch (err) {
            log('ERROR', 'EMAIL', 'scheduler', task.id,
              `L2 mail FAILED for "${task.name}": ${err.message}`, err.stack);
            continue;
          }
        }
        db.prepare(`
          UPDATE incident_state
          SET l2_sent_at=?, was_alerted=CASE WHEN ? THEN 1 ELSE was_alerted END, alerted_tiers=?
          WHERE task_id=?
        `).run(sentAt, emailOn ? 1 : 0, appendTier(inc.alerted_tiers, 'L2'), task.id);
        log('INFO', 'EMAIL', 'scheduler', task.id,
          `L2 ${emailOn ? 'sent' : 'marked skipped (email off)'} for "${task.name}"`, null);
        continue;
      }

      // L3 every 48h after L2 while unresolved
      const fresh = db.prepare('SELECT * FROM incident_state WHERE task_id=?').get(task.id);
      if (!fresh || !fresh.l2_sent_at) continue;

      const base      = fresh.last_l3_repeat || fresh.l2_sent_at;
      const sinceBase = Date.now() - new Date(base).getTime();
      if (sinceBase >= L3_REPEAT_MS) {
        const sentAt = nowIso();
        if (emailOn) {
          try {
            await mailService.sendAlert({ task, incidentState: fresh, tier: 'L3', errorRaw: lastError });
          } catch (err) {
            log('ERROR', 'EMAIL', 'scheduler', task.id,
              `L3 mail FAILED for "${task.name}": ${err.message}`, err.stack);
            continue;
          }
        }
        db.prepare(`
          UPDATE incident_state
          SET l3_sent_at=COALESCE(l3_sent_at, ?), last_l3_repeat=?,
              was_alerted=CASE WHEN ? THEN 1 ELSE was_alerted END, alerted_tiers=?
          WHERE task_id=?
        `).run(sentAt, sentAt, emailOn ? 1 : 0, appendTier(fresh.alerted_tiers, 'L3'), task.id);
        log('INFO', 'EMAIL', 'scheduler', task.id,
          `L3 repeat ${emailOn ? 'sent' : 'marked skipped (email off)'} for "${task.name}"`, null);
      }
    }
  } finally {
    escalationRunning = false;
  }
}

async function manualRun(taskId, actor) {
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId);
  if (!task) throw new Error('Task not found');
  log('INFO', 'TASK', actor, taskId, `Manual run triggered for "${task.name}" by ${actor}`, null);
  const agentResult = await dispatchAgent(task);
  await processResult(task, agentResult);
  return agentResult;
}

async function testTask(taskData) {
  // Connectivity test only. Records no checks and sends no email.
  return dispatchAgent(taskData);
}

function startSchedulers() {
  if (schedulersStarted) {
    log('WARN', 'SYSTEM', 'system', null, 'Schedulers already started — duplicate start ignored', null);
    return;
  }
  schedulersStarted = true;

  // Enforce interval bounds on all tasks at startup
  const fixedLow  = db.prepare('UPDATE tasks SET interval_min=? WHERE interval_min < ?').run(MIN_INTERVAL_MIN, MIN_INTERVAL_MIN);
  const fixedHigh = db.prepare('UPDATE tasks SET interval_min=? WHERE interval_min > ?').run(MAX_INTERVAL_MIN, MAX_INTERVAL_MIN);
  if (fixedLow.changes + fixedHigh.changes > 0) {
    log('WARN', 'SYSTEM', 'system', null,
      `Fixed ${fixedLow.changes + fixedHigh.changes} task(s) with out-of-range interval`, null);
  }

  cron.schedule(POLL_CYCLE_CRON, async () => {
    try { await runPollCycle(); }
    catch (e) { log('ERROR', 'SYSTEM', 'scheduler', null, `Poll cycle failed: ${e.message}`, e.stack); }
  });

  cron.schedule(POLL_CYCLE_CRON, async () => {
    try { await runEscalationCheck(); }
    catch (e) { log('ERROR', 'SYSTEM', 'scheduler', null, `Escalation cycle failed: ${e.message}`, e.stack); }
  });

  const PRUNE_DAYS = parseInt(process.env.PRUNE_DAYS || '60');
  cron.schedule('0 0 * * *', () => {
    try {
      const cutoff = new Date(Date.now() - PRUNE_DAYS * 86400000).toISOString();
      const c1 = db.prepare('DELETE FROM checks WHERE checked_at < ?').run(cutoff);
      const c2 = db.prepare('DELETE FROM app_logs WHERE created_at < ?').run(cutoff);
      const c3 = db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff);
      log('INFO', 'SYSTEM', 'scheduler', null,
        `Pruner: ${c1.changes} checks, ${c2.changes} app_logs, ${c3.changes} audit_logs removed`, null);
    } catch (e) {
      log('ERROR', 'SYSTEM', 'scheduler', null, `Pruner failed: ${e.message}`, e.stack);
    }
  });

  // End-of-day archive job: runs at 23:58 IST every day
  // IST = UTC+5:30, so 23:58 IST = 18:28 UTC
  cron.schedule('28 18 * * *', async () => {
    try {
      const { archiveLogs } = require('../controllers/logsController');
      await archiveLogs();
    } catch (e) {
      log('ERROR', 'SYSTEM', 'scheduler', null, `Log archive job failed: ${e.message}`, e.stack);
    }
  });

  log('INFO', 'SYSTEM', 'system', null,
    `Schedulers started — poll:${POLL_CYCLE_CRON} interval:${MIN_INTERVAL_MIN}–${MAX_INTERVAL_MIN}m L1cooldown:${Math.round(L1_COOLDOWN_MS/60000)}m L2:48h L3:every48h`, null);
}

module.exports = {
  startSchedulers,
  manualRun,
  testTask,
  runPollCycle,
  runEscalationCheck,
};
