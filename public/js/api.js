/**
 * 后端接口封装。
 * 页面组件不直接碰存储 —— 全部走这里，这也是将来换成后端 API 时唯一要改的地方。
 */

async function req(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('连不上本地服务。请确认那个命令行窗口还开着（node server/server.js）。');
  }

  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    if (!res.ok) throw new Error(`服务器返回 ${res.status}`);
    return res;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    if (data.code) err.code = data.code;
    throw err;
  }
  return data;
}

export const api = {
  // 一次性拿到工作台要的数据
  bootstrap: () => req('GET', '/api/bootstrap'),

  // 任务
  listTasks: (filter) => req('GET', `/api/tasks${filter ? `?filter=${filter}` : ''}`).then((d) => d.tasks),
  createTask: (payload) => req('POST', '/api/tasks', payload).then((d) => d.task),
  patchTask: (id, payload) => req('PATCH', `/api/tasks/${id}`, payload).then((d) => d.task),
  deleteTask: (id) => req('DELETE', `/api/tasks/${id}`),

  // 计划
  listPlans: () => req('GET', '/api/plans').then((d) => d.plans),
  createPlan: (payload) => req('POST', '/api/plans', payload).then((d) => d.plan),
  patchPlan: (id, payload) => req('PATCH', `/api/plans/${id}`, payload).then((d) => d.plan),
  deletePlan: (id) => req('DELETE', `/api/plans/${id}`),
  planTasks: (id) => req('GET', `/api/plans/${id}/tasks`).then((d) => d.tasks),

  // 对话
  listConversations: () => req('GET', '/api/conversations').then((d) => d.conversations),
  createConversation: (payload) => req('POST', '/api/conversations', payload || {}).then((d) => d.conversation),
  getConversation: (id) => req('GET', `/api/conversations/${id}`).then((d) => d.conversation),
  patchConversation: (id, payload) => req('PATCH', `/api/conversations/${id}`, payload).then((d) => d.conversation),
  deleteConversation: (id) => req('DELETE', `/api/conversations/${id}`),
  sendMessage: (id, content) => req('POST', `/api/conversations/${id}/messages`, { content }),
  patchProblemCard: (id, messageId, payload) =>
    req('PATCH', `/api/conversations/${id}/messages/${messageId}`, payload).then((d) => d.conversation),

  // 行动方案
  patchProposal: (id, proposalId, payload) =>
    req('PATCH', `/api/conversations/${id}/proposals/${proposalId}`, payload).then((d) => d.conversation),
  confirmProposal: (id, proposalId, payload) =>
    req('POST', `/api/conversations/${id}/proposals/${proposalId}/confirm`, payload),
  dismissProposal: (id, proposalId) =>
    req('POST', `/api/conversations/${id}/proposals/${proposalId}/dismiss`, {}),

  // 档案
  listArchives: (params = {}) => {
    const q = new URLSearchParams(params).toString();
    return req('GET', `/api/archives${q ? `?${q}` : ''}`).then((d) => d.archives);
  },
  getArchive: (id) => req('GET', `/api/archives/${id}`).then((d) => d.archive),
  createArchive: (payload) => req('POST', '/api/archives', payload).then((d) => d.archive),
  patchArchive: (id, payload) => req('PATCH', `/api/archives/${id}`, payload).then((d) => d.archive),
  deleteArchive: (id) => req('DELETE', `/api/archives/${id}`),

  // 设置
  settings: () => req('GET', '/api/settings'),
  patchSettings: (payload) => req('PATCH', '/api/settings', payload),

  // AI 引擎状态（含本机 Ollama 探测）
  aiStatus: (refresh) => req('GET', `/api/ai/status${refresh ? '?refresh=1' : ''}`),

  // 专注（番茄钟）
  listFocus: () => req('GET', '/api/focus'),
  createFocusSession: (payload) => req('POST', '/api/focus/sessions', payload).then((d) => d),
  undoFocusSession: (id) => req('POST', `/api/focus/sessions/${id}/undo`, {}).then((d) => d),

  // 进行中的这一轮：浏览器与桌面浮窗共用
  activeFocus: () => req('GET', '/api/focus/active'),
  startActiveFocus: (payload) => req('POST', '/api/focus/active', payload),
  patchActiveFocus: (action) => req('PATCH', '/api/focus/active', { action }),
  finishActiveFocus: (payload) => req('POST', '/api/focus/active/finish', payload || {}),
  cancelActiveFocus: () => req('POST', '/api/focus/active/cancel', {}),

  // 桌面浮窗（需要 Electron；没装时由服务端给出明确提示）
  launchFloat: () => req('POST', '/api/float/launch', {}),

  // 教材精读
  listTextbooks: () => req('GET', '/api/textbooks').then((d) => d.textbooks),
  importTextbook: (payload) => req('POST', '/api/textbooks/import', payload).then((d) => d),
  analyzeTextbook: (id) => req('POST', `/api/textbooks/${id}/analyze`, {}).then((d) => d),
  getTextbook: (id) => req('GET', `/api/textbooks/${id}`).then((d) => d.book),
  patchTextbook: (id, payload) => req('PATCH', `/api/textbooks/${id}`, payload).then((d) => d.book),
  deleteTextbook: (id) => req('DELETE', `/api/textbooks/${id}`),
  getTextbookSection: (id, sectionId) =>
    req('GET', `/api/textbooks/${id}/sections/${sectionId}`),
  patchTextbookSection: (id, sectionId, payload) =>
    req('PATCH', `/api/textbooks/${id}/sections/${sectionId}`, payload).then((d) => d),
  explainTextbookSection: (id, sectionId, refresh = false) =>
    req('POST', `/api/textbooks/${id}/sections/${sectionId}/explain`, { refresh }),
  chatTextbookSection: (id, sectionId, question) =>
    req('POST', `/api/textbooks/${id}/sections/${sectionId}/chat`, { question }),
  uploadTextbookFile: async (id, file) => {
    let res;
    try {
      res = await fetch(`/api/textbooks/${id}/file?name=${encodeURIComponent(file.name || '教材.pdf')}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: file,
      });
    } catch {
      throw new Error('原始 PDF 没有传上去，但教材文字已经保存在本地。');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `原始 PDF 上传失败（${res.status}）`);
    return data;
  },
};
