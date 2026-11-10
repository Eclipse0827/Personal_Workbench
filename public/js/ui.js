/**
 * 通用 UI 工具：dom 构造、提示、弹窗、格式化、常用控件。
 * 刻意不用任何框架 —— 改起来直观，也没有构建步骤。
 */

/**
 * 极简 DOM 构造器。
 *   h('div.card', {}, [h('h2', {}, '标题')])
 * 第一个参数支持 tag.class1.class2#id 写法。
 */
export function h(spec, attrs = {}, children = []) {
  let tag = 'div';
  const classes = [];
  let id = null;
  const m = String(spec).match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/);
  if (m) {
    if (m[1]) tag = m[1];
    for (const token of (m[2] || '').match(/[.#][\w-]+/g) || []) {
      if (token[0] === '.') classes.push(token.slice(1));
      else id = token.slice(1);
    }
  } else {
    tag = String(spec);
  }

  const el = document.createElement(tag);
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');

  if (Array.isArray(attrs) || typeof attrs === 'string' || (attrs && attrs.nodeType)) {
    children = attrs;
    attrs = {};
  }

  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class' || k === 'className') {
      el.className = [el.className, v].filter(Boolean).join(' ');
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(el.style, v);
    } else if (k === 'dataset' && typeof v === 'object') {
      Object.assign(el.dataset, v);
    } else if (k === 'html') {
      el.innerHTML = v;
    } else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'value' && (tag === 'textarea' || tag === 'input' || tag === 'select')) {
      el.value = v;
    } else if (k === 'checked' || k === 'disabled' || k === 'selected') {
      el[k] = Boolean(v);
    } else {
      el.setAttribute(k, v === true ? '' : v);
    }
  }

  append(el, children);
  return el;
}

export function append(parent, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else if (c.nodeType) parent.appendChild(c);
    else parent.appendChild(document.createTextNode(String(c)));
  }
  return parent;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

// ---------------------------------------------------------------- 提示

let toastTimer = null;
export function toast(message, kind = '') {
  let el = document.getElementById('toast');
  if (!el) {
    el = h('div#toast.toast');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.className = `toast ${kind}`;
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), kind === 'warn' ? 4600 : 2600);
}

export function toastError(err) {
  toast(err && err.message ? err.message : '出了点问题', 'warn');
}

// ---------------------------------------------------------------- 弹窗

export function modal({ title, body, actions = [], onClose, wide = false }) {
  const mask = h('div.modal-mask');
  const box = h(`div.modal${wide ? '.wide' : ''}`, {}, [
    h('h2', {}, title),
    h('div.mt2', {}, body),
    h('div.btn-row.mt3', { style: { justifyContent: 'flex-end' } },
      actions.map((a) =>
        h(`button.btn${a.primary ? '.primary' : ''}${a.danger ? '.danger' : ''}`, {
          onclick: async () => {
            if (a.onClick) {
              const keep = await a.onClick();
              if (keep === false) return;
            }
            close();
          },
        }, a.label)
      )
    ),
  ]);
  mask.appendChild(box);

  function close() {
    mask.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(mask);

  const focusable = box.querySelector('input, textarea, select, button.primary');
  if (focusable) setTimeout(() => focusable.focus(), 30);
  return { close, box };
}

export function confirmDialog(title, message, confirmLabel = '确定') {
  return new Promise((resolve) => {
    let decided = false;
    modal({
      title,
      body: h('p.mb0', {}, message),
      actions: [
        { label: '取消', onClick: () => { decided = true; resolve(false); } },
        { label: confirmLabel, danger: true, onClick: () => { decided = true; resolve(true); } },
      ],
      onClose: () => { if (!decided) resolve(false); },
    });
  });
}

// ---------------------------------------------------------------- 标签与文案

export const TASK_STATUS_LABEL = { todo: '待开始', doing: '进行中', done: '已完成' };
export const TASK_PRIORITY_LABEL = { normal: '普通', important: '重要' };
export const PLAN_STATUS_LABEL = { active: '进行中', done: '已完成', archived: '已归档' };
export const ARCHIVE_TYPE_LABEL = { thought: '思考档案', summary: '重要摘要', plan: '学习计划' };
export const ARCHIVE_ORIGIN_LABEL = { manual: '我手动保存', ai: '来自 AI 对话', legacy: '从第一版迁移' };
export const PROPOSAL_STATUS_LABEL = { pending: '待确认', confirmed: '已确认', dismissed: '已放弃' };
export const COURSE_PLATFORM_LABEL = { bilibili: 'B 站', mooc: '慕课', other: '其他' };
/** AI 引擎的显示名。三种实现的诚实标注，绝不把规则引擎说成「AI 模型」 */
export const PROVIDER_LABEL = {
  mock: '本地规则引擎',
  ollama: 'Ollama 本地模型',
  real: '远程模型',
};

// ---------------------------------------------------------------- 页面头部与按钮

/**
 * 统一的页面头部：大标题 + 说明行 + 右侧操作区。
 * 对应参考设计里「概览 / 2026年10月20日 星期二」+ 右上角操作簇。
 */
export function pageHead({ title, sub, kicker, actions = [], compact = false }) {
  return h('div.page-head', {}, [
    h('div.page-head-main', {}, [
      kicker ? h('div.kicker', {}, kicker) : null,
      h(compact ? 'h1.title-sm' : 'h1', {}, title),
      sub ? h('div.page-sub', {}, sub) : null,
    ]),
    actions.length ? h('div.page-actions', {}, actions) : null,
  ]);
}

/** 圆形图标按钮。只在真的有点击行为时才用 —— 不放纯装饰的假按钮。 */
export function iconButton(glyph, { title, onclick, active = false } = {}) {
  return h(`button.icon-round${active ? '.active' : ''}`, {
    type: 'button', title, 'aria-label': title, onclick,
  }, glyph);
}

/** 浅底小胶囊，用来放「引擎状态」这类只读信息 */
export function chip(text, { tone = '', title: tip } = {}) {
  return h(`span.chip${tone ? `.${tone}` : ''}`, { title: tip }, text);
}

// ---------------------------------------------------------------- 日期

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** YYYY-MM-DD → 今天 / 明天 / 昨天 / 10月17日 周五 */
export function fmtDay(dateStr, base = today()) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  const diff = Math.round((d - new Date(`${base}T00:00:00`)) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  const md = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (Math.abs(diff) < 7) return `${md} 周${WEEKDAYS[d.getDay()]}`;
  return md;
}

/** 相对几天的说明：还有 3 天 / 已过 2 天 */
export function dayDistance(dateStr, base = today()) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((d - new Date(`${base}T00:00:00`)) / 86400000);
}

export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function fmtRelative(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days <= 0) {
    const hours = Math.floor(diff / 3600000);
    if (hours <= 0) return '刚刚';
    return `${hours} 小时前`;
  }
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/** 今天是几月几日 周几 */
export function todayLabel() {
  const d = new Date();
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WEEKDAYS[d.getDay()]}`;
}

/** 按时间给问候，语气平实，不制造压力 */
export function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return '还没睡吗';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export function truncate(s, n = 120) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// ---------------------------------------------------------------- 常用控件

/** 任务状态的小圆点按钮：点一下在 待开始 → 进行中 → 已完成 之间循环 */
export function statusDot(task, onChange) {
  const order = ['todo', 'doing', 'done'];
  const next = order[(order.indexOf(task.status) + 1) % order.length];
  return h(`button.status-dot.${task.status}`, {
    type: 'button',
    title: `当前：${TASK_STATUS_LABEL[task.status]}，点击改为「${TASK_STATUS_LABEL[next]}」`,
    onclick: (e) => { e.stopPropagation(); onChange(next); },
  }, task.status === 'done' ? '✓' : task.status === 'doing' ? '◐' : '');
}

/** 任务条目的通用渲染 */
export function taskRow(task, opts = {}) {
  const { planName, projectName, onStatus, onOpen, onEdit, onDelete, showDate = true } = opts;
  const overdue = task.dueDate && task.dueDate < today() && task.status !== 'done';
  const important = task.priority === 'important';

  return h(`div.task-row${task.status === 'done' ? '.done' : ''}${overdue ? '.overdue' : ''}${important ? '.important' : ''}`, {}, [
    statusDot(task, onStatus || (() => {})),
    h('div.task-body', { onclick: onOpen || null, style: onOpen ? { cursor: 'pointer' } : {} }, [
      h('div.task-title', {}, task.title),
      task.description ? h('div.task-desc', {}, truncate(task.description, 80)) : null,
      h('div.task-meta', {}, [
        h(`span.tag${important ? '.warm' : ''}`, {}, important ? '重要' : '普通'),
        showDate && task.scheduledDate ? h('span.task-when', {}, `安排于 ${fmtDay(task.scheduledDate)}`) : null,
        task.dueDate
          ? h(`span.task-when${overdue ? '.overdue' : ''}`, { style: overdue ? { color: 'var(--alert)' } : {} }, `截止 ${fmtDay(task.dueDate)}`)
          : null,
        planName ? h('span.tag.calm', {}, planName) : null,
        projectName ? h('span.tag.calm.task-project-tag', { title: '所属学习项目' }, projectName) : null,
        task.source === 'ai' ? h('span.tag.plain', { title: '来自 AI 建议，你确认后才创建' }, 'AI 建议') : null,
        task.sourceLabel
          ? h('span.tag.plain.reading-source-tag', { title: `来自 ${task.sourceLabel}` }, task.sourceLabel)
          : null,
      ]),
    ]),
    h('div.task-actions', {}, [
      onEdit ? h('button.task-clock', {
        type: 'button',
        title: '查看 / 修改这条待办',
        onclick: (e) => { e.stopPropagation(); onEdit(); },
      }, '◷') : null,
      onDelete ? h('button.icon-btn.danger', { title: '删除', onclick: (e) => { e.stopPropagation(); onDelete(); } }, '×') : null,
    ]),
  ]);
}

/** 空状态：一定要带一个明确的下一步入口 */
export function emptyState({ icon = '○', title, hint, actionLabel, onAction }) {
  return h('div.empty', {}, [
    h('div.big', {}, icon),
    h('div', {}, title),
    hint ? h('div.tiny.mt1', {}, hint) : null,
    actionLabel ? h('div.mt2', {}, [h('button.btn.primary.small', { onclick: onAction }, actionLabel)]) : null,
  ]);
}

/** 加载中的骨架 */
export function skeleton(lines = 3) {
  return h('div', {}, Array.from({ length: lines }, () =>
    h('div.card', {}, [h('div.skeleton', { style: { height: '18px', width: `${50 + Math.random() * 40}%` } })])));
}
