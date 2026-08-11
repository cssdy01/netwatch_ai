// PostgreSQL synchronous-compatibility adapter for the existing NetWatch codebase.
// Database I/O runs in a worker thread so existing better-sqlite3 call sites remain unchanged.
const { isMainThread, parentPort, workerData, Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');

if (!isMainThread) {
  const { Pool } = require('pg');
  const pool = new Pool(workerData.config);
  let txClient = null;
  const port = workerData.port;

  function translate(sql) {
    let s = String(sql).trim();
    if (/pragma_page_count\(\).*pragma_page_size\(\)/i.test(s)) return 'SELECT pg_database_size(current_database()) AS size';
    s = s.replace(/datetime\('now'\s*,\s*'-30 days'\)/gi, "(CURRENT_TIMESTAMP - INTERVAL '30 days')");
    s = s.replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP');
    s = s.replace(/date\(checked_at\)/gi, 'DATE(checked_at)');
    let out = '', n = 0, quote = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quote) {
        out += c;
        if (c === quote && s[i - 1] !== '\\') quote = null;
      } else if (c === "'" || c === '"') {
        quote = c; out += c;
      } else if (c === '?') {
        out += '$' + (++n);
      } else out += c;
    }
    return out;
  }

  async function execute(msg) {
    const client = txClient || pool;
    if (msg.op === 'ping') return { ok: true };
    if (msg.op === 'begin') { txClient = await pool.connect(); await txClient.query('BEGIN'); return { ok: true }; }
    if (msg.op === 'commit') { await txClient.query('COMMIT'); txClient.release(); txClient = null; return { ok: true }; }
    if (msg.op === 'rollback') { if (txClient) { await txClient.query('ROLLBACK'); txClient.release(); txClient = null; } return { ok: true }; }
    if (msg.op === 'close') { await pool.end(); return { ok: true }; }
    if (msg.op === 'ai-select') {
      const c = await pool.connect();
      try {
        await c.query('BEGIN READ ONLY');
        await c.query(`SET LOCAL statement_timeout = '${Math.max(100, Math.min(Number(msg.timeoutMs || 5000), 30000))}ms'`);
        await c.query(`SET LOCAL lock_timeout = '${Math.max(100, Math.min(Number(msg.lockTimeoutMs || 1000), 5000))}ms'`);
        const result = await c.query(String(msg.sql), msg.params || []);
        await c.query('COMMIT');
        return { rows: result.rows, rowCount: result.rowCount || result.rows.length, fields: result.fields.map(f => f.name) };
      } catch (error) { try { await c.query('ROLLBACK'); } catch {} throw error; }
      finally { c.release(); }
    }
    const result = await client.query(translate(msg.sql), msg.params || []);
    if (msg.op === 'get') return result.rows[0] || undefined;
    if (msg.op === 'all') return result.rows;
    if (msg.op === 'run') return { changes: result.rowCount || 0 };
    return { changes: result.rowCount || 0, rows: result.rows || [] };
  }

  port.on('message', async msg => {
    try { port.postMessage({ id: msg.id, value: await execute(msg) }); }
    catch (error) { port.postMessage({ id: msg.id, error: { message: error.message, code: error.code, detail: error.detail, stack: error.stack } }); }
  });
  port.start();
} else {
  const fs = require('fs');
  const path = require('path');
  const DATA_DIR = process.env.DATA_DIR || '/app/data';
  const LOG_ARCHIVE_DIR = process.env.LOG_ARCHIVE_DIR || path.join(DATA_DIR, 'log-archives');
  fs.mkdirSync(LOG_ARCHIVE_DIR, { recursive: true });

  const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
  for (const key of required) if (!process.env[key]) throw new Error(`[DB] ${key} is required`);
  const sslEnabled = String(process.env.DB_SSL || 'false').toLowerCase() === 'true';
  const config = {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: parseInt(process.env.DB_POOL_MAX || '10', 10),
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    application_name: 'netwatch-backend',
    ssl: sslEnabled ? { rejectUnauthorized: String(process.env.DB_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() === 'true' } : false,
  };
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(__filename, { workerData: { config, port: port2 }, transferList: [port2] });
  let seq = 0;
  const pending = new Map();
  worker.on('error', e => console.error('[DB Worker]', e));

  function call(op, sql, params, options = {}) {
    const id = ++seq;
    port1.postMessage({ id, op, sql, params, ...options });
    const timeoutAt = Date.now() + parseInt(process.env.DB_QUERY_TIMEOUT_MS || '60000', 10);
    while (Date.now() < timeoutAt) {
      const packet = receiveMessageOnPort(port1);
      if (packet) {
        const msg = packet.message;
        if (msg.id === id) {
          if (msg.error) { const e = new Error(msg.error.message); Object.assign(e, msg.error); throw e; }
          return msg.value;
        }
        pending.set(msg.id, msg);
      }
      const cached = pending.get(id);
      if (cached) { pending.delete(id); if (cached.error) { const e = new Error(cached.error.message); Object.assign(e, cached.error); throw e; } return cached.value; }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
    throw new Error(`[DB] operation timed out: ${op}`);
  }

  const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const deadline = Date.now() + parseInt(process.env.DB_CONNECT_TIMEOUT_SEC || '120', 10) * 1000;
  while (true) {
    try { call('ping'); break; }
    catch (e) { if (Date.now() >= deadline) throw new Error(`[DB] PostgreSQL unavailable: ${e.message}`); console.log(`[DB] waiting for PostgreSQL: ${e.message}`); sleep(2000); }
  }

  const schema = `
    CREATE TABLE IF NOT EXISTS schema_metadata (
      schema_version INTEGER PRIMARY KEY, application_version TEXT NOT NULL,
      initialized_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('superadmin','user')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('PING','APPLICATION')),
      target TEXT NOT NULL, url TEXT DEFAULT '', expected_status INTEGER, timeout_sec INTEGER DEFAULT 15,
      os_type TEXT, is_vm INTEGER DEFAULT 0 CHECK(is_vm IN (0,1)), interval_min INTEGER NOT NULL DEFAULT 5,
      n_threshold INTEGER NOT NULL DEFAULT 2, l2_delay_min INTEGER NOT NULL DEFAULT 2880,
      l3_repeat_min INTEGER NOT NULL DEFAULT 2880, email_l1 TEXT DEFAULT '', email_l2 TEXT DEFAULT '',
      email_l3 TEXT DEFAULT '', email_enabled INTEGER DEFAULT 1 CHECK(email_enabled IN (0,1)),
      is_active INTEGER DEFAULT 1 CHECK(is_active IN (0,1)), status TEXT DEFAULT 'OK' CHECK(status IN ('OK','FAULT')),
      cfc INTEGER DEFAULT 0, last_checked TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      host_mapping_enabled INTEGER DEFAULT 0 CHECK(host_mapping_enabled IN (0,1)),
      host_mapping_hostname TEXT DEFAULT '', host_mapping_ip TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS checks (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      checked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, result TEXT NOT NULL CHECK(result IN ('PASS','FAIL')),
      response_ms INTEGER, error_raw TEXT, endpoint_results TEXT
    );
    CREATE TABLE IF NOT EXISTS incident_state (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
      t0 TIMESTAMPTZ NOT NULL, l1_sent_at TIMESTAMPTZ, l2_sent_at TIMESTAMPTZ, l3_sent_at TIMESTAMPTZ,
      last_l3_repeat TIMESTAMPTZ, was_alerted INTEGER DEFAULT 0 CHECK(was_alerted IN (0,1)), alerted_tiers TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS app_logs (
      id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      level TEXT NOT NULL CHECK(level IN ('INFO','WARN','ERROR')), category TEXT NOT NULL,
      actor TEXT DEFAULT 'system', task_id TEXT, task_name TEXT, message TEXT NOT NULL, detail TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT
    );
    CREATE TABLE IF NOT EXISTS log_archives (
      id TEXT PRIMARY KEY, archive_date TEXT NOT NULL, filename TEXT NOT NULL, filepath TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'ALL', size_bytes BIGINT DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS import_sessions (
      id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMPTZ NOT NULL, preview_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPLIED','CANCELLED'))
    );
    CREATE TABLE IF NOT EXISTS host_mappings (
      id TEXT PRIMARY KEY, hostname TEXT UNIQUE NOT NULL, ip_address TEXT NOT NULL, note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE OR REPLACE VIEW ai_public_task_details AS
      SELECT t.id AS task_id,t.name AS task_name,t.type AS task_type,t.status,(t.is_active=1) AS is_active,t.last_checked,
        t.target,t.url,concat_ws(', ',NULLIF(t.email_l1,''),NULLIF(t.email_l2,''),NULLIF(t.email_l3,'')) AS notification_contacts,
        (t.host_mapping_enabled=1) AS host_mapping_enabled,t.host_mapping_hostname,t.host_mapping_ip,
        COUNT(c.id)::bigint AS total_checks,COUNT(c.id) FILTER(WHERE c.result='FAIL')::bigint AS failure_count,
        ROUND(100.0*COUNT(c.id) FILTER(WHERE c.result='PASS')/NULLIF(COUNT(c.id),0),2) AS availability_percent,
        (i.task_id IS NOT NULL) AS open_incident,i.t0 AS incident_started_at,
        (SELECT error_raw FROM checks f WHERE f.task_id=t.id AND f.result='FAIL' ORDER BY f.checked_at DESC LIMIT 1) AS latest_failure
      FROM tasks t LEFT JOIN checks c ON c.task_id=t.id LEFT JOIN incident_state i ON i.task_id=t.id
      WHERE t.deleted_at IS NULL GROUP BY t.id,i.task_id,i.t0;
    CREATE OR REPLACE VIEW ai_public_task_check_history AS
      SELECT c.task_id,t.name AS task_name,t.type AS task_type,c.checked_at,c.result,c.response_ms,c.error_raw AS error_sanitized
      FROM checks c JOIN tasks t ON t.id=c.task_id WHERE t.deleted_at IS NULL;
    CREATE OR REPLACE VIEW ai_public_incident_timeline AS
      SELECT t.id AS task_id,t.name AS task_name,t.type AS task_type,t.status,i.t0 AS incident_started_at,i.l1_sent_at,i.l2_sent_at,
        i.l3_sent_at,i.last_l3_repeat,i.alerted_tiers,
        (SELECT error_raw FROM checks f WHERE f.task_id=t.id AND f.result='FAIL' ORDER BY f.checked_at DESC LIMIT 1) AS latest_failure
      FROM incident_state i JOIN tasks t ON t.id=i.task_id WHERE t.deleted_at IS NULL;
    CREATE OR REPLACE VIEW ai_public_application_logs AS
      SELECT created_at,level,category,task_name,message AS message_sanitized,detail AS detail_sanitized FROM app_logs;
    CREATE OR REPLACE VIEW ai_public_administrator_contacts AS SELECT email,role FROM users WHERE LOWER(TRIM(role))='superadmin' AND NULLIF(TRIM(email),'') IS NOT NULL;
    CREATE OR REPLACE VIEW ai_public_host_mappings AS SELECT id AS task_id,hostname AS task_name,hostname,ip_address,true AS enabled FROM host_mappings;
    CREATE OR REPLACE VIEW ai_authenticated_response_analytics AS
      SELECT c.task_id,t.name AS task_name,t.type AS task_type,date_trunc('hour',c.checked_at) AS period_start,COUNT(*)::bigint AS sample_count,
        ROUND(AVG(c.response_ms),2) AS average_ms,MIN(c.response_ms) AS minimum_ms,MAX(c.response_ms) AS maximum_ms,
        percentile_cont(0.95) WITHIN GROUP(ORDER BY c.response_ms) AS p95_ms
      FROM checks c JOIN tasks t ON t.id=c.task_id WHERE c.response_ms IS NOT NULL GROUP BY c.task_id,t.name,t.type,date_trunc('hour',c.checked_at);
    CREATE OR REPLACE VIEW ai_authenticated_user_activity AS SELECT created_at,actor,action,detail AS detail_sanitized FROM audit_logs WHERE action LIKE 'USER_%' OR action LIKE 'AUTH_%';
    CREATE OR REPLACE VIEW ai_superadmin_audit_summary AS SELECT action,COUNT(*)::bigint AS event_count,MIN(created_at) AS first_event_at,MAX(created_at) AS last_event_at FROM audit_logs GROUP BY action;
    CREATE OR REPLACE VIEW ai_superadmin_user_accounts AS SELECT email,role,created_at FROM users;
    CREATE OR REPLACE VIEW ai_superadmin_archives AS SELECT archive_date,filename,category,size_bytes,created_at FROM log_archives;
    CREATE OR REPLACE VIEW ai_superadmin_mail_diagnostics AS SELECT created_at,level,message AS message_sanitized,detail AS detail_sanitized FROM app_logs WHERE category='EMAIL';
    CREATE OR REPLACE VIEW ai_superadmin_system_health AS
      SELECT COUNT(*) FILTER(WHERE deleted_at IS NULL AND is_active=1)::bigint AS active_tasks,
        COUNT(*) FILTER(WHERE deleted_at IS NULL AND status='FAULT')::bigint AS fault_tasks,
        (SELECT COUNT(*)::bigint FROM incident_state) AS open_incidents,
        (SELECT COUNT(*)::bigint FROM checks WHERE checked_at>=CURRENT_TIMESTAMP-INTERVAL '24 hours') AS checks_last_24h,
        0::bigint AS backend_uptime_seconds FROM tasks;
    CREATE OR REPLACE VIEW ai_superadmin_task_configuration AS
      SELECT id AS task_id,name AS task_name,type AS task_type,target,url,expected_status,timeout_sec,os_type,interval_min,n_threshold AS failure_threshold,
        l2_delay_min,l3_repeat_min,concat_ws(', ',NULLIF(email_l1,''),NULLIF(email_l2,''),NULLIF(email_l3,'')) AS notification_contacts,
        (email_enabled=1) AS email_enabled,(is_active=1) AS is_active,status,cfc,(host_mapping_enabled=1) AS host_mapping_enabled,
        host_mapping_hostname,host_mapping_ip,created_at,updated_at FROM tasks WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_checks_task_id ON checks(task_id);
    CREATE INDEX IF NOT EXISTS idx_checks_checked_at ON checks(checked_at);
    CREATE INDEX IF NOT EXISTS idx_app_logs_created ON app_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_app_logs_category ON app_logs(category);
    CREATE INDEX IF NOT EXISTS idx_app_logs_level ON app_logs(level);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);
    CREATE INDEX IF NOT EXISTS idx_log_archives_date ON log_archives(archive_date);
    INSERT INTO schema_metadata(schema_version, application_version) VALUES(1, '3.0.0')
      ON CONFLICT(schema_version) DO UPDATE SET application_version=EXCLUDED.application_version, updated_at=CURRENT_TIMESTAMP;
  `;
  call('exec', 'SELECT pg_advisory_lock(82374019)');
  try { call('exec', schema); }
  finally { call('exec', 'SELECT pg_advisory_unlock(82374019)'); }
  call('run', "UPDATE tasks SET interval_min=? WHERE interval_min<?", [3, 3]);
  call('run', "UPDATE tasks SET interval_min=? WHERE interval_min>?", [15, 15]);
  call('run', "UPDATE tasks SET n_threshold=1 WHERE n_threshold<1");
  call('run', "UPDATE tasks SET n_threshold=5 WHERE n_threshold>5");
  call('run', "DELETE FROM incident_state WHERE task_id IN (SELECT id FROM tasks WHERE status='OK' OR is_active=0)");
  call('run', "DELETE FROM import_sessions WHERE expires_at < CURRENT_TIMESTAMP");
  console.log('[DB] PostgreSQL schema version 1 ready');

  const db = {
    prepare(sql) { return { get: (...p) => call('get', sql, p), all: (...p) => call('all', sql, p), run: (...p) => call('run', sql, p) }; },
    exec(sql) { return call('exec', sql); },
    pragma() { return undefined; },
    transaction(fn) { return (...args) => { call('begin'); try { const result = fn(...args); call('commit'); return result; } catch (e) { try { call('rollback'); } catch {} throw e; } }; },
    aiSelect(sql, params, options = {}) { return call('ai-select', sql, params, options); },
    close() { return call('close'); },
    LOG_ARCHIVE_DIR,
  };
  module.exports = db;
}
