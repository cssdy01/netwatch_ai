'use strict';

const crypto = require('crypto');
const db = require('../db');
const { validateQuery } = require('./sqlValidator');

const URL = String(
  process.env.AI_GATEWAY_URL ||
    'http://independent-ai-gateway:3090'
).replace(/\/$/, '');

const TOKEN = String(
  process.env.NETWATCH_AI_SERVICE_TOKEN || ''
);

const TIMEOUT = Number(
  process.env.AI_GATEWAY_TIMEOUT_MS || 20000
);

const sessions = new Map();

const KEY =
  /password|passwd|hash|jwt|cookie|session.?token|api.?key|provider.?key|service.?token|smtp.?credential|database.?credential|authorization|secret|private.?key|encryption.?key/i;

/**
 * Redact sensitive information from text.
 */
function text(value) {
  return String(value ?? '')
    .slice(0, 10000)
    .replace(
      /gsk_[A-Za-z0-9_-]+/g,
      '[REDACTED]'
    )
    .replace(
      /Bearer\s+[A-Za-z0-9.*-]+/gi,
      'Bearer [REDACTED]'
    )
    .replace(
      /(password|token|secret|api[*-]?key)\s*[:=]\s*[^\s,;]+/gi,
      '$1=[REDACTED]'
    )
    .replace(
      /(postgres(?:ql)?|smtp):\/\/[^\s/@:]+:[^\s/@]+@/gi,
      '$1://[REDACTED]@'
    );
}

/**
 * Recursively sanitize objects, arrays and strings.
 */
function sanitize(value, depth = 0) {
  if (depth > 8) {
    return '[TRUNCATED]';
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : value.toISOString();
  }

  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'string') {
    return text(value);
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, 500)
      .map((item) =>
        sanitize(item, depth + 1),
      );
  }

  if (typeof value === 'object') {
    const output = {};

    for (
      const [key, item] of
      Object.entries(value).slice(0, 200)
    ) {
      if (!KEY.test(key)) {
        output[key] =
          sanitize(item, depth + 1);
      }
    }

    return output;
  }

  return text(value);
}

/**
 * Determine the AI access scope for a user.
 */
function scopeOf(user) {
  if (user?.role === 'superadmin') {
    return 'SUPERADMIN_READ_ONLY';
  }

  if (user) {
    return 'AUTHENTICATED_READ_ONLY';
  }

  return 'PUBLIC_READ_ONLY';
}

/**
 * Build a stable identity for session ownership.
 */
function identity(user) {
  if (!user) {
    return 'public';
  }

  return `${user.id || user.email || user.username}:${
    user.role || 'user'
  }`;
}

/**
 * Check whether the AI gateway is configured.
 */
function configured() {
  return Boolean(URL && TOKEN);
}

/**
 * Send a request to the independent AI gateway.
 */
async function gateway(path, { method = 'GET', body } = {}) {
  if (!configured()) {
    throw Object.assign(
      new Error('AI not configured'),
      {
        code: 'AI_NOT_CONFIGURED',
        status: 503
      }
    );
  }

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, TIMEOUT);

  try {
    const response = await fetch(`${URL}${path}`, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      },
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body)
          })
    });

    const payload = await response
      .json()
      .catch(() => ({}));

    if (!response.ok) {
      throw Object.assign(
        new Error(
          payload.content ||
            payload.error ||
            `Gateway HTTP ${response.status}`
        ),
        {
          code:
            payload.code ||
            'AI_GATEWAY_ERROR',
          status: response.status,
          retryable: payload.retryable,
          retryAfterSeconds:
            payload.retryAfterSeconds
        }
      );
    }

    return payload;
  } catch (error) {
    if (error.name === 'AbortError') {
      throw Object.assign(
        new Error('AI Gateway timeout'),
        {
          code: 'AI_TIMEOUT',
          status: 503,
          retryable: true
        }
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve and validate an application session.
 */
function resolve(id, user) {
  const key = String(id);
  const session = sessions.get(key);

  if (
    !session ||
    session.identity !== identity(user) ||
    Date.now() > session.expiresAt
  ) {
    sessions.delete(key);

    throw Object.assign(
      new Error('Session expired'),
      {
        code: 'SESSION_EXPIRED',
        status: 410
      }
    );
  }

  return session;
}

/**
 * Create an AI session.
 */
async function createSession(user) {
  const scope = scopeOf(user);

  const remote = await gateway(
    '/v1/sessions',
    {
      method: 'POST',
      body: {
        scope
      }
    }
  );

  const id = crypto.randomUUID();

  const expiresIn = Number(
    remote.expiresIn || 3600
  );

  sessions.set(id, {
    id,
    gatewayId: remote.sessionId,
    scope,
    identity: identity(user),
    expiresAt:
      Date.now() +
      Math.min(expiresIn * 1000, 3600000)
  });

  return {
    sessionId: id,
    scope,
    expiresIn,
    requestLimit: remote.requestLimit
  };
}

function enrichIncidentDurations(rows) {
  const observedAt = new Date();
  return rows.map((row) => {
    if (!row || !row.incident_started_at) return row;
    const startedAt = new Date(row.incident_started_at);
    if (Number.isNaN(startedAt.getTime())) return row;
    return {
      ...row,
      observed_at: observedAt.toISOString(),
      fault_duration_seconds: Math.max(
        0,
        Math.floor((observedAt.getTime() - startedAt.getTime()) / 1000)
      )
    };
  });
}

/**
 * Send a question to the AI gateway.
 */
async function sendMessage(id, user, question) {
  const session = resolve(id, user);

  const planned = await gateway(
    `/v1/sessions/${encodeURIComponent(
      session.gatewayId
    )}/messages`,
    {
      method: 'POST',
      body: {
        question
      }
    }
  );

  if (planned.type !== 'SQL_QUERY') {
    return planned;
  }

  const query = validateQuery(
    planned.query,
    session.scope
  );

  const executed = db.aiSelect(
    query.sql,
    query.parameters,
    {
      timeoutMs: Number(
        process.env.AI_SQL_TIMEOUT_MS || 5000
      ),
      lockTimeoutMs: Number(
        process.env.AI_SQL_LOCK_TIMEOUT_MS || 1000
      )
    }
  );

  const safeRows = enrichIncidentDurations(
    sanitize(executed.rows)
  );

  const result = {
    purpose: query.purpose,
    rowCount: safeRows.length,
    columns: executed.fields.filter(
      (field) => !KEY.test(field)
    ),
    rows: safeRows,
    sanitized: true
  };

  const answer = await gateway(
    `/v1/sessions/${encodeURIComponent(
      session.gatewayId
    )}/analyze`,
    {
      method: 'POST',
      body: {
        question,
        queryResult: result
      }
    }
  );

  return {
    ...answer,
    details:
      answer.details || safeRows,
    sanitized: true,
    dataMeta: {
      ...(answer.dataMeta || {}),
      operation: 'SQL_QUERY',
      rowCount: safeRows.length,
      sanitized: true,
      relations: query.relations
    }
  };
}

/**
 * Reset an AI session.
 */
async function resetSession(id, user) {
  const session = resolve(id, user);

  const remote = await gateway(
    `/v1/sessions/${encodeURIComponent(
      session.gatewayId
    )}/reset`,
    {
      method: 'POST'
    }
  );

  return {
    sessionId: id,
    scope: session.scope,
    requestsRemaining:
      remote.requestsRemaining
  };
}

/**
 * Close an AI session.
 */
async function closeSession(id, user) {
  const session = resolve(id, user);

  sessions.delete(id);

  try {
    await gateway(
      `/v1/sessions/${encodeURIComponent(
        session.gatewayId
      )}`,
      {
        method: 'DELETE'
      }
    );
  } catch {
    // Remote session cleanup failure is intentionally ignored.
  }

  return {
    ok: true
  };
}

/**
 * Return AI gateway status.
 */
async function status() {
  const base = {
    enabled:
      String(
        process.env.AI_ENABLED || 'false'
      ).toLowerCase() === 'true',

    configured: configured(),

    activeSessions: sessions.size
  };

  if (!base.enabled || !base.configured) {
    return {
      ...base,
      available: false
    };
  }

  try {
    return {
      ...base,
      available: true,
      gateway: await gateway('/v1/status')
    };
  } catch (error) {
    return {
      ...base,
      available: false,
      error:
        error.code || 'AI_UNAVAILABLE'
    };
  }
}

module.exports = {
  createSession,
  sendMessage,
  resetSession,
  closeSession,
  status,
  scopeOf,
  gatewayConfigured: configured,
  sanitize
};
