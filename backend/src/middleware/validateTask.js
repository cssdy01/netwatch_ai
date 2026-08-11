// src/middleware/validateTask.js
const MIN_INTERVAL_MIN = 3;
const MAX_INTERVAL_MIN = 15;
const MIN_N_THRESHOLD  = 1;
const MAX_N_THRESHOLD  = 5;

function isValidIpv4(ip) {
  if (!ip || typeof ip !== 'string') return false;
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(ip.trim()) && ip.trim().split('.').every(o => parseInt(o) <= 255);
}

function validateTask(req, res, next) {
  const {
    name, type, target, interval_min, n_threshold, url,
    l2_delay_min, l3_repeat_min,
    host_mapping_enabled, host_mapping_hostname, host_mapping_ip,
  } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Task name is required' });
  if (!type || !['PING', 'APPLICATION'].includes(type)) return res.status(400).json({ error: 'Type must be PING or APPLICATION' });
  if (!target || !target.trim()) return res.status(400).json({ error: 'Target is required' });

  const intervalNum = parseInt(interval_min, 10);
  if (Number.isNaN(intervalNum) || intervalNum < MIN_INTERVAL_MIN || intervalNum > MAX_INTERVAL_MIN)
    return res.status(400).json({ error: `Check interval must be between ${MIN_INTERVAL_MIN} and ${MAX_INTERVAL_MIN} minutes` });

  if (n_threshold !== undefined && n_threshold !== null && n_threshold !== '') {
    const nNum = parseInt(n_threshold, 10);
    if (Number.isNaN(nNum) || nNum < MIN_N_THRESHOLD || nNum > MAX_N_THRESHOLD)
      return res.status(400).json({ error: `N Threshold must be between ${MIN_N_THRESHOLD} and ${MAX_N_THRESHOLD}` });
  }

  // Validate custom timings
  if (Number.isNaN(parseInt(l2_delay_min, 10)) || parseInt(l2_delay_min, 10) < 1)
    return res.status(400).json({ error: 'L2 Delay must be at least 1 minute' });
  if (Number.isNaN(parseInt(l3_repeat_min, 10)) || parseInt(l3_repeat_min, 10) < 1)
    return res.status(400).json({ error: 'L3 Repeat must be at least 1 minute' });

  if (type === 'APPLICATION') {
    if (!url || typeof url !== 'string' || !url.startsWith('http'))
      return res.status(400).json({ error: `URL is required and must start with http or https` });

    if (req.body.expected_status != null && req.body.expected_status !== '') {
      const sc = parseInt(req.body.expected_status, 10);
      if (Number.isNaN(sc) || sc < 100 || sc > 599) return res.status(400).json({ error: `expected_status must be 100-599` });
    }

    if (req.body.timeout_sec != null && req.body.timeout_sec !== '') {
      const ts = parseInt(req.body.timeout_sec, 10);
      if (Number.isNaN(ts) || ts < 1 || ts > 120) return res.status(400).json({ error: `timeout_sec must be 1-120` });
    }

    const mappingOn = host_mapping_enabled === true || host_mapping_enabled === 1 || host_mapping_enabled === '1' || host_mapping_enabled === 'true';
    if (mappingOn) {
      if (!host_mapping_hostname || !String(host_mapping_hostname).trim()) return res.status(400).json({ error: 'Host mapping: hostname is required' });
      if (!host_mapping_ip || !String(host_mapping_ip).trim()) return res.status(400).json({ error: 'Host mapping: IP address is required' });
      if (!isValidIpv4(String(host_mapping_ip))) return res.status(400).json({ error: `Host mapping IP is invalid` });
    }
  }

  // Changed to 5 max emails
  for (const field of ['email_l1', 'email_l2', 'email_l3']) {
    const val = req.body[field];
    if (!val) continue;
    const emails = val.split(',').map(e => e.trim()).filter(Boolean);
    if (emails.length > 5) return res.status(400).json({ error: `${field}: maximum 5 email addresses per level` });
    for (const e of emails) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return res.status(400).json({ error: `${field}: "${e}" is not a valid email address` });
    }
  }
  next();
}

module.exports = validateTask;
module.exports.validateTask = validateTask;
module.exports.MIN_INTERVAL_MIN = MIN_INTERVAL_MIN;
module.exports.MAX_INTERVAL_MIN = MAX_INTERVAL_MIN;
module.exports.MIN_N_THRESHOLD = MIN_N_THRESHOLD;
module.exports.MAX_N_THRESHOLD = MAX_N_THRESHOLD;
module.exports.isValidIpv4 = isValidIpv4;