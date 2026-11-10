'use strict';

/**
 * 数据模型（PRD 5.1 – 5.6）
 * ---------------------------------------------------------------
 * 每个模型都集中定义：默认值、字段校验、对外形状。
 * 这样页面和数据层都不用自己猜字段，也不会写出「有时是字符串有时是数组」的字段。
 */

const { newId, nowIso } = require('./db');

// ---------------------------------------------------------------- 枚举

const TASK_STATUS = ['todo', 'doing', 'done'];          // 待开始 / 进行中 / 已完成
const TASK_PRIORITY = ['normal', 'important'];          // 普通 / 重要
const TASK_SOURCE = ['manual', 'ai'];                   // 手动创建 / AI 建议生成
const PLAN_STATUS = ['active', 'done', 'archived'];     // 进行中 / 已完成 / 已归档
const PROPOSAL_STATUS = ['pending', 'confirmed', 'dismissed'];
const ARCHIVE_TYPE = ['thought', 'summary', 'plan'];    // 思考档案 / 重要摘要 / 学习计划
const FOCUS_MODE = ['focus', 'break'];                  // 专注 / 休息

const TASK_STATUS_LABEL = { todo: '待开始', doing: '进行中', done: '已完成' };
const TASK_PRIORITY_LABEL = { normal: '普通', important: '重要' };
const PLAN_STATUS_LABEL = { active: '进行中', done: '已完成', archived: '已归档' };
const ARCHIVE_TYPE_LABEL = { thought: '思考档案', summary: '重要摘要', plan: '学习计划' };

// ---------------------------------------------------------------- 校验工具

function str(v, max = 2000) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function oneOf(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

/** 日期字段统一成 YYYY-MM-DD；空值保留 null，不塞空字符串 */
function dateOnly(v) {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- Task

function newTask(input = {}) {
  const now = nowIso();
  return {
    id: newId('task'),
    title: str(input.title, 200) || '未命名任务',
    description: str(input.description, 2000),
    status: oneOf(input.status, TASK_STATUS, 'todo'),
    priority: oneOf(input.priority, TASK_PRIORITY, 'normal'),
    planId: input.planId ? str(input.planId, 64) : null,
    /** 可选：任务属于哪个学习项目 / 课程；没有就保持 null */
    projectId: input.projectId ? str(input.projectId, 64) : null,
    courseId: input.courseId ? str(input.courseId, 64) : null,
    scheduledDate: dateOnly(input.scheduledDate),
    dueDate: dateOnly(input.dueDate),
    source: oneOf(input.source, TASK_SOURCE, 'manual'),
    sourceProposalId: input.sourceProposalId ? str(input.sourceProposalId, 64) : null,
    /** 从 AI 对话里建的任务：能顺着 id 回到那次对话和那一条回复 */
    sourceConversationId: input.sourceConversationId ? str(input.sourceConversationId, 64) : null,
    sourceMessageId: input.sourceMessageId ? str(input.sourceMessageId, 64) : null,
    /** 从精读 / 外刊问答一键转成的待办：记下从哪篇文章、哪本教材来 */
    sourceKind: input.sourceKind === 'reading' ? 'reading' : null,
    sourceRefId: input.sourceRefId ? str(input.sourceRefId, 128) : null,
    sourceLabel: input.sourceLabel ? str(input.sourceLabel, 120) : null,
    createdAt: now,
    updatedAt: now,
    /** 只有真正完成时才有值；恢复为未完成时清回 null */
    completedAt: input.status === 'done' ? now : null,
  };
}

/**
 * 更新任务。只接受白名单字段——这样即使请求里混进奇怪的东西，
 * 也不会污染数据。
 */
function patchTask(task, patch = {}) {
  if (typeof patch.title === 'string') task.title = str(patch.title, 200) || task.title;
  if (typeof patch.description === 'string') task.description = str(patch.description, 2000);
  if (TASK_STATUS.includes(patch.status)) {
    task.status = patch.status;
    if (patch.status === 'done') {
      if (!task.completedAt) task.completedAt = nowIso();
    } else {
      // 恢复为未完成时，完成时间必须清掉，否则界面会显示矛盾的状态
      task.completedAt = null;
    }
  }
  if (TASK_PRIORITY.includes(patch.priority)) task.priority = patch.priority;
  if (patch.planId !== undefined) task.planId = patch.planId ? str(patch.planId, 64) : null;
  if (patch.projectId !== undefined) task.projectId = patch.projectId ? str(patch.projectId, 64) : null;
  if (patch.courseId !== undefined) task.courseId = patch.courseId ? str(patch.courseId, 64) : null;
  // 没有项目就不可能还挂在一门课下面
  if (!task.projectId) task.courseId = null;
  if (patch.scheduledDate !== undefined) task.scheduledDate = dateOnly(patch.scheduledDate);
  if (patch.dueDate !== undefined) task.dueDate = dateOnly(patch.dueDate);
  return task;
}

/** 判断任务是否属于「今天」：今天要做的、或今天到期的 */
function isToday(task, today = todayStr()) {
  return task.scheduledDate === today || task.dueDate === today;
}

/** 是否已过期（有截止日期、已过、且没完成） */
function isOverdue(task, today = todayStr()) {
  return Boolean(task.dueDate && task.dueDate < today && task.status !== 'done');
}

// ---------------------------------------------------------------- Plan

function newPlan(input = {}) {
  const now = nowIso();
  return {
    id: newId('plan'),
    title: str(input.title, 200) || '未命名计划',
    description: str(input.description, 2000),
    status: oneOf(input.status, PLAN_STATUS, 'active'),
    startDate: dateOnly(input.startDate),
    endDate: dateOnly(input.endDate),
    createdAt: now,
    updatedAt: now,
  };
}

function patchPlan(plan, patch = {}) {
  if (typeof patch.title === 'string') plan.title = str(patch.title, 200) || plan.title;
  if (typeof patch.description === 'string') plan.description = str(patch.description, 2000);
  if (PLAN_STATUS.includes(patch.status)) plan.status = patch.status;
  if (patch.startDate !== undefined) plan.startDate = dateOnly(patch.startDate);
  if (patch.endDate !== undefined) plan.endDate = dateOnly(patch.endDate);
  return plan;
}

// ---------------------------------------------------------------- Conversation / Message

function newMessage(input = {}) {
  return {
    id: newId('msg'),
    role: oneOf(input.role, ['user', 'assistant'], 'user'),
    content: str(input.content, 8000),
    createdAt: nowIso(),
    /** 这一轮 AI 附带的「问题梳理卡」，可编辑；没有就是 null */
    problemCard: input.problemCard || null,
    /** 这一轮 AI 附带的「行动方案卡」的 id */
    proposalId: input.proposalId || null,
    /** 明确标注这条回复来自哪个引擎（PRD 7.3 / 10）：规则引擎 / 本地 Ollama / 远程模型 */
    provider: oneOf(input.provider, ['mock', 'ollama', 'real'], 'mock'),
    /** 可选的调用信息，例如 Ollama 的模型名与耗时；只用于显示，不参与逻辑 */
    meta: input.meta || null,
    /**
     * 这一轮实际引用的学习数据快照：只有选择范围、来源和统计。
     * 不保存完整摘要，避免把学习数据写进历史对话。
     */
    context: input.context || null,
    /**
     * 这一轮智能体真的动手做了什么：只留工具名、成败、一句人话摘要和
     * 「直接建了几条待办」。用来显示「它查了 / 它建了什么」，没动手就是 null。
     */
    actions: Array.isArray(input.actions) && input.actions.length
      ? input.actions.slice(0, 6).map((a) => ({
          tool: str(a && a.tool, 40),
          ok: Boolean(a && a.ok),
          summary: str(a && a.summary, 300),
          createdCount: Math.max(0, Number(a && a.createdCount) || 0),
        }))
      : null,
  };
}

function newConversation(input = {}) {
  const now = nowIso();
  return {
    id: newId('conv'),
    title: str(input.title, 120) || '新的对话',
    createdAt: now,
    updatedAt: now,
    messages: [],
    /** 一个对话可以产生多个行动方案 */
    proposals: [],
    /** 记录已经问过的话题，避免每轮重复问同样的问题 */
    asked: [],
    /**
     * 上一轮问了关键问题、正在等用户回答时，记下当时想做的事。
     * 用户下一句往往只是简短回答（「数学一和英语一」），本身看不出意图，
     * 所以要接着上一轮的意图走，不能当成一次新的闲聊。
     */
    pendingIntent: null,
    /** 从对话里已经确认过的行动 id，用于防止重复创建 */
    confirmedActionIds: [],
    /**
     * 用户明确选择的学习数据范围（项目 / 窗口 / 待办）。
     * 只保存选择本身；真正发送给模型的事实每轮重新构建，不写进历史消息。
     */
    context: null,
    /** 这个对话选用的模型（providerId/modelId 或 'mock'）；null = 跟随全局默认 */
    modelRef: input.modelRef ? str(input.modelRef, 128) : null,
  };
}

// ---------------------------------------------------------------- ActionProposal

/**
 * 行动方案（PRD 5.5）
 * 每一项建议行动都有自己的稳定 id：
 *   · 用户可以只选其中几项
 *   · 重复确认时靠 createdTaskId 判断是否已经创建过，避免重复生成任务
 */
function newProposal(input = {}) {
  return {
    id: newId('prop'),
    conversationId: input.conversationId || null,
    title: str(input.title, 200) || '行动方案',
    summary: str(input.summary, 2000),
    actions: Array.isArray(input.actions)
      ? input.actions.map((a, i) => ({
          id: a.id || `act-${i + 1}`,
          title: str(a.title, 200) || '一步',
          detail: str(a.detail, 1000),
          scheduledDate: dateOnly(a.scheduledDate),
          dueDate: dateOnly(a.dueDate),
          planId: a.planId ? str(a.planId, 64) : null,
          estimateMinutes: typeof a.estimateMinutes === 'number' ? Math.max(1, Math.min(600, a.estimateMinutes)) : null,
          doneStandard: str(a.doneStandard, 300),
          /** 确认创建后写入任务 id；有值就说明已经创建过 */
          createdTaskId: null,
        }))
      : [],
    /** 尚未确定、不加入今日待办的事项（PRD 4.2） */
    pendingItems: Array.isArray(input.pendingItems)
      ? input.pendingItems.map((x) => str(typeof x === 'string' ? x : x && x.text, 300)).filter(Boolean)
      : [],
    status: oneOf(input.status, PROPOSAL_STATUS, 'pending'),
    createdAt: nowIso(),
    confirmedAt: null,
    dismissedAt: null,
  };
}

// ---------------------------------------------------------------- Archive

function newArchive(input = {}) {
  const now = nowIso();
  return {
    id: newId('arc'),
    title: str(input.title, 200) || '未命名档案',
    content: str(input.content, 20000),
    type: oneOf(input.type, ARCHIVE_TYPE, 'summary'),
    sourceConversationId: input.sourceConversationId ? str(input.sourceConversationId, 64) : null,
    /** 来源说明，界面要能清楚区分「原始记录」和「AI 整理内容」 */
    origin: oneOf(input.origin, ['manual', 'ai', 'legacy'], 'manual'),
    /** 第一版遗留记录的 id，迁移过来后保留可追溯 */
    legacyEntryId: input.legacyEntryId ? str(input.legacyEntryId, 64) : null,
    createdAt: now,
    updatedAt: now,
  };
}

function patchArchive(archive, patch = {}) {
  if (typeof patch.title === 'string') archive.title = str(patch.title, 200) || archive.title;
  if (typeof patch.content === 'string') archive.content = str(patch.content, 20000);
  if (ARCHIVE_TYPE.includes(patch.type)) archive.type = patch.type;
  return archive;
}

// ---------------------------------------------------------------- FocusSession（番茄钟）

/**
 * 一次「自然结束或被主动完成」的专注记录。
 *
 * 计时本身在浏览器里进行（刷新不丢），这里只保存已经完成的结果。
 * 任务自动勾选发生在服务端：先记下任务原状态，撤销时才能准确还原。
 */
function newFocusSession(input = {}) {
  const now = nowIso();
  const minutes = (() => {
    const n = Number(input.minutes);
    return Number.isFinite(n) ? Math.max(1, Math.min(180, Math.round(n))) : 25;
  })();
  const actualSeconds = (() => {
    const n = Number(input.actualSeconds);
    return Number.isFinite(n) ? Math.max(1, Math.min(12 * 3600, Math.round(n))) : minutes * 60;
  })();
  const startedAt = input.startedAt && !Number.isNaN(new Date(input.startedAt).getTime())
    ? new Date(input.startedAt).toISOString()
    : now;
  const endedAt = input.endedAt && !Number.isNaN(new Date(input.endedAt).getTime())
    ? new Date(input.endedAt).toISOString()
    : now;

  return {
    id: newId('focus'),
    /** 客户端生成的幂等标记：断网重试时服务端据此避免重复记录 */
    clientToken: input.clientToken ? str(input.clientToken, 80) : null,
    mode: oneOf(input.mode, FOCUS_MODE, 'focus'),
    title: str(input.title, 160) || '专注',
    taskId: input.taskId ? str(input.taskId, 64) : null,
    planId: input.planId ? str(input.planId, 64) : null,
    /** 计划时长（分钟），用于展示 */
    minutes,
    /** 实际专注了多久（秒）；提前完成时可能小于计划时长 */
    actualSeconds,
    startedAt,
    endedAt,
    /** 是否由这次计时自动把关联任务勾成了已完成 */
    autoCompleted: Boolean(input.autoCompleted),
    taskCompleted: Boolean(input.taskCompleted),
    /** 勾选之前的任务状态，撤销时按它还原 */
    taskPreviousStatus: ['todo', 'doing', 'done'].includes(input.taskPreviousStatus)
      ? input.taskPreviousStatus
      : null,
    undoneAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 正在进行中的这一轮专注（服务端唯一记录）。
 * 结束时间由服务端算好，浏览器和桌面浮窗都只负责显示；暂停时保存剩余毫秒数。
 */
function newActiveFocus(input = {}) {
  const now = Date.now();
  const minutes = (() => {
    const n = Number(input.minutes);
    return Number.isFinite(n) ? Math.max(1, Math.min(180, Math.round(n))) : 25;
  })();
  // 浏览器离线走过一段再交上来时，保留剩余时间，而不是重新从整段开始
  const totalMs = minutes * 60 * 1000;
  const left = Number.isFinite(Number(input.remainingMs))
    ? Math.max(1000, Math.min(totalMs, Math.round(Number(input.remainingMs))))
    : totalMs;
  const startedDate = input.startedAt ? new Date(input.startedAt) : null;
  const startedAt = startedDate && !Number.isNaN(startedDate.getTime()) && startedDate.getTime() <= now
    ? startedDate.toISOString()
    : new Date(now).toISOString();
  return {
    token: /^[A-Za-z0-9_-]{8,80}$/.test(String(input.token || '')) ? String(input.token) : newId('focus'),
    mode: oneOf(input.mode, FOCUS_MODE, 'focus'),
    title: str(input.title, 160) || (input.mode === 'break' ? '休息' : '专注'),
    taskId: input.taskId ? str(input.taskId, 64) : null,
    planId: input.planId ? str(input.planId, 64) : null,
    minutes,
    completeTask: Boolean(input.completeTask),
    startedAt,
    endAt: now + left,
    pausedAt: null,
    pausedRemainingMs: null,
  };
}

function focusRemainingMs(active, now = Date.now()) {
  if (!active) return 0;
  if (active.pausedAt) return Math.max(0, Number(active.pausedRemainingMs) || 0);
  return Math.max(0, Number(active.endAt) - now);
}

module.exports = {
  TASK_STATUS, TASK_PRIORITY, TASK_SOURCE, PLAN_STATUS, PROPOSAL_STATUS, ARCHIVE_TYPE, FOCUS_MODE,
  TASK_STATUS_LABEL, TASK_PRIORITY_LABEL, PLAN_STATUS_LABEL, ARCHIVE_TYPE_LABEL,
  newTask, patchTask, isToday, isOverdue,
  newPlan, patchPlan,
  newConversation, newMessage, newProposal,
  newArchive, patchArchive,
  newFocusSession, newActiveFocus, focusRemainingMs,
  dateOnly, todayStr, str, oneOf,
};
