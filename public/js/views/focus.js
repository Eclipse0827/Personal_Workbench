/**
 * 专注（番茄钟）
 * ---------------------------------------------------------------
 * 选择一件具体的事，开始一轮专注；结束时可以自动把关联待办勾成已完成。
 * 计时状态在 focus-store.js，本页只负责呈现和开始/暂停/结束。
 */

import { api } from '../api.js';
import {
  h, toast, toastError, confirmDialog, pageHead, chip,
} from '../ui.js';
import { state, planById } from '../state.js';
import { focusStore, formatClock } from '../focus-store.js';
import { launchFloatWindow } from '../float-launch.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MINUTES_KEY = 'huan-focus-minutes-v1';
const RING_R = 96;
const RING_C = 2 * Math.PI * RING_R;

function svg(tag, attrs = {}, children = []) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    el.setAttribute(k, v);
  }
  for (const c of children) el.appendChild(c);
  return el;
}

function savedMinutes() {
  const n = Number(localStorage.getItem(MINUTES_KEY));
  return Number.isFinite(n) && n >= 1 && n <= 180 ? Math.round(n) : 25;
}

function timeLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function durationLabel(session) {
  const seconds = Number(session && session.actualSeconds);
  if (Number.isFinite(seconds) && seconds > 0) {
    if (seconds < 60) return '不到 1 分钟';
    return `${Math.round(seconds / 60)} 分钟`;
  }
  return `${Number(session && session.minutes) || 0} 分钟`;
}

function endedEarly(session) {
  const seconds = Number(session && session.actualSeconds);
  const planned = Number(session && session.minutes) * 60;
  return Number.isFinite(seconds) && seconds > 0 && planned > 0 && seconds < planned - 5;
}

function contentKey(title) {
  return String(title || '').replace(/\s+/g, ' ').trim() || '未命名专注';
}

function spanText(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return '0 分钟';
  if (total < 60) return '不到 1 分钟';
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function dayDateLabel(key) {
  const d = new Date(`${key}T00:00:00`);
  if (Number.isNaN(d.getTime())) return key;
  return `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]}`;
}

function relativeDayLabel(key, todayKey, yesterdayKey) {
  if (key === todayKey) return '今天';
  if (key === yesterdayKey) return '昨天';
  return dayDateLabel(key);
}

const CONTENT_COLORS = [
  '#5c4033', '#b97844', '#8b9d77', '#a85448',
  '#6b7d5c', '#75a191', '#b39a49', '#9a7d62',
];

/** 归类之后整页会重绘，用它把选中项接回来 */
let pendingContentSelection = null;

export default async function renderFocus(root, ctx) {
  let history = { sessions: [], stats: null };
  let historyError = null;
  try {
    history = await api.listFocus();
  } catch (err) {
    historyError = err;
  }

  const sessions = history.sessions || [];
  const stats = history.stats || {
    todayKey: '', yesterdayKey: '', todayMinutes: 0, todaySessions: 0,
    yesterdayMinutes: 0, yesterdaySessions: 0, weekMinutes: 0, weekSessions: 0,
    totalSessions: 0, totalMinutes: 0, byDay: [], byContent: [],
  };

  const active = focusStore.current;
  const result = focusStore.lastResult;

  const page = h('div.page.focus-page');
  root.appendChild(page);

  const headActions = [
    chip(`今天 ${stats.todaySessions} 次 · ${stats.todayMinutes} 分钟`, {
      tone: stats.todaySessions ? 'accent' : '',
      title: '只统计已经完成、并且没有撤销的专注',
    }),
  ];
  if (stats.yesterdaySessions) {
    headActions.push(chip(`昨天 ${stats.yesterdayMinutes} 分钟`, {
      title: '昨天完成的专注；下方可以按内容和按天查看',
    }));
  }
  headActions.push(h('button.btn.ghost.small', {
    type: 'button',
    title: '在桌面上开一个半透明小窗，待办和计时都在里面',
    onclick: () => launchFloatWindow(),
  }, '浮到桌面'));

  page.appendChild(pageHead({
    title: '专注',
    sub: '选一件具体的事，给自己一段不被打断的时间。结束时会记下来，也可以顺手把待办勾掉。',
    actions: headActions,
  }));

  // ---------------------------------------------------------------- 进行中

  let runningView = null;
  if (active) {
    runningView = renderRunning(active, ctx, () => ctx.rerender());
    page.appendChild(runningView.el);
  } else {
    if (result) page.appendChild(renderResult(result, ctx, stats));
    page.appendChild(renderSetup(ctx));
  }

  // ---------------------------------------------------------------- 统计与历史

  page.appendChild(renderStats(stats, sessions, ctx, historyError, history.contentAliases));

  // 进行中时只更新表盘和按钮，不整页重绘
  if (active && runningView && root.isConnected) {
    let unsubscribe = null;
    const stop = () => { if (unsubscribe) unsubscribe(); unsubscribe = null; };
    unsubscribe = focusStore.subscribe((snap) => {
      if (!root.isConnected) { stop(); return; }
      if (!snap.current) {
        // 结束或取消后交给外壳刷新页面（外壳监听 focus:done）
        if (snap.type === 'cancel') ctx.rerender();
        stop();
        return;
      }
      runningView.update(snap);
    });
  }

  // ---------------------------------------------------------------- 组件

  function renderSetup() {
    const openTasks = state.tasks.filter((t) => t.status !== 'done');
    const plans = state.plans.filter((p) => p.status === 'active');
    let mode = openTasks.length ? 'task' : 'free';
    let selectedMinutes = savedMinutes();

    const taskSelect = h('select.focus-task-select', {}, [
      h('option', { value: '' }, openTasks.length ? '选一件要完成的事…' : '现在没有未完成的待办'),
      ...openTasks.map((t) => {
        const plan = t.planId ? planById(t.planId) : null;
        return h('option', { value: t.id }, `${t.title}${plan ? ` · ${plan.title}` : ''}`);
      }),
    ]);

    const freeTitle = h('input', {
      type: 'text',
      maxlength: '120',
      placeholder: '例如：背 50 个单词 / 读完这一章',
    });

    const planSelect = h('select', {}, [
      h('option', { value: '' }, '不归到某个计划'),
      ...plans.map((p) => h('option', { value: p.id }, p.title)),
    ]);

    const autoCheck = h('input', { type: 'checkbox', checked: true });
    const autoCheckRow = h('label.focus-check', {}, [
      autoCheck,
      h('span', {}, [
        h('strong', {}, '结束这一轮时，自动勾选这条待办'),
        h('span.focus-check-hint', {}, '提前结束也会勾选。之后可以在结果里撤销。'),
      ]),
    ]);

    const taskFields = h('div.focus-fields', {}, [
      h('label.field.mb2', {}, [
        h('span.label-text', {}, '要做的待办'),
        taskSelect,
      ]),
      autoCheckRow,
      h('div.focus-linked-hint', {}, ''),
    ]);
    const freeFields = h('div.focus-fields.hidden', {}, [
      h('label.field.mb2', {}, [
        h('span.label-text', {}, '这次专注做什么'),
        freeTitle,
      ]),
      plans.length
        ? h('label.field.mb0', {}, [
            h('span.label-text', {}, '归到哪个计划（可选）'),
            planSelect,
          ])
        : null,
    ]);

    const linkedHint = taskFields.querySelector('.focus-linked-hint');
    function paintLinkedHint() {
      const task = state.tasks.find((t) => t.id === taskSelect.value);
      if (!task) {
        linkedHint.replaceChildren(h('span.tiny.muted', {}, '选一条待办，结束时才知道该勾哪一条。'));
        autoCheckRow.classList.remove('hidden');
        return;
      }
      const plan = task.planId ? planById(task.planId) : null;
      const tags = [h('span.tag.accent', {}, plan ? plan.title : '没有关联计划')];
      if (task.scheduledDate) tags.push(h('span.tag', {}, `安排：${task.scheduledDate}`));
      if (task.dueDate) tags.push(h('span.tag', {}, `截止：${task.dueDate}`));
      linkedHint.replaceChildren(...tags);
      autoCheckRow.classList.toggle('hidden', task.status === 'done');
    }
    taskSelect.addEventListener('change', paintLinkedHint);
    paintLinkedHint();

    const modeSwitch = openTasks.length
      ? h('div.focus-mode-switch', {}, [
          h('button.focus-mode.active', { type: 'button', onclick: () => setMode('task') }, '关联待办'),
          h('button.focus-mode', { type: 'button', onclick: () => setMode('free') }, '自由专注'),
        ])
      : null;

    function setMode(next) {
      mode = next;
      if (modeSwitch) {
        [...modeSwitch.children].forEach((b, i) => b.classList.toggle('active', i === (next === 'task' ? 0 : 1)));
      }
      taskFields.classList.toggle('hidden', next !== 'task');
      freeFields.classList.toggle('hidden', next !== 'free');
    }
    setMode(mode);

    const durationRow = h('div.focus-durations');
    const customMinutes = h('input.focus-custom-min', {
      type: 'number', min: '1', max: '180', step: '1', value: String(selectedMinutes),
      'aria-label': '自定义分钟数',
    });

    function paintDurations() {
      durationRow.replaceChildren(
        ...[25, 45, 60].map((m) =>
          h(`button.focus-duration${selectedMinutes === m ? '.active' : ''}`, {
            type: 'button', onclick: () => { selectedMinutes = m; customMinutes.value = String(m); paintDurations(); },
          }, [h('strong', {}, String(m)), h('span', {}, '分钟')])
        ),
        h('label.focus-custom', {}, [customMinutes, h('span', {}, '分钟')])
      );
    }
    customMinutes.addEventListener('input', () => {
      const n = Math.round(Number(customMinutes.value));
      if (Number.isFinite(n) && n >= 1 && n <= 180) {
        selectedMinutes = n;
        [...durationRow.querySelectorAll('.focus-duration')].forEach((b) =>
          b.classList.toggle('active', Number(b.querySelector('strong').textContent) === n));
      }
    });
    paintDurations();

    const startBtn = h('button.btn.primary.focus-start', {
      type: 'button',
      onclick: () => {
        const minutes = Math.max(1, Math.min(180, Math.round(Number(selectedMinutes) || 25)));
        let title = '';
        let taskId = null;
        let planId = null;
        let taskTitle = null;
        let planTitle = null;
        let completeTask = false;

        if (mode === 'task') {
          const task = state.tasks.find((t) => t.id === taskSelect.value);
          if (!task) { toast('先选一条要做的待办。', 'warn'); taskSelect.focus(); return; }
          if (task.status === 'done') { toast('这条待办已经完成了，换一条吧。', 'warn'); return; }
          title = task.title;
          taskId = task.id;
          planId = task.planId || null;
          taskTitle = task.title;
          const plan = planId ? planById(planId) : null;
          planTitle = plan ? plan.title : null;
          completeTask = autoCheck.checked;
        } else {
          title = freeTitle.value.trim();
          if (!title) { toast('写一句这次要做什么，哪怕只有几个字。', 'warn'); freeTitle.focus(); return; }
          planId = planSelect.value || null;
          const plan = planId ? planById(planId) : null;
          planTitle = plan ? plan.title : null;
        }

        try {
          localStorage.setItem(MINUTES_KEY, String(minutes));
        } catch { /* 记不住偏好也没关系 */ }
        try {
          focusStore.start({
            mode: 'focus', title, taskId, taskTitle, planId, planTitle, completeTask, minutes,
          });
          ctx.rerender({ refreshData: false });
        } catch (err) {
          toastError(err);
        }
      },
    }, '开始专注');

    return h('div.focus-setup-wrap', {}, [
      h('div.card.focus-setup', {}, [
        h('div.focus-setup-head', {}, [
          h('div', {}, [
            h('div.focus-kicker', {}, '这一次，只做一件事'),
            h('h2', {}, '开始一轮专注'),
          ]),
          h('div.focus-setup-note', {}, '计时在浏览器里走，刷新页面也不会丢。'),
        ]),
        modeSwitch,
        taskFields,
        freeFields,
        h('div.focus-duration-block', {}, [
          h('div.focus-section-label', {}, '多久'),
          durationRow,
        ]),
        h('div.focus-start-row', {}, [
          startBtn,
          h('span.tiny.muted', {}, '计时结束会记录一次专注；关联待办可以自动完成。'),
        ]),
      ]),
    ]);
  }

  function renderRunning(session, ctx2, onChange) {
    const wrap = h('div.focus-running-wrap');
    const totalMs = session.minutes * 60 * 1000;
    const isBreak = session.mode === 'break';
    const ring = svg('circle', {
      cx: '120', cy: '120', r: String(RING_R),
      fill: 'none', stroke: 'currentColor', 'stroke-width': '7',
      'stroke-linecap': 'round', transform: 'rotate(-90 120 120)',
    });
    ring.style.strokeDasharray = String(RING_C);
    const clock = h('div.focus-clock', {}, '00:00');
    const stateLabel = h('div.focus-state-label', {}, session.pausedAt ? '已暂停' : (isBreak ? '休息中' : '专注中'));
    const targetLine = h('div.focus-target', {}, session.title);
    const metaLine = h('div.focus-target-meta', {});

    const circleWrap = h('div.focus-ring', {}, [
      svg('svg', { viewBox: '0 0 240 240', role: 'img', 'aria-label': '专注倒计时' }, [
        svg('circle', {
          cx: '120', cy: '120', r: String(RING_R), fill: 'none',
          stroke: 'currentColor', 'stroke-width': '7', opacity: '.14',
        }),
        ring,
      ]),
      h('div.focus-ring-inner', {}, [clock, stateLabel]),
    ]);

    const pauseBtn = h('button.btn', {
      type: 'button',
      onclick: () => {
        if (focusStore.current && focusStore.current.pausedAt) focusStore.resume();
        else focusStore.pause();
      },
    }, session.pausedAt ? '继续' : '暂停');

    const finishBtn = h('button.btn.primary', {
      type: 'button',
      onclick: async () => {
        const cur = focusStore.current;
        if (!cur) return;
        const left = focusStore.remainingMs();
        if (left > 60 * 1000) {
          const ok = await confirmDialog(
            '现在结束这一轮？',
            `还剩 ${formatClock(left)}。提前结束会按已经专注的时间记录${cur.completeTask ? '，并勾选关联待办' : ''}。`,
            '结束并记录'
          );
          if (!ok) return;
        }
        try { await focusStore.finishEarly(); } catch (err) { toastError(err); }
      },
    }, session.completeTask ? '结束并勾选待办' : '结束这一轮');

    const cancelBtn = h('button.btn.ghost', {
      type: 'button',
      onclick: async () => {
        const ok = await confirmDialog('放弃这一轮？', '这一轮不会留下记录，也不会勾选待办。', '放弃');
        if (!ok) return;
        focusStore.cancel();
      },
    }, '放弃');

    const open = h('button.btn.ghost', {
      type: 'button',
      onclick: () => ctx2.navigate('/focus'),
    }, '打开专注页');

    wrap.appendChild(h(`div.card.focus-stage${isBreak ? '.break' : ''}`, {}, [
      h('div.focus-stage-head', {}, [
        h('div.focus-kicker', {}, isBreak ? '休息一下' : '正在专注'),
        h('div.focus-stage-live', {}, [
          h('span.focus-live-dot'),
          session.pausedAt ? '已暂停' : '进行中',
        ]),
      ]),
      circleWrap,
      targetLine,
      metaLine,
      h('div.focus-stage-actions', {}, [pauseBtn, finishBtn, cancelBtn, open]),
      h('div.focus-stage-note', {}, isBreak
        ? '离开屏幕，喝口水。这一轮不会动任何待办。'
        : '计时结束前，不用回来看。到点会提示你，并自动记录。'),
    ]));

    function updateRunning(snap) {
      const cur = snap.current;
      if (!cur) return;
      const remain = snap.remainingMs;
      const elapsed = Math.max(0, totalMs - remain);
      const ratio = totalMs ? Math.max(0, Math.min(1, elapsed / totalMs)) : 0;
      clock.textContent = formatClock(remain);
      ring.style.strokeDashoffset = String(RING_C * (1 - ratio));
      stateLabel.textContent = snap.paused ? '已暂停' : (cur.mode === 'break' ? '休息中' : '专注中');
      pauseBtn.textContent = snap.paused ? '继续' : '暂停';
      const dot = wrap.querySelector('.focus-live-dot');
      if (dot) dot.classList.toggle('paused', snap.paused);
      paintMeta(cur);
    }

    function paintMeta(cur) {
      const bits = [];
      if (cur.taskTitle) bits.push(h('span.tag.accent', {}, cur.taskTitle));
      if (cur.planTitle && cur.planTitle !== cur.taskTitle) bits.push(h('span.tag', {}, cur.planTitle));
      bits.push(h('span.tag.plain', {}, `${cur.minutes} 分钟`));
      if (cur.completeTask) bits.push(h('span.tag.calm', {}, '结束自动勾选待办'));
      metaLine.replaceChildren(...bits);
    }
    paintMeta(session);
    updateRunning({
      current: session,
      remainingMs: focusStore.remainingMs(),
      paused: Boolean(session.pausedAt),
    });
    return { el: wrap, update: updateRunning };
  }

  function renderResult(res, ctx2, currentStats) {
    if (!res) return null;
    const session = res.session;
    const isBreak = session && session.mode === 'break';
    const failed = res.ok === false;
    const autoTask = res.task;
    const canUndo = Boolean(session && session.autoCompleted && !session.undoneAt && autoTask && autoTask.status === 'done');

    const actions = [];
    if (canUndo) {
      actions.push(h('button.btn.small', {
        type: 'button',
        onclick: async () => {
          try {
            await focusStore.undoSession(session.id);
            toast('已撤销勾选，待办回到原来的状态。');
            await ctx2.rerender();
          } catch (err) { toastError(err); }
        },
      }, '撤销自动勾选'));
    }
    if (!isBreak && !failed) {
      actions.push(
        h('button.btn.small.primary', {
          type: 'button',
          onclick: () => startBreak(5, ctx2),
        }, '休息 5 分钟'),
        h('button.btn.small', {
          type: 'button',
          onclick: () => startBreak(10, ctx2),
        }, '休息 10 分钟')
      );
    }
    actions.push(h('button.btn.small.ghost', {
      type: 'button',
      onclick: () => { focusStore.dismissResult(); ctx2.rerender({ refreshData: false }); },
    }, failed ? '知道了' : '收起'));

    return h(`div.card.focus-result${failed ? '.failed' : ''}${isBreak ? '.is-break' : ''}`, {}, [
      h('div.focus-result-mark', {}, failed ? '!' : isBreak ? '◌' : '✓'),
      h('div.focus-result-body', {}, [
        h('div.focus-result-title', {}, failed
          ? '这一轮完成了，但记录还没同步'
          : isBreak ? '休息结束' : '这一轮完成了'),
        h('div.focus-result-meta', {}, failed
          ? [res.error || '本地服务暂时连不上。', ' 记录已经存在浏览器里，服务恢复后会自动补上。']
          : [
              session ? `${durationLabel(session)}${endedEarly(session) ? `（计划 ${session.minutes} 分钟）` : ''} · ${timeLabel(session.endedAt)}` : '',
              session && session.title ? ` · ${session.title}` : '',
            ]),
        !failed && session && session.autoCompleted && res.task
          ? h('div.focus-result-task', {}, [
              '已勾选待办：',
              h('strong', {}, res.task.title),
              session.undoneAt ? '（已撤销）' : '',
            ])
          : null,
        !failed && session && !session.autoCompleted && session.taskId
          ? h('div.focus-result-task.muted', {}, '这一轮关联了待办，但没有自动勾选。')
          : null,
        actions.length ? h('div.btn-row.mt2', {}, actions) : null,
      ]),
    ]);
  }

  function startBreak(minutes, ctx2) {
    try {
      focusStore.start({ mode: 'break', title: '休息', minutes, completeTask: false });
      ctx2.rerender({ refreshData: false });
    } catch (err) { toastError(err); }
  }

  function renderStats(s, list, ctx2, error, contentAliasList) {
    const days = Array.isArray(s.byDay) ? s.byDay : [];
    const todayKey = s.todayKey || (days.length ? days[days.length - 1].date : '');
    const yesterdayKey = s.yesterdayKey || '';
    const todayDay = days.find((d) => d.date === todayKey) || null;
    const latestActive = [...days].reverse().find((d) => d.sessions > 0) || null;
    let selectedDate = todayDay && todayDay.sessions
      ? todayKey
      : (latestActive ? latestActive.date : todayKey);

    const allContent = Array.isArray(s.byContent) ? s.byContent : [];
    const contentAliases = Array.isArray(contentAliasList) ? contentAliasList : [];
    const aliasMap = new Map();
    for (const entry of contentAliases) {
      if (!entry) continue;
      const from = contentKey(entry.from).toLowerCase();
      const to = contentKey(entry.to);
      if (from && to) aliasMap.set(from, to);
    }
    const resolveContentTitle = (title) => {
      let current = contentKey(title);
      const seen = new Set();
      while (aliasMap.has(current.toLowerCase()) && !seen.has(current.toLowerCase())) {
        seen.add(current.toLowerCase());
        current = aliasMap.get(current.toLowerCase());
      }
      return current;
    };

    let selectedContent = pendingContentSelection ? resolveContentTitle(pendingContentSelection) : null;
    pendingContentSelection = null;

    const colorMap = new Map();
    allContent.forEach((item, i) => {
      colorMap.set(contentKey(item.title), CONTENT_COLORS[i % CONTENT_COLORS.length]);
    });
    let colorCursor = 0;
    const colorFor = (title) => {
      const key = contentKey(title);
      if (!colorMap.has(key)) {
        colorMap.set(key, CONTENT_COLORS[colorCursor % CONTENT_COLORS.length]);
        colorCursor += 1;
      }
      return colorMap.get(key);
    };

    const maxSeconds = Math.max(1, ...days.map((d) => Number(d.seconds) || Number(d.minutes || 0) * 60));
    const barButtons = days.map((d) => {
      const seconds = Number(d.seconds) || Number(d.minutes || 0) * 60;
      const weekday = new Date(`${d.date}T00:00:00`).getDay();
      return h(`button.focus-bar-col${d.date === selectedDate ? '.selected' : ''}`, {
        type: 'button',
        title: `${dayDateLabel(d.date)} · ${spanText(seconds)} · ${d.sessions} 次`,
        onclick: () => {
          selectedDate = d.date;
          paintChart();
        },
      }, [
        h('span.focus-bar-value', {}, d.sessions ? (seconds < 60 ? '<1' : String(Math.round(seconds / 60))) : ''),
        h('span.focus-bar-track', {}, [
          h('span.focus-bar-fill', {
            style: { height: `${d.sessions ? Math.max(6, Math.round((seconds / maxSeconds) * 100)) : 0}%` },
          }),
        ]),
        h('span.focus-bar-label', {}, `周${'日一二三四五六'[weekday]}`),
      ]);
    });

    const chartRange = h('div.focus-chart-range');
    const chartNote = h('div.focus-chart-note');
    const pieWrap = h('div.focus-pie-wrap');
    const legend = h('div.focus-pie-legend');
    const contentList = h('div.focus-content-list');
    const contentPick = h('div.focus-content-pick');
    const historyLabel = h('h2', {}, '最近专注');
    const historyCount = h('span.count');
    const historyHost = h('div.focus-history-list');

    function paintBars() {
      barButtons.forEach((btn, i) => {
        btn.classList.toggle('selected', days[i].date === selectedDate);
      });
    }

    /** 当前选中那天的内容分布，饼图和悬停提示共用 */
    function selectedDayModel() {
      const day = days.find((d) => d.date === selectedDate) || null;
      const items = day && Array.isArray(day.content) ? day.content : [];
      const total = Number(day && day.seconds)
        || items.reduce((n, item) => n + (Number(item.seconds) || 0), 0);
      return { day, items, total };
    }

    /** 鼠标停在色块上：放大那一块，并在圆心写出它对应哪项专注 */
    function setPieHover(title) {
      const key = title ? contentKey(title).toLowerCase() : '';
      const chart = pieWrap.querySelector('.focus-pie-svg');
      if (chart) chart.classList.toggle('has-hover', Boolean(key));
      pieWrap.classList.toggle('is-hovering', Boolean(key));
      pieWrap.querySelectorAll('.focus-pie-seg').forEach((seg) => {
        seg.classList.toggle('is-hovered', Boolean(key) && seg.getAttribute('data-key') === key);
      });
      legend.querySelectorAll('.focus-legend-row').forEach((row) => {
        row.classList.toggle('is-hovered', Boolean(key) && row.getAttribute('data-key') === key);
      });

      const dot = pieWrap.querySelector('.focus-pie-hover-dot');
      const name = pieWrap.querySelector('.focus-pie-hover-name');
      const meta = pieWrap.querySelector('.focus-pie-hover-meta');
      if (!dot || !name || !meta) return;
      if (!key) {
        dot.style.background = '';
        name.textContent = '';
        meta.textContent = '';
        return;
      }
      const { items, total } = selectedDayModel();
      const item = items.find((x) => contentKey(x.title).toLowerCase() === key);
      if (!item) return;
      const pct = total ? Math.round((Number(item.seconds) / total) * 100) : 0;
      dot.style.background = colorFor(item.title);
      name.textContent = item.title;
      meta.textContent = `${spanText(item.seconds)} · ${pct}%`;
    }

    function drawPie(items, total) {
      const circumference = 2 * Math.PI * 62;
      const circles = [
        svg('circle', {
          cx: '90', cy: '90', r: '62', fill: 'none',
          class: 'focus-pie-track', 'stroke-width': '24',
        }),
      ];
      let offset = 0;
      if (total > 0) {
        for (const item of items) {
          const seconds = Number(item.seconds) || 0;
          if (seconds <= 0) continue;
          const length = circumference * (seconds / total);
          const gap = items.length > 1 ? Math.min(3, circumference * 0.008) : 0;
          const segment = svg('circle', {
            cx: '90', cy: '90', r: '62', fill: 'none',
            class: 'focus-pie-seg',
            'data-key': contentKey(item.title).toLowerCase(),
            stroke: colorFor(item.title), 'stroke-width': '24',
            'stroke-dasharray': `${Math.max(0.6, length - gap)} ${circumference}`,
            'stroke-dashoffset': String(-offset),
            transform: 'rotate(-90 90 90)',
          });
          segment.addEventListener('mouseenter', () => setPieHover(item.title));
          segment.addEventListener('mouseleave', () => setPieHover(null));
          circles.push(segment);
          offset += length;
        }
      }
      const minutes = total / 60;
      const chart = svg('svg', {
        viewBox: '0 0 180 180',
        class: 'focus-pie-svg',
        role: 'img',
        'aria-label': '按专注内容划分的时间占比',
      }, circles);
      const center = h('div.focus-pie-center', {}, [
        h('div.focus-pie-default', {}, [
          h('div.focus-pie-total', {}, [
            h('strong', {}, total > 0 ? (minutes < 1 ? '<1' : String(Math.round(minutes))) : '0'),
            h('span', {}, '分钟'),
          ]),
          h('div.focus-pie-caption', {}, total > 0 ? '这一天' : '还没有记录'),
        ]),
        h('div.focus-pie-hover', {}, [
          h('span.focus-pie-hover-dot'),
          h('span.focus-pie-hover-name'),
          h('span.focus-pie-hover-meta'),
        ]),
      ]);
      return [chart, center];
    }

    function legendRow(item, total) {
      const active = selectedContent && contentKey(selectedContent).toLowerCase() === contentKey(item.title).toLowerCase();
      const pct = total ? Math.round((Number(item.seconds) / total) * 100) : 0;
      return h(`button.focus-legend-row${active ? '.active' : ''}`, {
        type: 'button',
        title: '点一下，查看这项内容一共花了多久',
        'data-key': contentKey(item.title).toLowerCase(),
        onclick: () => pickContent(item.title),
        onmouseenter: () => setPieHover(item.title),
        onmouseleave: () => setPieHover(null),
      }, [
        h('span.focus-legend-dot', { style: { background: colorFor(item.title) } }),
        h('span.focus-legend-name', {}, item.title),
        h('span.focus-legend-time', {}, spanText(item.seconds)),
        h('span.focus-legend-pct', {}, `${pct}%`),
      ]);
    }

    function contentRow(item) {
      const active = selectedContent && contentKey(selectedContent).toLowerCase() === contentKey(item.title).toLowerCase();
      return h(`button.focus-content-row${active ? '.active' : ''}`, {
        type: 'button',
        onclick: () => pickContent(item.title),
      }, [
        h('span.focus-content-dot', { style: { background: colorFor(item.title) } }),
        h('span.focus-content-main', {}, [
          h('strong', {}, item.title),
          h('span.tiny.muted', {}, `最近 ${timeLabel(item.lastAt)}`),
        ]),
        h('span.focus-content-total', {}, spanText(item.seconds)),
        h('span.focus-content-count', {}, `${item.sessions} 次`),
      ]);
    }

    function pickContent(title) {
      const key = contentKey(title).toLowerCase();
      selectedContent = selectedContent && contentKey(selectedContent).toLowerCase() === key ? null : title;
      paintChart();
    }

    /** 这一类下面已经并进来的写法（来自归类关系，不改原始记录） */
    function mergedFrom(item) {
      const target = contentKey(item.title).toLowerCase();
      return contentAliases.filter((entry) =>
        entry && contentKey(resolveContentTitle(entry.to)).toLowerCase() === target);
    }

    function mergeTargets(item) {
      const currentKey = contentKey(item.title).toLowerCase();
      const used = new Set([currentKey]);
      const tasks = [];
      const contents = [];
      for (const task of (Array.isArray(state.tasks) ? state.tasks : [])) {
        const title = resolveContentTitle(task.title);
        const key = title.toLowerCase();
        if (used.has(key)) continue;
        used.add(key);
        tasks.push({ title, done: task.status === 'done' });
      }
      for (const other of allContent) {
        const title = resolveContentTitle(other.title);
        const key = title.toLowerCase();
        if (used.has(key)) continue;
        used.add(key);
        contents.push({ title });
      }
      return { tasks, contents };
    }

    function mergeControls(item) {
      const { tasks, contents } = mergeTargets(item);
      if (!tasks.length && !contents.length) {
        return h('div.focus-merge', {}, [
          h('div.focus-merge-label', {}, '把这一项归到'),
          h('p.focus-merge-hint.tiny.muted.mb0', {}, '还没有别的待办或内容可以归入。先建一条待办，再来这里合并。'),
        ]);
      }

      const select = h('select.focus-merge-select', {
        'aria-label': '选择要归到的待办或内容',
      }, [
        h('option', { value: '' }, '选一项待办或内容…'),
        tasks.length
          ? h('optgroup', { label: '待办' }, tasks.map((t) =>
              h('option', { value: t.title }, t.done ? `${t.title}（已完成）` : t.title)))
          : null,
        contents.length
          ? h('optgroup', { label: '其他专注内容' }, contents.map((t) =>
              h('option', { value: t.title }, t.title)))
          : null,
      ]);
      const button = h('button.btn.small.focus-merge-btn', { type: 'button' }, '归类');
      button.addEventListener('click', async () => {
        if (!select.value) {
          toast('先选一项要归到的待办。', 'warn');
          select.focus();
          return;
        }
        button.disabled = true;
        try {
          const res = await api.mergeFocusContent({ from: item.title, to: select.value });
          const target = res && res.alias ? res.alias.to : select.value;
          pendingContentSelection = target;
          toast(`已把「${item.title}」归到「${target}」。`);
          await ctx.rerender();
        } catch (err) {
          button.disabled = false;
          toastError(err);
        }
      });

      return h('div.focus-merge', {}, [
        h('div.focus-merge-label', {}, '把这一项归到'),
        h('div.focus-merge-row', {}, [select, button]),
        h('p.focus-merge-hint.tiny.muted.mb0', {}, '归类后，时长会合并成一行；原始专注记录不会被删，随时可以取消。'),
      ]);
    }

    function aliasChips(item) {
      const merged = mergedFrom(item);
      if (!merged.length) return null;
      return h('div.focus-alias-chips', {}, [
        h('span.focus-alias-label', {}, '已并入'),
        ...merged.map((alias) =>
          h('span.focus-alias-chip', {}, [
            h('span', {}, alias.from),
            h('button.focus-alias-remove', {
              type: 'button',
              title: `把「${alias.from}」单独列出`,
              'aria-label': `取消归类 ${alias.from}`,
              onclick: async () => {
                try {
                  await api.unmergeFocusContent({ from: alias.from });
                  pendingContentSelection = alias.from;
                  toast(`「${alias.from}」已单独列出。`);
                  await ctx.rerender();
                } catch (err) { toastError(err); }
              },
            }, '×'),
          ]))
      ]);
    }

    function paintContent() {
      if (!allContent.length) {
        contentList.replaceChildren(h('div.focus-content-empty', {}, '完成第一轮专注后，这里会按内容累计你花的时间。'));
      } else {
        contentList.replaceChildren(...allContent.map(contentRow));
      }

      if (selectedContent) {
        const key = contentKey(selectedContent).toLowerCase();
        const item = allContent.find((x) => contentKey(x.title).toLowerCase() === key);
        if (!item) {
          selectedContent = null;
        } else {
          contentPick.replaceChildren(...[
            h('div.focus-picked-head', {}, [
              h('span.focus-picked-label', {}, '已选中'),
              h('button.focus-picked-clear', {
                type: 'button',
                onclick: () => { selectedContent = null; paintChart(); },
              }, '清除'),
            ]),
            h('div.focus-picked-title', {}, item.title),
            h('div.focus-picked-total', {}, `全部累计 ${spanText(item.seconds)} · ${item.sessions} 次`),
            h('div.tiny.muted', {}, `最近一次 ${timeLabel(item.lastAt)}`),
            aliasChips(item),
            mergeControls(item),
          ].filter(Boolean));
          return;
        }
      }
      contentPick.replaceChildren(
        h('p.small.muted.mb0.focus-picked-hint', {}, '点一项内容，看它一共花了多久；下面的记录也会跟着筛选。')
      );
    }

    function paintHistory() {
      if (error) {
        historyLabel.textContent = '最近专注';
        historyCount.textContent = '';
        historyHost.replaceChildren(h('div.notice.warm.mb0', {}, [
          '没能读到专注记录：', error.message || String(error), '。计时本身仍然可以用。',
        ]));
        return;
      }
      const selectedKey = selectedContent ? contentKey(selectedContent).toLowerCase() : '';
      const filtered = selectedContent
        ? list.filter((session) =>
            session.mode !== 'break'
            && contentKey(resolveContentTitle(session.title)).toLowerCase() === selectedKey)
        : list;
      const shown = filtered.slice(0, 12);
      historyLabel.textContent = selectedContent ? `「${selectedContent}」的记录` : '最近专注';
      historyCount.textContent = filtered.length
        ? (shown.length === filtered.length ? `${filtered.length} 条` : `${shown.length} / ${filtered.length} 条`)
        : '';
      if (!shown.length) {
        historyHost.replaceChildren(h('div.focus-history-empty', {}, selectedContent
          ? `最近记录里没有「${selectedContent}」。累计时长仍然包含更早的记录。`
          : '还没有记录。完成第一轮后，会在这里看到。'));
        return;
      }
      historyHost.replaceChildren(...shown.map((session) => historyRow(session, ctx2, resolveContentTitle)));
    }

    function paintChart() {
      const { items, total } = selectedDayModel();

      chartRange.replaceChildren(
        h('strong', {}, relativeDayLabel(selectedDate, todayKey, yesterdayKey)),
        h('span', {}, dayDateLabel(selectedDate))
      );
      if (selectedDate === todayKey) {
        chartNote.textContent = items.length
          ? '今天的时间去向。点右侧任意内容，可以看它从开始记录到现在的累计。'
          : (s.yesterdaySessions
              ? '今天还没有完成专注。点下面柱状图里的「昨天」，就能看到昨天的时间去向。'
              : '今天还没有完成专注。');
      } else {
        chartNote.textContent = `${todayDay && todayDay.sessions ? '' : '今天还没有完成专注，'}正在显示 ${dayDateLabel(selectedDate)} 的时间去向。`;
      }

      const nodes = drawPie(items, total);
      pieWrap.replaceChildren(...nodes);
      if (!items.length) {
        legend.replaceChildren(h('div.focus-pie-empty', {}, '这一天还没有完成过专注。'));
      } else {
        legend.replaceChildren(...items.map((item) => legendRow(item, total)));
      }
      setPieHover(null);
      paintBars();
      paintContent();
      paintHistory();
    }

    const yesterdayLine = s.yesterdaySessions
      ? h('div.focus-yesterday-line', {}, [
          '昨天 ',
          h('strong', {}, spanText(s.yesterdaySeconds || (s.yesterdayMinutes || 0) * 60)),
          ` · ${s.yesterdaySessions} 次`,
        ])
      : null;

    const statsGrid = h('div.grid.focus-stat-grid', {}, [
      h('div.card.focus-stat-big', {}, [
        h('div.focus-kicker', {}, '今天专注'),
        h('div.focus-big-num', {}, [String(s.todayMinutes || 0), h('span', {}, '分钟')]),
        h('div.focus-big-meta', {}, `${s.todaySessions || 0} 次完成 · 本周 ${s.weekMinutes || 0} 分钟`),
        yesterdayLine,
        h('div.focus-week-bars', {}, barButtons),
        h('p.tiny.muted.focus-bars-hint', {}, '点一根柱子，查看那一天的时间去向。'),
      ]),
      h('div.card.focus-stat-side', {}, [
        h('div.focus-kicker', {}, '一共'),
        h('div.focus-total-num', {}, String(s.totalMinutes || 0)),
        h('div.focus-total-unit', {}, `分钟 · ${s.totalSessions || 0} 次专注`),
        h('p.small.muted.mt2.mb0', {}, '这里只统计「专注」的轮次，休息不计入。没有连续打卡，也没有排名。'),
      ]),
    ]);

    const timeMap = h('div.card.focus-time-map', {}, [
      h('div.focus-map-head', {}, [
        h('div', {}, [
          h('div.focus-kicker', {}, '学习时间去向'),
          h('h2', {}, '每天的时间花在哪儿'),
        ]),
        chartRange,
      ]),
      chartNote,
      h('div.focus-map-grid', {}, [
        h('div.focus-pie-panel', {}, [pieWrap, legend]),
        h('div.focus-content-panel', {}, [
          h('div.focus-content-head', {}, [
            h('div', {}, [
              h('div.focus-kicker', {}, '按内容累计'),
              h('h3', {}, '一件事一共花了多久'),
            ]),
            h('span.tiny.muted', {}, '全部时间'),
          ]),
          contentList,
          contentPick,
        ]),
      ]),
    ]);

    const historyCard = h('div.card.focus-history', {}, [
      h('div.section-head.inline', {}, [historyLabel, historyCount]),
      historyHost,
      h('p.tiny.muted.mb0.mt2', {}, '数据保存在本机的 data/focus-sessions/ 目录。'),
    ]);

    paintChart();

    return h('div.section.focus-below', {}, [statsGrid, timeMap, historyCard]);
  }

  function historyRow(session, ctx2, resolveTitle) {
    const plan = session.planId ? planById(session.planId) : null;
    const isBreak = session.mode === 'break';
    const canUndo = session.autoCompleted && !session.undoneAt && session.taskCompleted && session.taskId;
    const rawTitle = session.title || (isBreak ? '休息' : '专注');
    const shownTitle = isBreak || typeof resolveTitle !== 'function' ? rawTitle : resolveTitle(rawTitle);
    const mergedFrom = contentKey(shownTitle).toLowerCase() !== contentKey(rawTitle).toLowerCase() ? rawTitle : null;
    return h('div.focus-history-row', {}, [
      h('div.focus-history-time', {}, [
        h('div', {}, timeLabel(session.endedAt)),
        h('div.tiny.muted', {}, durationLabel(session)),
      ]),
      h('div.focus-history-main', {}, [
        h('div.focus-history-title', {}, shownTitle),
        h('div.focus-history-meta', {}, [
          isBreak ? h('span.tag.warm', {}, '休息') : h('span.tag.accent', {}, '专注'),
          mergedFrom ? h('span.tag', {}, `原「${mergedFrom}」`) : null,
          plan ? h('span.tag', {}, plan.title) : null,
          endedEarly(session) ? h('span.tag', {}, '提前结束') : null,
          session.autoCompleted
            ? h('span.tag.calm', {}, session.undoneAt ? '已撤销勾选' : '已勾选待办')
            : null,
        ]),
      ]),
      canUndo
        ? h('button.btn.small.ghost', {
            type: 'button',
            onclick: async () => {
              try {
                await focusStore.undoSession(session.id);
                toast('已撤销勾选。');
                await ctx2.rerender();
              } catch (err) { toastError(err); }
            },
          }, '撤销勾选')
        : null,
    ]);
  }
}
