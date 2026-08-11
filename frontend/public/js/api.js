// Netwatch browser API client. Empty backendUrl means same-origin Nginx /api proxy.
const API = {
  base: () => String(window.NW_CONFIG?.backendUrl ?? '').replace(/[/]$/, ''),
  async req(method, path, body, isForm = false) {
    const options = { method, credentials: 'include', headers: isForm ? {} : { 'Content-Type': 'application/json' } };
    if (body !== undefined && body !== null) options.body = isForm ? body : JSON.stringify(body);
    let response;
    try { response = await fetch(API.base() + path, options); }
    catch (cause) { throw { status: 0, code: 'NETWORK_ERROR', message: 'Unable to reach the Netwatch backend.', cause }; }
    const type = response.headers.get('content-type') || '';
    const data = type.includes('json') ? await response.json().catch(() => ({})) : await response.text();
    if (!response.ok) {
      const nested = data?.error;
      const message = data?.content || nested?.message || (typeof nested === 'string' ? nested : '') || data?.message || (typeof data === 'string' ? data : '') || `Request failed with HTTP ${response.status}`;
      throw { status: response.status, code: data?.code || nested?.code || 'REQUEST_FAILED', message, retryable: Boolean(data?.retryable), retryAfterSeconds: Number(data?.retryAfterSeconds || 0), data };
    }
    return data;
  },
  get: path => API.req('GET', path), post: (path, body) => API.req('POST', path, body), put: (path, body) => API.req('PUT', path, body), patch: (path, body) => API.req('PATCH', path, body), del: path => API.req('DELETE', path), upload: (path, form) => API.req('POST', path, form, true),
  login: (u,p) => API.post('/api/auth/login',{username:u,password:p}), logout: () => API.post('/api/auth/logout'), me: () => API.get('/api/auth/me'),
  users: () => API.get('/api/users'), createUser: body => API.post('/api/users',body), updateUser: (id,body) => API.put(`/api/users/${id}`,body), deleteUser: id => API.del(`/api/users/${id}`),
  tasks: () => API.get('/api/tasks'), tasksBin: () => API.get('/api/tasks/bin'), task: id => API.get(`/api/tasks/${id}`), createTask: body => API.post('/api/tasks',body), updateTask: (id,body) => API.put(`/api/tasks/${id}`,body), deleteTask: id => API.del(`/api/tasks/${id}`), restoreTask: id => API.post(`/api/tasks/${id}/restore`), hardDelete: id => API.del(`/api/tasks/${id}/hard`), runTask: id => API.post(`/api/tasks/${id}/run`), testTask: body => API.post('/api/tasks/test',body), toggleEmail: id => API.patch(`/api/tasks/${id}/email-toggle`), toggleActive: id => API.patch(`/api/tasks/${id}/active-toggle`),
  publicSummary: () => API.get('/api/tasks/public/summary'), publicTaskDetail: id => API.get(`/api/tasks/public/${id}`),
  logs: q => API.get('/api/logs/app?' + new URLSearchParams(q)), audit: q => API.get('/api/logs/audit?' + new URLSearchParams(q || {})), health: () => API.get('/api/logs/health'), testMail: to => API.post('/api/logs/test-email',{to}), logsDownloadUrl: (range,category,format='json') => `${API.base()}/api/logs/download?range=${range}&category=${category}&format=${format}`, logArchives: () => API.get('/api/logs/archives'),
  exportUrl: () => API.base() + '/api/backup/export', importPreview: file => { const fd=new FormData(); fd.append('file',file); return API.upload('/api/backup/import-preview',fd); }, importApply: (session_id,action,selected_ping_ids,selected_app_ids) => API.post('/api/backup/import-apply',{session_id,action,selected_ping_ids,selected_app_ids}),
  aiStatus: () => API.get('/api/ai/status'),
  aiCreateSession: () => API.post('/api/ai/sessions',{}),
  aiMessage: (id,question) => API.post(`/api/ai/sessions/${encodeURIComponent(id)}/messages`,{question}),
  aiResetSession: id => API.post(`/api/ai/sessions/${encodeURIComponent(id)}/reset`,{}),
  aiCloseSession: id => API.del(`/api/ai/sessions/${encodeURIComponent(id)}`),
};
