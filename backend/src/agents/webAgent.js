// src/agents/webAgent.js
const axios  = require('axios');
const https  = require('https');

// ── helpers ────────────────────────────────────────────────────────────────────

function isValidIpv4(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const trimmed = ip.trim();
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(trimmed) &&
    trimmed.split('.').every(o => parseInt(o, 10) <= 255);
}

/**
 * Parse all parts needed for URL rewriting.
 */
function parseUrlParts(urlStr) {
  try {
    const u = new URL(urlStr);
    return {
      protocol: u.protocol,         // "http:" or "https:"
      hostname: u.hostname,         // "dev.uimcn.tsaro.com"
      port:     u.port || (u.protocol === 'https:' ? '443' : '80'),
      pathname: u.pathname,         // "/Inventory/faces/login.jspx"
      search:   u.search,          // "?foo=bar" or ""
    };
  } catch {
    return null;
  }
}

function rewriteUrlToIp(urlStr, mappedIp) {
  const parts = parseUrlParts(urlStr);
  if (!parts) return urlStr;

  const port = parts.port;
  const defaultPort = parts.protocol === 'https:' ? '443' : '80';
  const portStr = port && port !== defaultPort ? `:${port}` : '';

  return `${parts.protocol}//${mappedIp}${portStr}${parts.pathname}${parts.search}`;
}

async function checkUrl(urlConfig, defaultTimeout = 15, mapping = null) {
  const originalUrl    = typeof urlConfig === 'string' ? urlConfig : urlConfig.url;
  const expectedStatus = typeof urlConfig === 'object' ? (urlConfig.expected_status || null) : null;
  const timeoutMs      = ((typeof urlConfig === 'object' ? urlConfig.timeout_sec : null) || defaultTimeout) * 1000;

  const start = Date.now();
  const parts = parseUrlParts(originalUrl);

  // Determine whether to apply the host mapping for this URL
  const shouldMap = (
    mapping &&
    mapping.enabled &&
    isValidIpv4(mapping.ip) &&
    mapping.hostname &&
    parts &&
    parts.hostname.toLowerCase() === mapping.hostname.toLowerCase().trim()
  );

  // Build the actual URL to request (IP-based if mapping applies)
  const requestUrl = shouldMap ? rewriteUrlToIp(originalUrl, mapping.ip.trim()) : originalUrl;

  // Build axios config
  const axiosConfig = {
    timeout:        timeoutMs,
    validateStatus: () => true,   // never throw on HTTP status
    maxRedirects:   5,
    headers: {
      'User-Agent': 'NetWatch-Monitor/1.0',
    },
  };

  // Ignore SSL certificate validation for all HTTPS URLs
  if (parts && parts.protocol === 'https:') {
    axiosConfig.httpsAgent = new https.Agent({
      rejectUnauthorized: false
    });
  }

  if (shouldMap) {
    const originalParts = parts;
    const port = originalParts.port;
    const defaultPort = originalParts.protocol === 'https:' ? '443' : '80';

    // Set the Host header to the original hostname (with port if non-default)
    const hostHeader = (port && port !== defaultPort)
      ? `${originalParts.hostname}:${port}`
      : originalParts.hostname;

    axiosConfig.headers['Host'] = hostHeader;

    // For HTTPS: disable cert validation (private CA) and set SNI to original hostname
    if (originalParts.protocol === 'https:') {
      axiosConfig.httpsAgent = new https.Agent({
        rejectUnauthorized: false,
        servername: originalParts.hostname,  // SNI = original hostname
      });
    }
  }

  try {
    const response   = await axios.get(requestUrl, axiosConfig);
    const responseMs = Date.now() - start;
    const status     = response.status;

    if (expectedStatus) {
      const expected = parseInt(expectedStatus, 10);
      if (status !== expected) {
        return {
          url: originalUrl, result: 'FAIL', httpStatus: status, responseMs,
          errorRaw: `HTTP status mismatch — expected ${expected}, received ${status}`,
        };
      }
    } else if (status >= 400) {
      return {
        url: originalUrl, result: 'FAIL', httpStatus: status, responseMs,
        errorRaw: `HTTP ${status} — server returned an error status`,
      };
    }

    return { url: originalUrl, result: 'PASS', httpStatus: status, responseMs, errorRaw: null };

  } catch (err) {
    const responseMs = Date.now() - start;

    // Extremely generic error messages to bypass spam filter heuristics
    let errorRaw = 'HTTP Request Failed'; 

    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      errorRaw = `Connection timeout (${timeoutMs}ms)`;
    } else if (err.code === 'ECONNREFUSED') {
      errorRaw = 'Connection refused by server';
    } else if (err.code === 'ENOTFOUND') {
      errorRaw = 'Host unreachable (DNS lookup failed)';
    } else if (err.code === 'EHOSTUNREACH') {
      errorRaw = 'Host unreachable (Network route)';
    } else if (err.code === 'ECONNRESET') {
      errorRaw = 'Connection reset by server';
    } else if (err.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
      errorRaw = 'TLS/SSL certificate validation failed';
    }

    return { url: originalUrl, result: 'FAIL', httpStatus: null, responseMs, errorRaw };
  }
}

async function run(task) {
  if (!task.url) {
    return {
      result: 'FAIL', responseMs: 0,
      errorRaw: 'No URL configured',
      endpointResults: null,
    };
  }

  const rawEnabled = task.host_mapping_enabled;
  const mappingEnabled = rawEnabled === true ||
                         rawEnabled === 1    ||
                         rawEnabled === '1'  ||
                         rawEnabled === 'true';

  const mapping = {
    enabled:  mappingEnabled,
    hostname: String(task.host_mapping_hostname || '').trim(),
    ip:       String(task.host_mapping_ip       || '').trim(),
  };

  // Validate mapping config if enabled
  if (mapping.enabled) {
    if (!mapping.hostname) {
      return { result: 'FAIL', responseMs: 0, errorRaw: 'Mapping enabled but hostname missing', endpointResults: null };
    }
    if (!isValidIpv4(mapping.ip)) {
      return { result: 'FAIL', responseMs: 0, errorRaw: 'Mapping enabled but IP invalid', endpointResults: null };
    }
  }

  const urlConfig = {
    url: task.url,
    expected_status: task.expected_status || null,
    timeout_sec: task.timeout_sec || 15
  };

  const r = await checkUrl(urlConfig, 15, mapping.enabled ? mapping : null);

  return {
    result:          r.result,
    responseMs:      r.responseMs,
    // Provide ONLY the raw error text without appending the URL or bracket tags
    errorRaw:        r.errorRaw,
    endpointResults: [r],
  };
}

module.exports = { run, checkUrl };