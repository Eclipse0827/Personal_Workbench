/**
 * 桌面浮窗页面。
 *
 * 和网页版共用同一份服务端数据：这里看到的计时就是网页里的那一轮，
 * 勾选待办、暂停、结束、放弃都会立刻写回本地服务。
 * 没有 Electron 时也能直接用浏览器打开这个地址（只是少了置顶和关闭窗口）。
 */

const root = document.getElementById('float-root');
const toastEl = document.getElementById('float-toast');
const desktop = window.desktopFloat || null;

const state = {
  status: 'loading', // loading | ready | error
  error: '',
  offline: false,
  active: null,
  tasks: [],
  todayMinutes: 0,
  busy: false,
  confirmCancel: false,
  pinned: true,
  metaAt: 0,
  draft: '',
};

let pollTimer = null;
let tickTimer = null;
let confirmTimer = null;
let toastTimer = null;
let polling = false;
let expiring = false;
let initialLoading = false;
let loopsStarted = false;
let lastHeight = 0;
let addingTask = false;

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// ---------------------------------------------------------------- 基础

function el(spec, attrs = {}, ...children) {
  let tag = 'div';
  const classes = [];
  let id = null;
  const match = String(spec).match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+)*)$/);
  if (match) {
    if (match[1]) tag = match[1];
    for (const token of (match[2] || '').match(/[.#][\w-]+/g) || []) {
      if (token[0] === '.') classes.push(token.slice(1));
      else id = token.slice(1);
    }
  } else {
    tag = String(spec);
  }

  const node = document.createElement(tag);
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');

  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = [node.className, v].filter(Boolean).join(' ');
    else if (k === 'text') node.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else {
      node.setAttribute(k, v === true ? '' : v);
    }
  }
  append(node, children);
  return node;
}

function append(parent, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return parent;
}

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('连不上本地服务，请确认那个命令行窗口还开着。');
  }
  const type = res.headers.get('content-type') || '';
  if (!type.includes('application/json')) {
    if (!res.ok) throw new Error(`服务器返回 ${res.status}`);
    return {};
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

function toast(message, kind = '') {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.className = `float-toast${kind ? ` ${kind}` : ''}`;
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), kind === 'warn' ? 4200 : 3000);
}

function remainingOf(active) {
  if (!active) return 0;
  if (active.pausedAt) return Math.max(0, Number(active.pausedRemainingMs) || 0);
  return Math.max(0, Number(active.endAt) - Date.now());
}

function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function endClock(active) {
  const d = new Date(Number(active.endAt));
  if (Number.isNaN(d.getTime())) return '稍后';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function todayLabel() {
  const d = new Date();
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${WEEKDAYS[d.getDay()]}`;
}

function fmtDue(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  const base = new Date(`${todayStr()}T00:00:00`);
  const diff = Math.round((d - base) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return '还没睡吗';
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function activeSig(active) {
  if (!active) return '';
  return [active.token, active.pausedAt || '', active.endAt, active.title || '', active.taskId || ''].join('|');
}

function tasksSig() {
  return `${state.todayMinutes}#${state.tasks.map((t) => `${t.id}:${t.status}:${t.title}`).join('|')}`;
}

function sameToken(result, token) {
  return Boolean(result && result.session && result.session.clientToken === token);
}

// ---------------------------------------------------------------- 渲染

function render() {
  if (!root) return;
  const scroller = root.querySelector('.float-scroll');
  const scrollTop = scroller ? scroller.scrollTop : 0;

  root.replaceChildren();
  root.appendChild(renderCard());

  const nextScroller = root.querySelector('.float-scroll');
  if (nextScroller) nextScroller.scrollTop = scrollTop;

  applyWindowHeight();
}

function renderCard() {
  const card = el('div', { class: 'float-card' }, [renderHead()]);

  if (state.status === 'ready' && state.offline) {
    card.appendChild(el('div.float-banner', { style: { margin: '0 16px 8px' } }, '连不上本地服务，正在重试…'));
  }

  if (state.status === 'loading') {
    card.appendChild(el('div.float-loading', {}, [
      el('div.float-dots', {}, [el('i'), el('i'), el('i')]),
      '正在连上本地服务…',
    ]));
  } else if (state.status === 'error') {
    card.appendChild(el('div.float-error', {}, [
      el('strong', {}, '连不上本地服务'),
      el('div', {}, state.error || '请确认那个命令行窗口还开着。'),
      el('button.fb-btn', { type: 'button', onclick: retry }, '重试'),
    ]));
  } else {
    card.appendChild(state.active ? renderTimer() : renderIdle());
    card.appendChild(renderFoot());
  }

  return card;
}

function renderHead() {
  const tools = [];
  if (desktop) {
    tools.push(el('button.float-tool', {
      type: 'button',
      class: `float-tool${state.pinned ? ' active' : ''}`,
      title: state.pinned ? '取消置顶' : '保持在其他窗口之上',
      'aria-label': state.pinned ? '取消置顶' : '置顶',
      onclick: togglePin,
    }, '顶'));
    tools.push(el('button.float-tool', {
      type: 'button',
      title: '在浏览器里打开专注页',
      'aria-label': '打开网页版',
      onclick: () => desktop.openApp(),
    }, '↗'));
    tools.push(el('button.float-tool.close', {
      type: 'button',
      title: '关闭浮窗',
      'aria-label': '关闭浮窗',
      onclick: () => desktop.close(),
    }, '×'));
  }

  return el('header.float-head', {}, [
    el('div.float-brand', {}, [
      el('div.float-mark', {}, '缓'),
      el('div.float-brand-text', {}, [
        el('div.float-name', {}, '缓一缓'),
        el('div.float-state', {}, headState()),
      ]),
    ]),
    tools.length ? el('div.float-tools', {}, tools) : null,
  ]);
}

function headState() {
  if (state.status === 'loading') return '正在连接';
  if (state.status === 'error' || state.offline) return '连接断开 · 重试中';
  if (state.active) {
    if (state.active.pausedAt) return '已暂停';
    return state.active.mode === 'break' ? '休息中' : '正在专注';
  }
  return state.tasks.length ? `待办 ${state.tasks.length} 件` : '暂时没有待办';
}

function renderIdle() {
  return el('div.float-scroll', {}, [
    el('div.float-greeting', {}, [
      el('h1', {}, `${greeting()}，慢慢来`),
      el('div.float-date', {}, todayLabel()),
    ]),
    el('div.float-section-head', {}, [
      el('span.label', {}, '待办'),
      el('span.count', {}, state.tasks.length ? `${state.tasks.length} 件` : '清空了'),
    ]),
    renderAddTask(),
    state.tasks.length
      ? el('div.float-tasks', {}, state.tasks.map(renderTask))
      : el('div.float-empty', {}, [
          el('strong', {}, '暂时没有待办'),
          '想到什么，就直接开始一段专注吧。',
        ]),
    el('div.float-quick', {}, [
      el('div.label', {}, '不关联待办，直接开始'),
      el('div.float-chips', {}, [15, 25, 45].map((m) => el('button.float-chip', {
        type: 'button',
        disabled: state.busy,
        onclick: () => startFocus({ minutes: m }),
      }, `${m} 分钟`))),
    ]),
  ]);
}

function renderAddTask() {
  return el('form.float-add', {
    onsubmit: (e) => {
      e.preventDefault();
      submitNewTask();
    },
  }, [
    el('input.float-add-input', {
      id: 'float-new-task',
      type: 'text',
      maxlength: '80',
      placeholder: '加一件待办，回车确认',
      'aria-label': '新待办标题',
      autocomplete: 'off',
      value: state.draft,
      oninput: (e) => { state.draft = e.target.value; },
      onkeydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        submitNewTask();
      },
    }),
    el('button.float-add-btn', {
      type: 'submit',
      'aria-label': '添加待办',
    }, '添加'),
  ]);
}

function renderTask(task) {
  const overdue = task.dueDate && task.dueDate < todayStr();
  let meta = '';
  if (task.dueDate) meta = overdue ? `已过截止（${fmtDue(task.dueDate)}）` : `截止 ${fmtDue(task.dueDate)}`;
  else if (task.scheduledDate) meta = `安排 ${fmtDue(task.scheduledDate)}`;
  if (task.priority === 'important') meta = meta ? `${meta} · 重要` : '重要';

  return el('div.float-task', {}, [
    el('button.float-check', {
      type: 'button',
      title: '勾选完成',
      'aria-label': `完成 ${task.title}`,
      disabled: state.busy,
      onclick: () => completeTask(task),
    }, '✓'),
    el('div.float-task-main', {}, [
      el('div.float-task-title', { title: task.title }, task.title),
      meta ? el('div.float-task-meta', {}, overdue ? [el('span.warn', {}, meta)] : meta) : null,
    ]),
    el('button.float-start', {
      type: 'button',
      title: `以「${task.title}」开始 25 分钟专注`,
      disabled: state.busy,
      onclick: () => startFocus({ task, minutes: 25 }),
    }, '开始'),
  ]);
}

function renderTimer() {
  const active = state.active;
  const paused = Boolean(active.pausedAt);
  const left = remainingOf(active);
  const total = Math.max(1, Number(active.minutes || 25) * 60000);
  const pct = Math.min(100, Math.max(0, 100 * (1 - left / total)));
  const modeLabel = active.mode === 'break' ? '休息' : '专注';

  return el('div.float-timer', {}, [
    el('div', { class: `float-mode${paused ? ' paused' : ''}` }, [
      el('span.dot'),
      paused ? `${modeLabel} · 已暂停` : `${modeLabel}中`,
    ]),
    el('div.float-timer-title', { title: active.title || '' }, active.title || modeLabel),
    el('div', { class: `float-clock${paused ? ' paused' : ''}`, id: 'float-clock' }, formatClock(left)),
    el('div', { class: `float-progress${paused ? ' paused' : ''}` }, [
      el('i', { id: 'float-progress', style: { width: `${pct}%` } }),
    ]),
    el('div.float-timer-sub', {}, paused
      ? '计时已暂停，今天的专注时长先记到这里。'
      : `预计 ${endClock(active)} 结束`),
    el('div.float-actions', {}, [
      el('button.fb-btn.primary', {
        type: 'button', disabled: state.busy, onclick: togglePause,
      }, paused ? '继续' : '暂停'),
      el('button.fb-btn', {
        type: 'button',
        disabled: state.busy,
        title: '提前结束，记下已经专注的时间',
        'aria-label': '结束并记下这一轮',
        onclick: finishEarly,
      }, '结束'),
      el('button', {
        type: 'button',
        class: `fb-btn danger${state.confirmCancel ? ' confirming' : ''}`,
        disabled: state.busy,
        onclick: cancelFocus,
      }, state.confirmCancel ? '确认放弃？' : '放弃'),
    ]),
    el('div.float-hint', {}, '结束会记入学习时间；放弃不记录。'),
  ]);
}

function renderFoot() {
  return el('footer.float-foot', {}, [
    el('span', {}, state.todayMinutes > 0
      ? ['今天已专注 ', el('strong', {}, `${state.todayMinutes} 分钟`)]
      : '今天还没有专注记录'),
    el('span', {}, '与网页版同步'),
  ]);
}

function syncClock() {
  const active = state.active;
  if (!active) return;
  const left = remainingOf(active);
  const total = Math.max(1, Number(active.minutes || 25) * 60000);
  const pct = Math.min(100, Math.max(0, 100 * (1 - left / total)));

  const clock = document.getElementById('float-clock');
  if (clock) clock.textContent = formatClock(left);
  const bar = document.getElementById('float-progress');
  if (bar) bar.style.width = `${pct}%`;

  if (left <= 0 && !active.pausedAt && !expiring && !polling && !state.busy) {
    expiring = true;
    poll().finally(() => { expiring = false; });
  }
}

function applyWindowHeight() {
  if (!desktop || typeof desktop.resize !== 'function') return;
  const height = state.status === 'ready' ? (state.active ? 360 : 500) : 320;
  if (height === lastHeight) return;
  lastHeight = height;
  try { desktop.resize(height); } catch { /* 浏览器预览时没有这个方法 */ }
}

// ---------------------------------------------------------------- 数据

async function refreshMeta(force) {
  if (!force && Date.now() - state.metaAt < 8000) return false;
  const before = tasksSig();
  const [tasksData, focusData] = await Promise.all([
    request('GET', '/api/tasks?filter=open'),
    request('GET', '/api/focus'),
  ]);
  state.tasks = Array.isArray(tasksData.tasks) ? tasksData.tasks : [];
  state.todayMinutes = Number(focusData.stats && focusData.stats.todayMinutes) || 0;
  state.metaAt = Date.now();
  return before !== tasksSig();
}

function absorbActive(data, { initial = false } = {}) {
  const prevToken = state.active ? state.active.token : null;
  const next = data.active || null;
  let finished = null;

  if (next) {
    state.active = next;
    return { finished: null };
  }

  state.active = null;
  const result = data.lastResult && data.lastResult.session ? data.lastResult : null;
  const natural = data.justFinished && data.justFinished.session ? data.justFinished : null;

  if (prevToken) {
    if (result && sameToken(result, prevToken)) finished = result;
    else if (natural && sameToken(natural, prevToken)) finished = natural;
    else if (data.cancelledToken === prevToken) toast('这一轮放弃了，没有计入统计');
    else toast('这一轮已经在别处结束了');
  } else if (initial && natural) {
    finished = natural;
  }

  if (finished) showResult(finished);
  return { finished };
}

function showResult(result) {
  const session = result.session || {};
  const minutes = Math.max(1, Math.round((Number(session.actualSeconds) || 0) / 60));
  if (session.mode === 'break') toast('休息结束了，回去继续吧。', 4200);
  else toast(`这一轮结束了，记下 ${minutes} 分钟。`, 4200);
}

async function poll() {
  if (polling || initialLoading || state.busy) return;
  polling = true;
  try {
    const data = await request('GET', '/api/focus/active');
    const wasOffline = state.offline;
    const wasReady = state.status === 'ready';
    const prevSig = activeSig(state.active);

    state.offline = false;
    const absorbed = absorbActive(data);

    let metaChanged = false;
    if (absorbed.finished || !state.active) {
      metaChanged = await refreshMeta(absorbed.finished || !wasReady);
    }

    state.status = 'ready';
    const changed = !wasReady || wasOffline || prevSig !== activeSig(state.active) || metaChanged;
    if (changed) render();
    else syncClock();
  } catch {
    if (!state.offline) {
      state.offline = true;
      render();
    }
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------- 操作

async function startFocus({ task = null, minutes = 25 } = {}) {
  if (state.busy) return;
  if (state.active) {
    toast('已经有一轮在进行中了');
    return;
  }

  state.busy = true;
  state.confirmCancel = false;
  render();
  try {
    const data = await request('POST', '/api/focus/active', {
      mode: 'focus',
      minutes,
      title: task ? task.title : `专注 ${minutes} 分钟`,
      taskId: task ? task.id : null,
      completeTask: Boolean(task),
    });
    state.active = data.active || null;
    state.offline = false;
    await refreshMeta(true);
    toast(task ? `开始专注：${task.title}` : `开始专注 ${minutes} 分钟`);
  } catch (err) {
    if (err.status === 409) {
      toast('已经有一轮在进行中了，直接在浮窗里继续就好。');
      try {
        const data = await request('GET', '/api/focus/active');
        state.active = data.active || null;
      } catch { /* 下面统一刷新 */ }
    } else {
      toast(err.message, 'warn');
    }
  } finally {
    state.busy = false;
    render();
  }
}

async function togglePause() {
  const active = state.active;
  if (!active || state.busy) return;
  const wasPaused = Boolean(active.pausedAt);

  state.busy = true;
  state.confirmCancel = false;
  render();
  try {
    const data = await request('PATCH', '/api/focus/active', { action: wasPaused ? 'resume' : 'pause' });
    if (data.active) {
      state.active = data.active;
    } else {
      state.active = null;
      if (data.justFinished && data.justFinished.session) showResult(data.justFinished);
      await refreshMeta(true);
    }
  } catch (err) {
    if (err.status === 404) {
      toast('这一轮已经结束了');
      state.active = null;
      try { await refreshMeta(true); } catch { /* 恢复不了就等下一次轮询 */ }
    } else {
      toast(err.message, 'warn');
    }
  } finally {
    state.busy = false;
    render();
  }
}

async function finishEarly() {
  const active = state.active;
  if (!active || state.busy) return;

  state.busy = true;
  state.confirmCancel = false;
  render();
  try {
    const data = await request('POST', '/api/focus/active/finish', {
      natural: false,
      clientToken: active.token,
    });
    state.active = null;
    if (data.session) showResult(data);
    await refreshMeta(true);
  } catch (err) {
    if (err.status === 404) {
      toast('这一轮已经结束了');
      state.active = null;
      try { await refreshMeta(true); } catch { /* 等轮询 */ }
    } else {
      toast(err.message, 'warn');
    }
  } finally {
    state.busy = false;
    render();
  }
}

async function cancelFocus() {
  if (!state.active || state.busy) return;

  if (!state.confirmCancel) {
    state.confirmCancel = true;
    render();
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      state.confirmCancel = false;
      if (state.active) render();
    }, 4000);
    return;
  }

  clearTimeout(confirmTimer);
  state.busy = true;
  state.confirmCancel = false;
  render();
  try {
    await request('POST', '/api/focus/active/cancel', {});
    state.active = null;
    await refreshMeta(true);
    toast('这一轮放弃了，没有记入统计');
  } catch (err) {
    toast(err.message, 'warn');
  } finally {
    state.busy = false;
    render();
  }
}

async function submitNewTask() {
  if (addingTask || state.busy) return;
  const input = document.getElementById('float-new-task');
  const title = String(input ? input.value : state.draft).trim();
  if (!title) {
    input?.focus();
    return;
  }

  const btn = document.querySelector('.float-add-btn');
  addingTask = true;
  if (input) input.disabled = true;
  if (btn) btn.disabled = true;
  try {
    const data = await request('POST', '/api/tasks', { title });
    const task = data.task;
    if (task) {
      state.tasks = [task, ...state.tasks.filter((t) => t.id !== task.id)];
      state.metaAt = Date.now();
    }
    state.draft = '';
    toast('待办加好了');
    render();
    document.getElementById('float-new-task')?.focus();
  } catch (err) {
    toast(err.message, 'warn');
    if (input) input.disabled = false;
    if (btn) btn.disabled = false;
    input?.focus();
  } finally {
    addingTask = false;
  }
}

async function completeTask(task) {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    await request('PATCH', `/api/tasks/${encodeURIComponent(task.id)}`, { status: 'done' });
    state.tasks = state.tasks.filter((t) => t.id !== task.id);
    toast(`已完成：${task.title}`);
  } catch (err) {
    toast(err.message, 'warn');
  } finally {
    state.busy = false;
    render();
  }
}

async function togglePin() {
  if (!desktop) return;
  try {
    const data = await desktop.togglePin();
    if (data && typeof data.pinned === 'boolean') state.pinned = data.pinned;
  } catch {
    toast('置顶切换失败', 'warn');
  }
  render();
}

// ---------------------------------------------------------------- 启动

function startLoops() {
  if (loopsStarted) return;
  loopsStarted = true;
  pollTimer = setInterval(poll, 2500);
  tickTimer = setInterval(() => {
    if (state.active) syncClock();
  }, 500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('focus', poll);
  window.addEventListener('beforeunload', () => {
    clearInterval(pollTimer);
    clearInterval(tickTimer);
  });
}

async function loadInitial() {
  initialLoading = true;
  try {
    const [data] = await Promise.all([
      request('GET', '/api/focus/active'),
      refreshMeta(true),
    ]);
    const absorbed = absorbActive(data, { initial: true });
    state.status = 'ready';
    state.offline = false;
    if (absorbed.finished) await refreshMeta(true);
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
    state.offline = true;
  } finally {
    initialLoading = false;
    render();
  }
}

async function retry() {
  state.status = 'loading';
  state.error = '';
  render();
  await loadInitial();
}

function bindDesktop() {
  if (!desktop || typeof desktop.info !== 'function') return;
  desktop.info().then((data) => {
    if (data && typeof data.pinned === 'boolean') {
      state.pinned = data.pinned;
      render();
    }
  }).catch(() => { /* 拿不到就用默认值 */ });
}

bindDesktop();
render();
loadInitial().finally(startLoops);
