'use strict';

const Ajv = require('ajv');
const provider = require('./provider');
const redact = require('./redaction');

const ajv = new Ajv({
  strict: false,
});

const schema = {
  type: 'object',
  additionalProperties: false,

  properties: {
    type: {
      enum: [
        'MESSAGE',
        'SQL_QUERY',
        'CLARIFICATION',
        'DENIED',
      ],
    },

    content: {
      type: 'string',
    },

    question: {
      type: 'string',
    },

    code: {
      type: 'string',
    },

    query: {
      type: 'object',
      additionalProperties: false,

      properties: {
        sql: {
          type: 'string',
        },

        parameters: {
          type: 'array',
        },

        purpose: {
          type: 'string',
        },

        expectedColumns: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },

      required: [
        'sql',
        'parameters',
        'purpose',
        'expectedColumns',
      ],
    },

    conversationFocus: {
      type: 'object',
    },
  },

  required: [
    'type',
  ],
};

const valid = ajv.compile(schema);

const write =
  /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|merge|execute|disable|enable|send\s+(mail|email)|restore|import)\b/i;

const secret =
  /\b(password|hash|jwt|cookie|session token|api key|service token|smtp credential|database credential|authorization header|encryption key|private key|unrestricted raw log)\b/i;

const greet =
  /^(hi|hello|hey|help|what can you do)[.!?\s]*$/i;

function views(knowledge, scope) {
  return (
    knowledge.parsed.database.scopes[scope]?.approved_views || []
  );
}

function safeSQL(sql, allowed) { const q = String(sql || '').trim(); const unsafeSql = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|merge|copy|call|do|execute|select\s+.*\s+into\s+|pg_catalog|information_schema|pg_read_file|pg_ls_dir|dblink|lo_import|lo_export|pg_sleep)\b/i; const hasComment = /--|\/\*|\*\//.test(q); if ( !/^(select|with)\b/i.test(q) || q.includes(';') || hasComment || unsafeSql.test(q) ) { throw Object.assign( new Error('Unsafe SQL'), { code: 'UNSAFE_SQL_PLAN', }, ); } const refs = [ ...q.matchAll( /\b(?:from|join)\s+([a-zA-Z_][\w.]*)/gi, ), ].map((match) => match[1].toLowerCase(), ); const approved = new Set( allowed.map((view) => String(view).toLowerCase(), ), ); if ( refs.length === 0 || refs.some((ref) => !approved.has(ref)) ) { throw Object.assign( new Error('View not approved'), { code: 'VIEW_NOT_APPROVED', }, ); } return q; }

function prompt(scope, knowledge, focus) {
  const approvedViews =
    views(knowledge, scope);

  return `
You are Netwatch AI.

Your job is to classify a user request and, when current
Netwatch data is required, produce one read-only PostgreSQL
SELECT query.

Return exactly one JSON object.

Do not include:
- Markdown
- code fences
- explanatory text outside JSON
- progress messages
- placeholder messages

MESSAGE is allowed only for:
- greetings
- help
- explaining Netwatch terminology
- explaining read-only limitations
- general questions that do not require current database data

Any request about current or historical Netwatch data must
return SQL_QUERY.

Examples that require SQL_QUERY:
- Summarize the current task status.
- Give me details of fault application tasks.
- Summarize open incidents.
- How many tasks are in FAULT?
- Who are the administrators?
- Show URL and target for a task.
- Show recent sanitized logs.
- Show check history.
- Show notification contacts.

Never return a MESSAGE such as:
- Summarizing current task status...
- Checking the database...
- Retrieving records...
- Please wait...
- Let me look that up...

Valid MESSAGE format:

{
  "type": "MESSAGE",
  "content": "..."
}

Valid CLARIFICATION format:

{
  "type": "CLARIFICATION",
  "question": "..."
}

Valid DENIED format:

{
  "type": "DENIED",
  "code": "READ_ONLY_ONLY",
  "content": "..."
}

Valid SQL_QUERY format:

{
  "type": "SQL_QUERY",
  "query": {
    "sql": "SELECT ...",
    "parameters": [],
    "purpose": "...",
    "expectedColumns": []
  },
  "conversationFocus": {
    "taskType": "APPLICATION",
    "status": "FAULT",
    "taskName": "optional"
  }
}

For SQL_QUERY:
- The query field must be an object.
- Put SQL in query.sql.
- Put parameters in query.parameters as a JSON array.
- Put purpose in query.purpose.
- Put projected column names in query.expectedColumns.
- Use $1, $2, etc. for all user values.
- Generate exactly one PostgreSQL SELECT.
- Use only these approved views:
  ${approvedViews.join(', ')}
- Add LIMIT no greater than ${
    process.env.SQL_MAX_ROWS || 100
  } to row-returning queries.
- Never query application base tables.
- Never use INSERT, UPDATE, DELETE, MERGE, ALTER,
  DROP, CREATE, TRUNCATE, COPY, CALL, DO,
  GRANT, REVOKE, EXECUTE, or SELECT INTO.
- Never query pg_catalog or information_schema.
- Never use dangerous PostgreSQL functions.

Use camelCase field names:
- conversationFocus
- taskType
- taskName
- taskIds
- expectedColumns

Current conversation focus:

${JSON.stringify(focus || {})}

Application and database knowledge:

${knowledge.raw}
`;
}

function normalizePlan(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input)
  ) {
    return input;
  }

  const source = { ...input };

  const typeAliases = {
    ANSWER: 'MESSAGE',
    RESPONSE: 'MESSAGE',
    CHAT: 'MESSAGE',

    QUESTION: 'CLARIFICATION',
    CLARIFY: 'CLARIFICATION',

    REJECTED: 'DENIED',
    FORBIDDEN: 'DENIED',

    DATA_REQUEST: 'SQL_QUERY',
    QUERY: 'SQL_QUERY',
    SELECT: 'SQL_QUERY',
  };

  let type = String(
    source.type ||
    source.responseType ||
    source.response_type ||
    '',
  )
    .trim()
    .toUpperCase();

  type = typeAliases[type] || type;

  if (type === 'MESSAGE') {
    return {
      type: 'MESSAGE',

      content: String(
        source.content ||
        source.message ||
        source.answer ||
        source.summary ||
        '',
      ).trim(),
    };
  }

  if (type === 'CLARIFICATION') {
    return {
      type: 'CLARIFICATION',

      question: String(
        source.question ||
        source.content ||
        source.message ||
        'Could you clarify which Netwatch record you mean?',
      ).trim(),
    };
  }

  if (type === 'DENIED') {
    return {
      type: 'DENIED',

      code: String(
        source.code ||
        source.errorCode ||
        source.error_code ||
        'READ_ONLY_ONLY',
      ).trim(),

      content: String(
        source.content ||
        source.message ||
        source.reason ||
        'Netwatch AI is read-only and cannot perform that action.',
      ).trim(),
    };
  }

  if (type !== 'SQL_QUERY') {
    return {
      type,
    };
  }

  let sql = '';
  let querySource = {};

  if (typeof source.query === 'string') {
    sql = source.query;
    querySource = source;
  } else if (
    source.query &&
    typeof source.query === 'object' &&
    !Array.isArray(source.query)
  ) {
    querySource = source.query;

    sql = String(
      querySource.sql ||
      querySource.statement ||
      querySource.select ||
      '',
    );
  } else {
    querySource = source;

    sql = String(
      source.sql ||
      source.statement ||
      source.select ||
      '',
    );
  }

  const rawParameters =
    querySource.parameters ??
    querySource.params ??
    querySource.values ??
    source.parameters ??
    source.params ??
    source.values ??
    [];

  let parameters = [];

  if (Array.isArray(rawParameters)) {
    parameters = rawParameters;
  } else if (
    rawParameters &&
    typeof rawParameters === 'object'
  ) {
    parameters = Object.entries(rawParameters)
      .sort(([left], [right]) => {
        return Number(left) - Number(right);
      })
      .map(([, value]) => value);
  }

  const expectedColumns =
    querySource.expectedColumns ??
    querySource.expected_columns ??
    querySource.columns ??
    source.expectedColumns ??
    source.expected_columns ??
    source.columns ??
    [];

  const output = {
    type: 'SQL_QUERY',

    query: {
      sql: sql.trim(),

      parameters,

      purpose: String(
        querySource.purpose ||
        source.purpose ||
        querySource.description ||
        source.description ||
        querySource.reason ||
        source.reason ||
        'Retrieve approved Netwatch monitoring information.',
      ).trim(),

      expectedColumns: Array.isArray(expectedColumns)
        ? expectedColumns
            .map(String)
            .map((column) => column.trim())
            .filter(Boolean)
        : [],
    },
  };

  const rawFocus =
    source.conversationFocus ||
    source.conversation_focus ||
    source.focus ||
    querySource.conversationFocus ||
    querySource.conversation_focus;

  if (
    rawFocus &&
    typeof rawFocus === 'object' &&
    !Array.isArray(rawFocus)
  ) {
    const normalizedFocus = {};

    const taskType =
      rawFocus.taskType ||
      rawFocus.task_type;

    const status =
      rawFocus.status ||
      rawFocus.taskStatus ||
      rawFocus.task_status;

    const taskName =
      rawFocus.taskName ||
      rawFocus.task_name;

    const taskIds =
      rawFocus.taskIds ||
      rawFocus.task_ids;

    if (taskType) {
      normalizedFocus.taskType =
        String(taskType).toUpperCase();
    }

    if (status) {
      normalizedFocus.status =
        String(status).toUpperCase();
    }

    if (taskName) {
      normalizedFocus.taskName =
        String(taskName).slice(0, 200);
    }

    if (Array.isArray(taskIds)) {
      normalizedFocus.taskIds =
        taskIds
          .slice(0, 20)
          .map((value) =>
            String(value).slice(0, 100),
          );
    }

    if (Object.keys(normalizedFocus).length) {
      output.conversationFocus =
        normalizedFocus;
    }
  }

  return output;
}

function requiresDatabase(question) {
  const value = String(question || '')
    .trim()
    .toLowerCase();

  return (
    /\b(current|currently|latest|recent|today|now)\b/.test(
      value,
    ) ||
    /\b(task|tasks|incident|incidents|check|checks)\b/.test(
      value,
    ) ||
    /\b(status|fault|failed|failure|availability)\b/.test(
      value,
    ) ||
    /\b(url|target|contact|contacts|administrator)\b/.test(
      value,
    ) ||
    /\b(host mapping|logs?|diagnostics?)\b/.test(
      value,
    ) ||
    /\b(how many|count|summarize|details?)\b/.test(
      value,
    )
  );
}

function isPlaceholderMessage(content) {
  const value = String(content || '')
    .trim()
    .toLowerCase();

  return (
    !value ||
    /^summari[sz]ing\b/.test(value) ||
    /^checking\b/.test(value) ||
    /^retrieving\b/.test(value) ||
    /^fetching\b/.test(value) ||
    /^looking up\b/.test(value) ||
    /^please wait\b/.test(value) ||
    /^i will\b/.test(value) ||
    /^let me\b/.test(value)
  );
}

async function repairPlan({
  rawOutput,
  validationErrors,
  originalQuestion,
  scope,
  focus,
  knowledge,
}) {
  return provider.complete(
    [
      {
        role: 'system',
        content: prompt(
          scope,
          knowledge,
          focus,
        ),
      },

      {
        role: 'user',
        content: [
          'The previous response did not match the required JSON schema.',
          '',
          `Original user question: ${originalQuestion}`,
          '',
          `Validation errors: ${validationErrors}`,
          '',
          `Previous response: ${JSON.stringify(
            redact.sanitize(rawOutput),
          )}`,
          '',
          'Return one corrected JSON object only.',
          'Do not return a progress or placeholder MESSAGE.',
          'If the original question requires current Netwatch data, return SQL_QUERY.',
        ].join('\n'),
      },
    ],
    1600,
  );
}

function normalizeTaskReference(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ');
}

function extractTaskReference(question) {
  const value = String(question || '').trim();
  const named = value.match(/\b(\d{1,6}\s*-\s*[a-z0-9._]+)\b/i);
  if (named) return named[1].trim().replace(/\s*-\s*/g, '-');
  const numeric = value.match(/\b(\d{1,6})\b/);
  return numeric ? numeric[1] : null;
}

function deriveConversationFocus(question, previousFocus = {}) {
  const value = String(question || '').toLowerCase();
  const next = { ...(previousFocus || {}) };
  const application = /\bapplications?\b/.test(value);
  const ping = /\bping\b|\bsystem tasks?\b/.test(value);

  if (application || ping) {
    next.taskType = application ? 'APPLICATION' : 'PING';
  } else if (/\b(all|fault|ok|current)\s+tasks?\b|\btask status\b/.test(value)) {
    delete next.taskType;
  }

  if (/\bfault\b|\bfailed\b|\bfailing\b/.test(value)) next.status = 'FAULT';
  else if (/\bok\b|\bhealthy\b|\bpassing\b/.test(value)) next.status = 'OK';
  else if (/\ball tasks?\b|\bcurrent task status\b/.test(value)) delete next.status;

  const taskName = extractTaskReference(question);
  if (taskName) next.taskName = taskName;
  else if (/\b(all|fault|ok|current)\s+tasks?\b|\bopen incidents?\b/.test(value)) delete next.taskName;

  return next;
}

function sqlPlan(sql, parameters, purpose, expectedColumns, conversationFocus) {
  return {
    type: 'SQL_QUERY',
    query: { sql, parameters, purpose, expectedColumns },
    ...(conversationFocus ? { conversationFocus } : {}),
  };
}

function deterministicPlan(question, maxRows = 100, focus = {}) {
  const value = String(question || '').trim().toLowerCase();
  const taskRef = extractTaskReference(question);
  const limit = Math.min(50, Math.max(1, Number(maxRows) || 100));

  if (/\b(admin|administrator|administrators)\b/.test(value) && /\b(email|emails|contact|contacts|address|addresses)\b/.test(value)) {
    return sqlPlan(
      'SELECT email, role FROM ai_public_administrator_contacts ORDER BY email LIMIT $1',
      [Math.min(25, limit)],
      'Retrieve approved administrator contact email addresses.',
      ['email', 'role'],
    );
  }

  if (/summari[sz]e\s+(the\s+)?current\s+task\s+status/.test(value) || /current\s+task\s+status/.test(value) || /task\s+status\s+summary/.test(value)) {
    return sqlPlan(
      'SELECT task_type, status, COUNT(*) AS task_count FROM ai_public_task_details GROUP BY task_type, status ORDER BY task_type, status LIMIT $1',
      [limit],
      'Summarize current Netwatch task status by task type and status.',
      ['task_type', 'status', 'task_count'],
    );
  }

  if (/(?:give|show|list).*\bfault\b.*\bapplication\b.*\btasks?\b|\bfault\s+application\s+tasks?\b/.test(value)) {
    return sqlPlan(
      'SELECT task_id, task_name, task_type, status, is_active, last_checked, availability_percent, failure_count, open_incident, incident_started_at, latest_failure, target, url FROM ai_public_task_details WHERE task_type = $1 AND status = $2 ORDER BY task_name LIMIT $3',
      ['APPLICATION', 'FAULT', Math.min(25, limit)],
      'Retrieve details of application tasks currently in FAULT.',
      ['task_id','task_name','task_type','status','is_active','last_checked','availability_percent','failure_count','open_incident','incident_started_at','latest_failure','target','url'],
      { taskType: 'APPLICATION', status: 'FAULT' },
    );
  }

  if (/\b(show|give|list|display|summari[sz]e)\b.*\bfault\b.*\btasks?\b/.test(value) && !/\bapplication\b/.test(value) && !/\bping\b|\bsystem\b/.test(value)) {
    return sqlPlan(
      'SELECT task_id, task_name, task_type, status, is_active, last_checked, availability_percent, failure_count, open_incident, incident_started_at, latest_failure, target, url FROM ai_public_task_details WHERE status = $1 ORDER BY task_type, task_name LIMIT $2',
      ['FAULT', limit],
      'Retrieve all Netwatch tasks currently in FAULT.',
      ['task_id','task_name','task_type','status','is_active','last_checked','availability_percent','failure_count','open_incident','incident_started_at','latest_failure','target','url'],
      { status: 'FAULT' },
    );
  }

  if (/summari[sz]e\s+(the\s+)?open\s+incidents|show\s+(the\s+)?open\s+incidents/.test(value)) {
    return sqlPlan(
      'SELECT task_id, task_name, task_type, status, incident_started_at, l1_sent_at, l2_sent_at, l3_sent_at, alerted_tiers, latest_failure FROM ai_public_incident_timeline ORDER BY incident_started_at DESC LIMIT $1',
      [limit],
      'Summarize currently open Netwatch incidents.',
      ['task_id','task_name','task_type','status','incident_started_at','l1_sent_at','l2_sent_at','l3_sent_at','alerted_tiers','latest_failure'],
    );
  }

  if (taskRef && /\b(recent checks?|check history|checks? history)\b/.test(value)) {
    const numeric = /^\d+$/.test(taskRef);
    const where = numeric
      ? 'task_type = $1 AND LOWER(task_name) LIKE LOWER($2)'
      : "LOWER(REGEXP_REPLACE(task_name, '\\s*-\\s*', '-', 'g')) = $1";
    const parameters = numeric ? ['PING', `${taskRef}%`, Math.min(25, limit)] : [normalizeTaskReference(taskRef), Math.min(25, limit)];
    const limitParam = numeric ? '$3' : '$2';
    const asksFaultStart = /\bwhen\b.*\bfault\b|\bfault.*\bhappen/.test(value);
    const historySql = asksFaultStart
      ? `SELECT h.task_id, h.task_name, h.task_type, h.checked_at, h.result, h.response_ms, h.error_sanitized, i.incident_started_at FROM ai_public_task_check_history h LEFT JOIN ai_public_incident_timeline i ON i.task_id = h.task_id WHERE ${where.replaceAll('task_type', 'h.task_type').replaceAll('task_name', 'h.task_name')} ORDER BY h.checked_at DESC LIMIT ${limitParam}`
      : `SELECT task_id, task_name, task_type, checked_at, result, response_ms, error_sanitized FROM ai_public_task_check_history WHERE ${where} ORDER BY checked_at DESC LIMIT ${limitParam}`;
    return sqlPlan(
      historySql,
      parameters,
      asksFaultStart ? `Retrieve recent checks and current incident start for ${taskRef}.` : `Retrieve recent checks for ${taskRef}.`,
      asksFaultStart
        ? ['task_id','task_name','task_type','checked_at','result','response_ms','error_sanitized','incident_started_at']
        : ['task_id','task_name','task_type','checked_at','result','response_ms','error_sanitized'],
      { ...focus, taskType: numeric ? 'PING' : focus.taskType, taskName: taskRef },
    );
  }

  if (taskRef && (/\bwhen\b.*\bfault\b/.test(value) || /\bhow long\b.*\bfault\b/.test(value) || /\bfault duration\b/.test(value))) {
    const numeric = /^\d+$/.test(taskRef);
    const where = numeric
      ? 'task_type = $1 AND LOWER(task_name) LIKE LOWER($2)'
      : "LOWER(REGEXP_REPLACE(task_name, '\\s*-\\s*', '-', 'g')) = $1";
    const parameters = numeric ? ['PING', `${taskRef}%`, 5] : [normalizeTaskReference(taskRef), 5];
    const limitParam = numeric ? '$3' : '$2';
    return sqlPlan(
      `SELECT task_id, task_name, task_type, status, incident_started_at, latest_failure FROM ai_public_incident_timeline WHERE ${where} ORDER BY incident_started_at DESC LIMIT ${limitParam}`,
      parameters,
      `Determine when ${taskRef} entered FAULT and how long the incident has been open.`,
      ['task_id','task_name','task_type','status','incident_started_at','latest_failure'],
      { ...focus, taskType: numeric ? 'PING' : focus.taskType, taskName: taskRef, status: 'FAULT' },
    );
  }

  return null;
}

async function plan({
  question,
  scope,
  history,
  focus,
  knowledge,
}) {
  const q = String(question).trim();
  const effectiveFocus = deriveConversationFocus(q, focus);

  if (greet.test(q)) {
    return {
      type: 'MESSAGE',
      content:
        'Hello! I can help with Netwatch tasks, failures, incidents, availability, approved URLs and contacts, host mappings, and sanitized diagnostics.',
    };
  }

  if (secret.test(q)) {
    return {
      type: 'DENIED',
      code: 'NEVER_EXPOSE',
      content:
        'That information is blocked for every scope. I can help with approved sanitized monitoring data.',
    };
  }

  if (write.test(q)) {
    return {
      type: 'DENIED',
      code: 'READ_ONLY_ONLY',
      content:
        'Netwatch AI is read-only and cannot perform that action. I can show the current state instead.',
    };
  }
  
  const deterministic =
  deterministicPlan(
    q,
    Number(
      process.env.SQL_MAX_ROWS || 100,
    ),
    effectiveFocus,
  );

if (deterministic) {
  deterministic.query.sql =
    safeSQL(
      deterministic.query.sql,
      views(knowledge, scope),
    );

  return deterministic;
}

  const messages = [
  {
    role: 'system',

    content: prompt(
      scope,
      knowledge,
      effectiveFocus,
    ),
  },

  ...history
    .slice(-10)
    .map((item) => ({
      role: item.role,

      content: redact
        .text(item.content)
        .slice(0, 3000),
    })),

  {
    role: 'user',
    content: q.slice(0, 4000),
  },
];

const rawOutput =
  await provider.complete(
    messages,
    1600,
  );

let out =
  normalizePlan(rawOutput);

let needsRepair =
  !valid(out);

if (
  out?.type === 'MESSAGE' &&
  requiresDatabase(q) &&
  isPlaceholderMessage(out.content)
) {
  needsRepair = true;
}

if (needsRepair) {
  const firstErrors =
    valid.errors
      ? ajv.errorsText(valid.errors)
      : 'A database question returned a placeholder MESSAGE.';

  console.error(
    '[AI PLAN REPAIR]',
    {
      errors: firstErrors,
      output:
        redact.sanitize(rawOutput),
      normalized:
        redact.sanitize(out),
    },
  );

  const repairedRaw =
    await repairPlan({
      rawOutput,
      validationErrors: firstErrors,
      originalQuestion: q,
      scope,
      focus: effectiveFocus,
      knowledge,
    });

  out =
    normalizePlan(repairedRaw);
}

if (!valid(out)) {
  console.error(
    '[AI PLAN VALIDATION FAILED]',
    {
      errors: valid.errors,
      output: redact.sanitize(out),
    },
  );

  throw Object.assign(
    new Error(
      ajv.errorsText(valid.errors),
    ),
    {
      code:
        'INVALID_STRUCTURED_OUTPUT',
    },
  );
}

if (
  out.type === 'MESSAGE' &&
  requiresDatabase(q) &&
  isPlaceholderMessage(out.content)
) {
  console.error(
    '[AI PLACEHOLDER MESSAGE REJECTED]',
    {
      question:
        redact.text(q),
      output:
        redact.sanitize(out),
    },
  );

  throw Object.assign(
    new Error(
      'Database question produced a placeholder response.',
    ),
    {
      code:
        'INVALID_STRUCTURED_OUTPUT',
    },
  );
}

if (out.type === 'SQL_QUERY') {
  out.query.sql =
    safeSQL(
      out.query.sql,
      views(knowledge, scope),
    );

  out.query.parameters =
    redact.sanitize(
      out.query.parameters,
    );

  out.query.expectedColumns =
    out.query.expectedColumns
      .map(String)
      .map((column) => column.trim())
      .filter(Boolean);
}

return out;
}
async function analyze({
  question,
  queryResult,
  knowledge,
}) {
  const safe = redact.sanitize(queryResult);

  const rows = Array.isArray(safe.rows)
    ? safe.rows
    : [];

  const count = Number(
    safe.rowCount ?? rows.length,
  );

  if (count === 0) {
  let content =
    'No approved records matched your request.';

  const normalizedQuestion =
    String(question || '').toLowerCase();

  if (
    normalizedQuestion.includes(
      'fault application',
    )
  ) {
    content =
      'No application tasks are currently in FAULT.';
  } else if (
    normalizedQuestion.includes(
      'open incident',
    )
  ) {
    content =
      'There are currently no open incidents.';
  } else if (
    normalizedQuestion.includes(
      'check history',
    )
  ) {
    content =
      'No approved check-history records matched the requested filters.';
  }

  return {
    type: 'MESSAGE',
    content,
    details: [],
    sanitized: true,

    dataMeta: {
      operation: 'SQL_QUERY',
      rowCount: 0,
      sanitized: true,
    },
  };
}

  if (
    /how many|count/i.test(question) &&
    rows.length === 1
  ) {
    const n = Object.values(rows[0]).find(
      (value) =>
        typeof value === 'number' ||
        /^\d+$/.test(String(value)),
    );

    if (n != null) {
      return {
        type: 'MESSAGE',
        content:
          `There are ${n} matching records.`,
        details: rows,
        sanitized: true,

        dataMeta: {
          operation: 'SQL_QUERY',
          rowCount: count,
          sanitized: true,
        },
      };
    }
  }

  const out = await provider.complete(
    [
      {
        role: 'system',
        content: `
Analyze only this sanitized Netwatch query result.

Give a specific useful answer and never invent facts.

Return JSON:
{
  "type": "MESSAGE",
  "content": "..."
}

Knowledge:
${knowledge.raw}
`,
      },

      {
        role: 'user',
        content:
          `Question: ${question}\n` +
          `Result: ${JSON.stringify(safe).slice(
            0,
            131072,
          )}`,
      },
    ],
    1200,
  );

  const content = redact.text(
    out.content || '',
  );

  if (
    content.length < 12 ||
    /^(the answer|answer|result|ok)$/i.test(
      content,
    )
  ) {
    throw Object.assign(
      new Error('Weak analysis'),
      {
        code: 'WEAK_ANALYSIS',
      },
    );
  }

  return {
    type: 'MESSAGE',
    content,
    details: rows,
    sanitized: true,

    dataMeta: {
      operation: 'SQL_QUERY',
      rowCount: count,
      sanitized: true,
    },
  };
}

module.exports = {
  plan,
  analyze,
  safeSQL,
  deriveConversationFocus,
  deterministicPlan,
};