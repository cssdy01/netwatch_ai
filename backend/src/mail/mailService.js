// src/mail/mailService.js

const {
  send,
  MAIL_BIN_AVAILABLE,
  buildAlertPlainText,
  buildAllClearPlainText,
  buildTestPlainText,
  buildAlertHtml,
  buildAllClearHtml,
  buildTestHtml,
} = require('./transport');
const { log } = require('../services/appLog');

// ── Recipients (unchanged from original) ──────────────────────────────────────

function parseEmails(str) {
  if (!str) return [];
  return str.split(',')
    .map(e => e.trim())
    .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    .slice(0, 3);
}

function collectRecipients(task, tier) {
  const l1 = parseEmails(task.email_l1);
  const l2 = parseEmails(task.email_l2);
  const l3 = parseEmails(task.email_l3);
  const map = { L1: [...l1], L2: [...l1, ...l2], L3: [...l1, ...l2, ...l3] };
  return [...new Set(map[tier] || l1)];
}

function collectAllRecipients(task) {
  return [...new Set([
    ...parseEmails(task.email_l1),
    ...parseEmails(task.email_l2),
    ...parseEmails(task.email_l3),
  ])];
}

// ── Duration (unchanged from original) ───────────────────────────────────────

function formatDuration(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// ── Subjects (updated format per spec) ───────────────────────────────────────

function typeWord(task) {
  return task.type === 'APPLICATION' ? 'Application' : 'System';
}

function buildSubject(task, tier) {
  const n = task.name;
  const t = typeWord(task);
  switch (tier) {
    case 'L1':    return `[NETWATCH L1] ${n} ${t} is DOWN`;
    case 'L2':    return `[NETWATCH L2] ${n} ${t} still DOWN for 48h`;
    case 'L3':    return `[NETWATCH L3] ${n} ${t} still DOWN - repeated escalation`;
    case 'CLEAR': return `[NETWATCH CLEAR] ${n} ${t} recovered`;
    case 'TEST':  return '[NETWATCH TEST] Mail configuration OK';
    default:      return `[NETWATCH] ${n} - ${tier}`;
  }
}

// ── Send functions (logging and escalation logic unchanged from original) ─────

async function sendAlert({ task, incidentState, tier, errorRaw }) {
  const recipients = collectRecipients(task, tier);
  if (recipients.length === 0) {
    log('WARN', 'EMAIL', 'scheduler', task.id,
      `${tier} skipped - no valid recipients`, null);
    return false;
  }

  const t0     = new Date(incidentState.t0);
  const diffMs = Date.now() - t0.getTime();

  const plainText = buildAlertPlainText({
    task, t0: incidentState.t0, tier, errorRaw,
    incidentDuration: diffMs > 60000 ? formatDuration(diffMs) : null,
  });
  const html = buildAlertHtml({ task, t0: incidentState.t0, tier, errorRaw });

  await send({
    to:      recipients,
    subject: buildSubject(task, tier),
    plainText,
    html,
  });

  log('INFO', 'EMAIL', 'scheduler', task.id,
    `${tier} mail sent for "${task.name}" -> ${recipients.join(', ')}`, null);
  return true;
}

async function sendAllClear({ task, t0 }) {
  const recipients = collectAllRecipients(task);
  if (recipients.length === 0) return false;

  const downtimeDuration = formatDuration(Date.now() - new Date(t0).getTime());
  const plainText = buildAllClearPlainText({ task, downtimeDuration });
  const html      = buildAllClearHtml({ task, downtimeDuration });

  await send({
    to:      recipients,
    subject: buildSubject(task, 'CLEAR'),
    plainText,
    html,
  });

  log('INFO', 'EMAIL', 'scheduler', task.id,
    `All Clear mail sent for "${task.name}" - downtime: ${downtimeDuration}`, null);
  return true;
}

async function sendTestEmail(to) {
  // Explicit-only path. Never called from scheduler or monitor cycle.
  await send({
    to,
    subject:   buildSubject({}, 'TEST'),
    plainText: buildTestPlainText(),
    html:      buildTestHtml(),
  });
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  sendAlert,
  sendAllClear,
  sendTestEmail,
  parseEmails,
  collectRecipients,
  collectAllRecipients,
  MAIL_BIN_AVAILABLE,
};
