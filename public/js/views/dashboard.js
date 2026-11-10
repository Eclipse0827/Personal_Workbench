/**
 * 页面一：工作台（概览）
 * ---------------------------------------------------------------
 * PRD 2.2 要求的五个模块，全部保留：
 *   A. 欢迎区域（日期 + 问候，不用连续打卡施压）
 *   B. 今日计划（未完成 / 已完成 / 快速新增 / 查看全部未完成 / 直接改状态 / 多时先展示部分）
 *   C. AI 快速入口（「和 AI 聊会」直达）
 *   D. 最近计划
 *
 * 版式按参考设计组织：一张「今日」大卡（三栏 + 竖分隔线）、
 * 一张大数字进度卡、一张计划卡。工具统一放在左侧栏。
 * 主角是今日任务，AI 入口在旁边 —— 对应 PRD 1.4「工作台优先，AI 辅助」。
 */

import { api } from '../api.js';
import {
  h, toast, toastError, pageHead,
  todayLabel, greeting, fmtDay, fmtRelative, truncate,
} from '../ui.js';
import { state, todayOpen, todayDone, isOverdue, projectById } from '../state.js';
import { openTaskForm, openPlanForm } from './task-form.js';

/** 今日计划最多先展示几条，其余折叠 */
const TODAY_PREVIEW = 6;

/** 中文的「10月20日 星期二」 */
function monthDayWeek() {
  const d = new Date();
  const w = ['日', '一', '二', '三', '四', '五', '六'];
  return `${d.getMonth() + 1}月${d.getDate()}日 星期${w[d.getDay()]}`;
}

export default async function renderDashboard(root, ctx) {
  const stats = state.stats || {};
  const open = todayOpen();
  const done = todayDone();
  const overdue = state.tasks.filter(isOverdue);
  const plans = state.plans.filter((p) => p.status === 'active');

  // ---------------------------------------------------------------- 操作

  function quickAdd() {
    openTaskForm({
      plans,
      projects: state.projects,
      defaults: { scheduledDate: state.today },
      onSaved: () => ctx.rerender(),
    });
  }

  async function setStatus(task, status) {
    try {
      await api.patchTask(task.id, { status });
      await ctx.rerender();
      if (status === 'done') toast('做完了。');
    } catch (err) { toastError(err); }
  }

  const editTask = (task) => openTaskForm({ task, plans, projects: state.projects, onSaved: () => ctx.rerender() });

  // ---------------------------------------------------------------- 主动提醒（最多一句）

  /** 只在真有事时说一句；可以当天关掉，不弹窗、不红点、不催 */
  function nudgeBar() {
    const n = state.nudge;
    if (!n || !n.text) return null;
    const key = `nudge-dismissed:${state.today}:${n.kind}`;
    try { if (localStorage.getItem(key) === '1') return null; } catch { /* 隐私模式下没有 localStorage */ }
    return h('div.nudge-bar', {}, [
      h('div.nudge-text', {}, [
        h('span.nudge-main', {}, n.text),
        n.hint ? h('span.nudge-hint', {}, n.hint) : null,
      ]),
      h('div.nudge-actions', {}, [
        h('button.nudge-go', { type: 'button', onclick: () => ctx.navigate(n.to || '/tasks') }, n.action || '去看看'),
        h('button.nudge-x', {
          type: 'button',
          title: '今天不再显示',
          onclick: (e) => {
            try { localStorage.setItem(key, '1'); } catch { /* 存不上就算了 */ }
            const bar = e.target.closest('.nudge-bar');
            if (bar) bar.remove();
          },
        }, '×'),
      ]),
    ]);
  }

  // ---------------------------------------------------------------- 今日大卡

  function todayItem(task, { strikethrough = false } = {}) {
    return h(`div.today-item${strikethrough ? '.done' : ''}`, {
      onclick: () => editTask(task),
      title: '点一下可以修改这件事',
    }, [
      h('span.bullet'),
      h('span.txt', {}, task.title),
      task.projectId && projectById(task.projectId)
        ? h('span.when.task-project-tag', { title: '所属学习项目' }, projectById(task.projectId).title)
        : null,
      task.dueDate && task.dueDate === state.today
        ? h('span.when', {}, '今天截止')
        : task.scheduledDate === state.today
          ? h('span.when', {}, '今天')
          : null,
    ]);
  }

  function todayCard() {
    const recentConvs = (state.conversations || []).slice(0, 3);
    const preview = open.slice(0, TODAY_PREVIEW);
    const rest = open.length - preview.length;

    return h('div.card.today-card', {}, [
      h('div.today-head', {}, [
        h('div.today-title', {}, `今日 · ${monthDayWeek()}`),
        h('div.today-sub', {}, [
          h('span', {}, ['待办 ', h('b', {}, String(open.length)), ' 项']),
          h('span', {}, ['已完成 ', h('b', {}, String(done.length)), ' 项']),
          h('span', {}, ['计划 ', h('b', {}, String(plans.length)), ' 个']),
          h('span', {}, ['对话 ', h('b', {}, String((state.conversations || []).length)), ' 个']),
        ]),
      ]),

      h('div.today-grid', {}, [
        // 第一栏：今日待办
        h('div.today-col', {}, [
          h(`div.today-col-title${open.length ? '' : '.empty'}`, {}, [
            '今日待办',
            h('span.n', {}, String(open.length)),
          ]),
          open.length
            ? h('div.today-list', {}, preview.map((t) => todayItem(t)))
            : h('div.today-empty', {}, '今天还没有安排。空着也完全可以。'),
          rest > 0
            ? h('div.mt1', {}, [
                h('button.btn.small.ghost', {
                  onclick: () => ctx.navigate('/tasks?filter=open'),
                }, `还有 ${rest} 件，看全部 →`),
              ])
            : null,
          h('div.btn-row.mt2', {}, [
            h('button.btn.small.ghost', { onclick: quickAdd }, '＋ 新增任务'),
            h('button.btn.small.ghost', { onclick: () => ctx.navigate('/tasks?filter=open') }, '全部未完成 →'),
          ]),
        ]),

        // 第二栏：今天已完成
        h('div.today-col', {}, [
          h(`div.today-col-title${done.length ? '' : '.empty'}`, {}, [
            '今日已完成',
            h('span.n', {}, String(done.length)),
          ]),
          done.length
            ? h('div.today-list', {}, done.slice(0, TODAY_PREVIEW).map((t) => todayItem(t, { strikethrough: true })))
            : h('div.today-empty', {}, '还没有完成的。做完了会自动出现在这里。'),
        ]),

        // 第三栏：最近对话
        h('div.today-col', {}, [
          h(`div.today-col-title${recentConvs.length ? '' : '.empty'}`, {}, [
            '最近对话',
            h('span.n', {}, String((state.conversations || []).length)),
          ]),
          recentConvs.length
            ? h('div.today-list', {}, recentConvs.map((c) =>
                h('div.today-item', {
                  onclick: () => ctx.navigate(`/chat/${c.id}`),
                  title: '打开这段对话',
                }, [
                  h('span.bullet'),
                  h('span.txt', {}, truncate(c.title, 26)),
                  c.pendingProposals
                    ? h('span.when', { style: { color: 'var(--warm)' } }, `${c.pendingProposals} 待确认`)
                    : h('span.when', {}, fmtRelative(c.updatedAt)),
                ])
              ))
            : h('div.today-empty', {}, '还没有对话。遇到卡住的事可以从下面开始。'),
          recentConvs.length
            ? h('div.mt2', {}, [
                h('button.btn.small.ghost', { onclick: () => ctx.navigate('/chat') }, '全部对话 →'),
              ])
            : null,
        ]),
      ]),

      overdue.length
        ? h('div.notice.warm.mt3.mb0', {}, [
            h('strong', {}, `${overdue.length} 件已经过了截止日期。`),
            ' 它们还在未完成列表里，不会消失。可以改个日期，或者干脆删掉——删掉也是一种处理。',
          ])
        : null,
    ]);
  }

  // ---------------------------------------------------------------- 进度大卡

  function progressCard() {
    const total = stats.total || 0;
    const doneCount = stats.done || 0;
    const pct = total ? Math.round((doneCount / total) * 1000) / 10 : 0;
    const remaining = Math.max(0, total - doneCount);

    return h('div.card.bigstat-card', {}, [
      h('div.bigstat-label', {}, '全部任务 · 完成度'),
      h('div.bigstat-value', {}, [
        total ? (pct % 1 === 0 ? String(pct) : pct.toFixed(1)) : '0',
        h('span.unit', {}, '%'),
      ]),
      h('div.bigstat-bar', {}, [
        h('div.progress', {}, [h('i', { style: { width: `${pct}%` } })]),
      ]),
      h('div.bigstat-meta', {}, [
        h('span', {}, `共 ${total} 个任务`),
        h('span', {}, `已完成 ${doneCount} 个`),
      ]),
      total
        ? h('div.bigstat-foot', {}, remaining ? `还剩 ${remaining} 个未完成` : '全部完成了')
        : h('div.bigstat-foot', { style: { color: 'var(--ink-4)' } }, '还没有任务'),
    ]);
  }

  // ---------------------------------------------------------------- 计划卡

  function planCard() {
    const active = plans.slice(0, 4);
    return h('div.card', {}, [
      h('div.plan-card-head', {}, [h('span.dot'), '学习计划']),
      active.length
        ? h('div', {}, active.map((p) => {
            const total = (p.stats && p.stats.total) || 0;
            const d = (p.stats && p.stats.done) || 0;
            return h('div.plan-line', { onclick: () => ctx.navigate(`/plan/${p.id}`) }, [
              h('div.plan-line-main', {}, [
                h('div.plan-line-title', {}, truncate(p.title, 22)),
                h('div.plan-line-meta', {}, p.endDate ? `到 ${fmtDay(p.endDate)}` : (total ? `${total} 个任务` : '还没有任务')),
              ]),
              h('div.plan-line-num', {}, [String(d), h('small', {}, `/${total}`)]),
            ]);
          }))
        : h('div.today-empty', {}, '还没有进行中的计划。计划是可选的，不建也能正常用工作台。'),
      h('div.btn-row.mt2', {}, [
        h('button.btn.small', { onclick: () => openPlanForm({ onSaved: () => ctx.rerender() }) }, '＋ 新建计划'),
        active.length
          ? h('button.btn.small.ghost', { onclick: () => ctx.navigate('/tasks?tab=plans') }, '全部计划 →')
          : null,
      ]),
    ]);
  }

  // ---------------------------------------------------------------- 组装

  root.appendChild(
    h('div.page', {}, [
      pageHead({
        title: '概览',
        sub: `${todayLabel()} · ${greeting()}`,
        actions: [
          h('button.ai-portal', {
            type: 'button',
            title: '打开 AI 整理空间，把卡住的事说出来',
            onclick: () => ctx.navigate('/chat'),
          }, [
            h('span.dot'),
            '和 AI 聊会',
            h('span.arrow', {}, '→'),
          ]),
          h('button.btn.primary', { onclick: quickAdd }, '＋ 新增任务'),
        ],
      }),

      nudgeBar(),

      h('div.section', {}, [todayCard()]),

      h('div.grid.two', {}, [
        progressCard(),
        planCard(),
      ]),

      h('div.center.mt3', {}, [
        h('div.tiny.muted', {}, [
          `共 ${stats.total || 0} 个任务 · ${stats.done || 0} 个已完成`,
        ]),
      ]),
    ])
  );
}
