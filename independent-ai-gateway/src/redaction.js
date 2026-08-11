'use strict';

const blocked =
  /password|passwd|hash|jwt|cookie|session.?token|api.?key|provider.?key|service.?token|smtp.?credential|database.?credential|authorization|secret|private.?key|encryption.?key/i;

/**
 * Convert a value to text and redact sensitive information.
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
    );
}

/**
 * Recursively sanitize values while removing sensitive fields.
 */
function sanitize(value, depth = 0) {
  if (depth > 8) {
    return '[TRUNCATED]';
  }

  if (
    value == null ||
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
      .map((item) => sanitize(item, depth + 1));
  }

  if (typeof value === 'object') {
    const output = {};

    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      if (!blocked.test(key)) {
        output[key] = sanitize(item, depth + 1);
      }
    }

    return output;
  }
  
  if (value instanceof Date) {
  return Number.isNaN(value.getTime())
    ? null
    : value.toISOString();
}

  return text(value);
}

module.exports = {
  text,
  sanitize
};
