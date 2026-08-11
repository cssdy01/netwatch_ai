'use strict';

const { Router } = require('express');
const { optionalAuth } = require('../middleware/auth');
const ai = require('../ai/aiService');

const router = Router();

function enabled(_req, res, next) {
  if (String(process.env.AI_ENABLED || 'false').toLowerCase() !== 'true') {
    return res.status(503).json({ type: 'ERROR', code: 'AI_DISABLED', content: 'The optional AI assistant is disabled. NetWatch monitoring is unaffected.', retryable: false });
  }
  next();
}
function errorResponse(res, err) {
  const originalCode = err.code || 'AI_UNAVAILABLE';
  const policyCodes = new Set([
    'VIEW_NOT_APPROVED',
    'AI_VIEW_NOT_ALLOWED',
    'AI_COLUMN_NOT_ALLOWED',
    'UNSAFE_SQL_PLAN',
    'AI_UNSAFE_SQL',
    'AI_INVALID_SQL',
    'AI_INVALID_SQL_PLAN',
    'AI_PARAMETER_MISMATCH',
    'AI_INVALID_LIMIT'
  ]);

  if (policyCodes.has(originalCode)) {
    return res.status(422).json({
      type: 'ERROR',
      code: 'AI_QUERY_POLICY_ERROR',
      content: 'Netwatch AI could not safely prepare that data request. Try again with the exact task name or start a New chat. No monitoring data was modified.',
      retryable: true
    });
  }

  const status = Number(err.status) || 503;
  const retryable = Boolean(err.retryable) || status >= 500 || [
    'AI_TIMEOUT',
    'AI_UNAVAILABLE',
    'AI_GATEWAY_ERROR',
    'PROVIDER_RATE_LIMIT',
    'PROVIDER_TIMEOUT',
    'PROVIDER_UNAVAILABLE'
  ].includes(originalCode);

  let content = 'The AI assistant is temporarily unavailable. NetWatch monitoring is unaffected.';
  if (status === 403) content = 'That AI request is not permitted for the current user.';
  else if (status === 410) content = 'The temporary AI session has expired.';
  else if (originalCode === 'PROVIDER_RATE_LIMIT') content = 'Netwatch AI reached a temporary provider limit.';
  else if (originalCode === 'INVALID_STRUCTURED_OUTPUT') content = 'Netwatch AI received an incomplete structured response. Try again or start a New chat. No monitoring data was modified.';

  return res.status(status).json({
    type: 'ERROR',
    code: originalCode,
    content,
    retryable,
    ...(err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {})
  });
}

router.get('/status', optionalAuth, async (_req, res) => res.json(await ai.status()));
router.post('/sessions', enabled, optionalAuth, async (req, res) => {
  try { res.status(201).json(await ai.createSession(req.user || null)); }
  catch (err) { errorResponse(res, err); }
});
router.post('/sessions/:id/messages', enabled, optionalAuth, async (req, res) => {
  const question = String(req.body?.question || '').trim();
  if (!question || question.length > 4000) return res.status(400).json({ error: 'Question is required and must not exceed 4000 characters' });
  try { res.json(await ai.sendMessage(req.params.id, req.user || null, question)); }
  catch (err) { errorResponse(res, err); }
});
router.post('/sessions/:id/reset', enabled, optionalAuth, async (req, res) => {
  try { res.json(await ai.resetSession(req.params.id, req.user || null)); }
  catch (err) { errorResponse(res, err); }
});
router.delete('/sessions/:id', enabled, optionalAuth, async (req, res) => {
  try { await ai.closeSession(req.params.id, req.user || null); res.json({ ok: true }); }
  catch (err) { errorResponse(res, err); }
});

module.exports = router;
