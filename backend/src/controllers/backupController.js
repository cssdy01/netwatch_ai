// src/controllers/backupController.js
const { Router } = require('express');
const ExcelJS    = require('exceljs');
const multer     = require('multer');
const { v4: uuidv4 } = require('uuid');
const db         = require('../db');
const { requireAuth } = require('../middleware/auth');
const { log } = require('../services/appLog');
const { MIN_INTERVAL_MIN, MAX_INTERVAL_MIN, MIN_N_THRESHOLD, MAX_N_THRESHOLD, isValidIpv4 } = require('../middleware/validateTask');

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function todayIST() {
  return new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
}

function nowISTLabel() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', hour12: false,
  }).replace(/\//g, '-') + ' IST';
}

const headerStyle = {
  font: { bold: true, color: { argb: 'FFFFFFFF' } },
  fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1e293b' } },
  alignment: { horizontal: 'center' },
  border: { bottom: { style: 'thin', color: { argb: 'FF64748b' } } },
};

// ── EXPORT ───────────────────────────────────────────────────────────────────

router.get('/export', requireAuth, async (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY name').all();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NetWatch Monitor';

  const pingSheet = wb.addWorksheet('Ping Tasks');
  pingSheet.columns = [
    { header: 'Name',           key: 'name',          width: 28 },
    { header: 'Target IP/Host', key: 'target',        width: 22 },
    { header: 'OS Type',        key: 'os_type',       width: 12 },
    { header: 'Interval (min)', key: 'interval_min',  width: 14 },
    { header: 'N Threshold',    key: 'n_threshold',   width: 13 },
    { header: 'L2 Delay (min)', key: 'l2_delay_min',  width: 15 },
    { header: 'L3 Repeat (min)',key: 'l3_repeat_min', width: 15 },
    { header: 'Email L1',       key: 'email_l1',      width: 35 },
    { header: 'Email L2',       key: 'email_l2',      width: 35 },
    { header: 'Email L3',       key: 'email_l3',      width: 35 },
    { header: 'Email Enabled',  key: 'email_enabled', width: 14 },
    { header: 'Status',         key: 'status',        width: 10 },
    { header: 'Last Checked',   key: 'last_checked',  width: 22 },
  ];
  pingSheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));
  tasks.filter(t => t.type === 'PING').forEach(t => pingSheet.addRow({ ...t, email_enabled: t.email_enabled ? 'Yes' : 'No' }));

  const appSheet = wb.addWorksheet('Application Tasks');
  appSheet.columns = [
    { header: 'Name',                    key: 'name',                   width: 28 },
    { header: 'Server IP',               key: 'target',                 width: 18 },
    { header: 'URL',                     key: 'url',                    width: 50 },
    { header: 'Expected Status',         key: 'expected_status',        width: 16 },
    { header: 'Timeout Sec',             key: 'timeout_sec',            width: 14 },
    { header: 'Interval (min)',          key: 'interval_min',           width: 14 },
    { header: 'N Threshold',             key: 'n_threshold',            width: 13 },
    { header: 'L2 Delay (min)',          key: 'l2_delay_min',           width: 15 },
    { header: 'L3 Repeat (min)',         key: 'l3_repeat_min',          width: 15 },
    { header: 'Email L1',               key: 'email_l1',               width: 35 },
    { header: 'Email L2',               key: 'email_l2',               width: 35 },
    { header: 'Email L3',               key: 'email_l3',               width: 35 },
    { header: 'Email Enabled',          key: 'email_enabled',          width: 14 },
    { header: 'Host Mapping Enabled',   key: 'host_mapping_enabled',   width: 20 },
    { header: 'Host Mapping Hostname',  key: 'host_mapping_hostname',  width: 30 },
    { header: 'Host Mapping IP',        key: 'host_mapping_ip',        width: 18 },
    { header: 'Status',                 key: 'status',                 width: 10 },
    { header: 'Last Checked',           key: 'last_checked',           width: 22 },
  ];
  appSheet.getRow(1).eachCell(cell => Object.assign(cell, headerStyle));
  tasks.filter(t => t.type === 'APPLICATION').forEach(t =>
    appSheet.addRow({
      ...t,
      email_enabled:         t.email_enabled ? 'Yes' : 'No',
      host_mapping_enabled:  t.host_mapping_enabled ? 'Yes' : 'No',
    })
  );

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="netwatch-backup-${todayIST()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ── IMPORT PREVIEW ───────────────────────────────────────────────────────────

router.post('/import-preview', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(req.file.buffer); }
  catch { return res.status(400).json({ error: 'Invalid Excel file' }); }

  const DEFAULT_N = parseInt(process.env.DEFAULT_N_THRESHOLD || '2');
  const preview = {
    ping:        { toInsert: [], toUpdate: [], invalid: [] },
    application: { toInsert: [], toUpdate: [], invalid: [] },
  };

  const pingSheet = wb.getWorksheet('Ping Tasks');
  if (pingSheet) {
    pingSheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
      if (rowNum === 1) return;
      const name      = String(row.getCell(1).value || '').trim();
      const target    = String(row.getCell(2).value || '').trim();
      const os_type   = String(row.getCell(3).value || 'Linux').trim();
      const interval  = parseInt(row.getCell(4).value) || 5;
      const threshold = parseInt(row.getCell(5).value) || DEFAULT_N;
      const l2_delay  = parseInt(row.getCell(6).value) || 2880;
      const l3_repeat = parseInt(row.getCell(7).value) || 2880;
      const email_l1  = String(row.getCell(8).value || '').trim();
      const email_l2  = String(row.getCell(9).value || '').trim();
      const email_l3  = String(row.getCell(10).value || '').trim();
      const emailEn   = String(row.getCell(11).value || 'Yes').toLowerCase() !== 'no' ? 1 : 0;

      const errs = [];
      if (!name) errs.push('Name is required');
      if (!target) errs.push('Target is required');
      if (interval < MIN_INTERVAL_MIN || interval > MAX_INTERVAL_MIN) errs.push(`Interval must be ${MIN_INTERVAL_MIN}-${MAX_INTERVAL_MIN} min`);
      if (threshold < MIN_N_THRESHOLD || threshold > MAX_N_THRESHOLD) errs.push(`N Threshold must be ${MIN_N_THRESHOLD}-${MAX_N_THRESHOLD}`);

      if (errs.length) { preview.ping.invalid.push({ row: rowNum, name: name || '(blank)', errors: errs }); return; }

      const existing = db.prepare("SELECT id FROM tasks WHERE name=? AND type='PING' AND deleted_at IS NULL").get(name);
      const record = { name, target, os_type, interval_min: interval, n_threshold: threshold, l2_delay_min: l2_delay, l3_repeat_min: l3_repeat, email_l1, email_l2, email_l3, email_enabled: emailEn };
      if (existing) preview.ping.toUpdate.push({ ...record, id: existing.id }); else preview.ping.toInsert.push(record);
    });
  }

  const appSheet = wb.getWorksheet('Application Tasks');
  if (appSheet) {
    appSheet.eachRow({ includeEmpty: false }, (row, rowNum) => {
      if (rowNum === 1) return;
      const name            = String(row.getCell(1).value || '').trim();
      const target          = String(row.getCell(2).value || '').trim();
      const url             = String(row.getCell(3).value || '').trim();
      const expStatusRaw    = row.getCell(4).value;
      const expected_status = expStatusRaw ? parseInt(expStatusRaw) : null;
      const timeout_sec     = parseInt(row.getCell(5).value) || 15;
      const interval        = parseInt(row.getCell(6).value) || 5;
      const threshold       = parseInt(row.getCell(7).value) || DEFAULT_N;
      const l2_delay        = parseInt(row.getCell(8).value) || 2880;
      const l3_repeat       = parseInt(row.getCell(9).value) || 2880;
      const email_l1        = String(row.getCell(10).value || '').trim();
      const email_l2        = String(row.getCell(11).value || '').trim();
      const email_l3        = String(row.getCell(12).value || '').trim();
      const emailEn         = String(row.getCell(13).value || 'Yes').toLowerCase() !== 'no' ? 1 : 0;
      const hmEnabledRaw    = String(row.getCell(14).value || 'No').toLowerCase();
      const hmEnabled       = (hmEnabledRaw === 'yes' || hmEnabledRaw === '1' || hmEnabledRaw === 'true') ? 1 : 0;
      const hmHostname      = String(row.getCell(15).value || '').trim();
      const hmIp            = String(row.getCell(16).value || '').trim();

      const errs = [];
      if (!name) errs.push('Name is required');
      if (!target) errs.push('Target is required');
      if (!url || !url.startsWith('http')) errs.push('URL is required and must start with http/https');
      if (interval < MIN_INTERVAL_MIN || interval > MAX_INTERVAL_MIN) errs.push(`Interval must be ${MIN_INTERVAL_MIN}-${MAX_INTERVAL_MIN} min`);
      
      if (hmEnabled) {
        if (!hmHostname) errs.push('Host mapping enabled but hostname missing');
        if (!hmIp) errs.push('Host mapping enabled but IP missing');
        else if (!isValidIpv4(hmIp)) errs.push(`Host mapping IP invalid`);
      }

      if (errs.length) { preview.application.invalid.push({ row: rowNum, name: name || '(blank)', errors: errs }); return; }

      const existing = db.prepare("SELECT id FROM tasks WHERE name=? AND type='APPLICATION' AND deleted_at IS NULL").get(name);
      const record = { name, target, url, expected_status, timeout_sec, interval_min: interval, n_threshold: threshold, l2_delay_min: l2_delay, l3_repeat_min: l3_repeat, email_l1, email_l2, email_l3, email_enabled: emailEn, host_mapping_enabled: hmEnabled, host_mapping_hostname: hmHostname, host_mapping_ip: hmIp };
      if (existing) preview.application.toUpdate.push({ ...record, id: existing.id }); else preview.application.toInsert.push(record);
    });
  }

  const sessionId = uuidv4();
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO import_sessions (id, expires_at, preview_json, status) VALUES (?, ?, ?, 'PENDING')`).run(sessionId, expiresAt, JSON.stringify(preview));

  const toIST = v => new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST';

  res.json({
    session_id: sessionId,
    expires_at_ist: toIST(expiresAt),
    ping: {
      to_insert_list: preview.ping.toInsert,
      to_update_list: preview.ping.toUpdate,
      errors: preview.ping.invalid,
    },
    application: {
      to_insert_list: preview.application.toInsert,
      to_update_list: preview.application.toUpdate,
      errors: preview.application.invalid,
    }
  });
});

// ── IMPORT APPLY ─────────────────────────────────────────────────────────────

router.post('/import-apply', requireAuth, (req, res) => {
  const { session_id, action, selected_ping_ids, selected_app_ids } = req.body;
  if (!session_id) return res.status(400).json({ error: 'session_id is required' });

  const session = db.prepare("SELECT * FROM import_sessions WHERE id=? AND status='PENDING'").get(session_id);
  if (!session) return res.status(404).json({ error: 'Session expired or not found' });
  if (action === 'cancel') { db.prepare("UPDATE import_sessions SET status='CANCELLED' WHERE id=?").run(session_id); return res.json({ ok: true }); }

  const preview = JSON.parse(session.preview_json);
  const doInsert = action === 'insert_only' || action === 'insert_and_update';
  const doUpdate = action === 'update_only' || action === 'insert_and_update';

  if (selected_ping_ids) {
    preview.ping.toInsert = preview.ping.toInsert.filter(r => selected_ping_ids.includes(r.name));
    preview.ping.toUpdate = preview.ping.toUpdate.filter(r => selected_ping_ids.includes(r.id));
  }
  if (selected_app_ids) {
    preview.application.toInsert = preview.application.toInsert.filter(r => selected_app_ids.includes(r.name));
    preview.application.toUpdate = preview.application.toUpdate.filter(r => selected_app_ids.includes(r.id));
  }

  let inserted = 0, updated = 0;
  const applyAll = db.transaction(() => {
    if (doInsert) {
      for (const r of preview.ping.toInsert) {
        db.prepare(`INSERT INTO tasks (id,name,type,target,os_type,is_vm,interval_min,n_threshold,l2_delay_min,l3_repeat_min,email_l1,email_l2,email_l3,email_enabled,is_active) VALUES (?,?,?,?,?,0,?,?,?,?,?,?,?,?,0)`).run(uuidv4(), r.name, 'PING', r.target, r.os_type||'Linux', r.interval_min, r.n_threshold, r.l2_delay_min, r.l3_repeat_min, r.email_l1, r.email_l2, r.email_l3, r.email_enabled);
        inserted++;
      }
      for (const r of preview.application.toInsert) {
        db.prepare(`INSERT INTO tasks (id,name,type,target,url,expected_status,timeout_sec,is_vm,interval_min,n_threshold,l2_delay_min,l3_repeat_min,email_l1,email_l2,email_l3,email_enabled,host_mapping_enabled,host_mapping_hostname,host_mapping_ip,is_active) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?,0)`).run(uuidv4(), r.name, 'APPLICATION', r.target, r.url, r.expected_status, r.timeout_sec, r.interval_min, r.n_threshold, r.l2_delay_min, r.l3_repeat_min, r.email_l1, r.email_l2, r.email_l3, r.email_enabled, r.host_mapping_enabled, r.host_mapping_hostname, r.host_mapping_ip);
        inserted++;
      }
    }
    if (doUpdate) {
      for (const r of preview.ping.toUpdate) {
        db.prepare(`UPDATE tasks SET target=?,os_type=?,interval_min=?,n_threshold=?,l2_delay_min=?,l3_repeat_min=?,email_l1=?,email_l2=?,email_l3=?,email_enabled=?,updated_at=datetime('now') WHERE id=?`).run(r.target, r.os_type||'Linux', r.interval_min, r.n_threshold, r.l2_delay_min, r.l3_repeat_min, r.email_l1, r.email_l2, r.email_l3, r.email_enabled, r.id);
        updated++;
      }
      for (const r of preview.application.toUpdate) {
        db.prepare(`UPDATE tasks SET target=?,url=?,expected_status=?,timeout_sec=?,interval_min=?,n_threshold=?,l2_delay_min=?,l3_repeat_min=?,email_l1=?,email_l2=?,email_l3=?,email_enabled=?,host_mapping_enabled=?,host_mapping_hostname=?,host_mapping_ip=?,updated_at=datetime('now') WHERE id=?`).run(r.target, r.url, r.expected_status, r.timeout_sec, r.interval_min, r.n_threshold, r.l2_delay_min, r.l3_repeat_min, r.email_l1, r.email_l2, r.email_l3, r.email_enabled, r.host_mapping_enabled, r.host_mapping_hostname, r.host_mapping_ip, r.id);
        updated++;
      }
    }
    db.prepare("UPDATE import_sessions SET status='APPLIED' WHERE id=?").run(session_id);
  });

  try { applyAll(); } catch (e) { return res.status(500).json({ error: `Transaction failed: ${e.message}` }); }
  res.json({ ok: true, inserted, updated });
});

module.exports = router;