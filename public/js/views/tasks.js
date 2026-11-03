/**
 * 页面二：待办与计划
 * ---------------------------------------------------------------
 * PRD 2.3：这是完整的任务管理中心，**不依赖 AI 也能用**。
 *
 * 覆盖：手动创建 / 编辑 / 删除（带确认）/ 标记完成 / 恢复未完成 /
 * 按日期和状态查看 / 全部未完成 / 创建编辑归档计划 / 任务关联计划 /
 * 查看某计划下全部任务 / 区分手动创建与 AI 建议生成。
 *
 * 一个容易做错的细节（PRD 3.3 / 8.2）：**没有日期的未完成任务不能消失**。
 * 所以「未完成」和「按日期」两个视图都会单独保留一个「未安排日期」分组。
 */

import { api } from '../api.js';
import {
  h, toast, toastError, confirmDialog, taskRow, emptyState, pageHead,
  fmtDay, fmtShort, truncate, today, TASK_STATUS_LABEL, PLAN_STATUS_LABEL,
} from '../ui.js';
import { state, allOpen, todayOpen, planById } from '../state.js';
import { openTaskForm, openPlanForm } from './task-form.js';
import { launchFloatWindow } from '../float-launch.js';

const TABS = [
  { id: 'open', label: '未完成' },
  { id: 'today', label: '今天' },
  { id: 'done', label: '已完成' },
  { id: 'date', label: '按日期' },
  { id: 'plans', label: '计划' },
];

export default async function renderTasks(root, ctx) {
  const tab = TABS.some((t) => t.id === ctx.args.tab) ? ctx.args.tab : 'open';
  const activePlans = state.plans.filter((p) => p.status === 'active');

  // ---------------------------------------------------------------- 操作

  async function setStatus(task, status) {
    try {
      await api.patchTask(task.id, { status });
      await ctx.rerender();
      if (status === 'done') toast('做完了。');
    } catch (err) { toastError(err); }
  }

  async function remove(task) {
    const ok = await confirmDialog(
      '删掉这个任务？',
      `「${task.title}」会被删除，无法恢复。`,
      '删掉'
    );
    if (!ok) return;
    try {
      await api.deleteTask(task.id);
      toast('已删除。');
      await ctx.rerender();
    } catch (err) { toastError(err); }
  }

  const rowFor = (task) => taskRow(task, {
    planName: task.planId ? (planById(task.planId) || {}).title : null,
    onStatus: (s) => setStatus(task, s),
    onEdit: () => openTaskForm({
      task, plans: activePlans, onSaved: () => ctx.rerender(),
    }),
    onDelete: () => remove(task),
  });

  function newTask(defaults = {}) {
    openTaskForm({
      plans: activePlans,
      defaults,
      onSaved: () => ctx.rerender(),
    });
  }

  // ---------------------------------------------------------------- 各视图

  function openView() {
    const open = allOpen();
    if (!open.length) {
      return emptyState({
        icon: '○',
        title: '没有未完成的任务',
        hint: '全都做完了，或者还没开始加。两种都挺好。',
        actionLabel: '新增一个任务',
        onAction: () => newTask(),
      });
    }
    const undated = open.filter((t) => !t.scheduledDate && !t.dueDate);
    const dated = open.filter((t) => t.scheduledDate || t.dueDate)
      .sort((a, b) => String(a.scheduledDate || a.dueDate).localeCompare(String(b.scheduledDate || b.dueDate)));

    return h('div', {}, [
      dated.length
        ? h('div.card', {}, [h('div.task-list', {}, dated.map(rowFor))])
        : null,
      undated.length
        ? h('div.card.mt2', {}, [
            h('div.tiny.muted.mb1', {}, `未安排日期（${undated.length}）—— 不设日期也不会从列表里消失`),
            h('div.task-list', {}, undated.map(rowFor)),
          ])
        : null,
    ]);
  }

  function todayView() {
    const open = todayOpen();
    const doneToday = state.tasks.filter((t) => t.status === 'done' && (t.scheduledDate === state.today || t.dueDate === state.today));
    if (!open.length && !doneToday.length) {
      return emptyState({
        icon: '○',
        title: '今天没有安排',
        hint: '把任务设一个「哪天做」，它就会出现在这里。',
        actionLabel: '加一件今天做的事',
        onAction: () => newTask({ scheduledDate: state.today }),
      });
    }
    return h('div', {}, [
      open.length
        ? h('div.card', {}, [h('div.task-list', {}, open.map(rowFor))])
        : h('div.notice.quiet', {}, '今天的都做完了。'),
      doneToday.length
        ? h('div.card.mt2', {}, [
            h('div.tiny.muted.mb1', {}, `今天已完成（${doneToday.length}）`),
            h('div.task-list.muted-list', {}, doneToday.map(rowFor)),
          ])
        : null,
    ]);
  }

  function doneView() {
    const done = state.tasks.filter((t) => t.status === 'done')
      .sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
    if (!done.length) {
      return emptyState({ icon: '○', title: '还没有已完成的任务', hint: '完成一个任务后，它会出现在这里。' });
    }
    return h('div.card', {}, [
      h('div.tiny.muted.mb1', {}, `共 ${done.length} 个。点左边的圆点可以把它恢复成未完成。`),
      h('div.task-list.muted-list', {}, done.map(rowFor)),
    ]);
  }

  function dateView() {
    const groups = new Map();
    for (const t of state.tasks) {
      const key = t.scheduledDate || t.dueDate || '未安排日期';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === '未安排日期') return 1;
      if (b === '未安排日期') return -1;
      return a.localeCompare(b);
    });

    if (!state.tasks.length) {
      return emptyState({
        icon: '○', title: '还没有任务', hint: '新增一个任务，或让 AI 帮你拆几条。',
        actionLabel: '新增任务', onAction: () => newTask(),
      });
    }

    return h('div', {}, keys.map((key) => {
      const list = groups.get(key);
      const openCount = list.filter((t) => t.status !== 'done').length;
      const label = key === '未安排日期' ? key : `${fmtDay(key)} · ${key}`;
      return h('div.card.mb2', {}, [
        h('div.flex.between.items-center.gap1.wrap.mb1', {}, [
          h('h3', {}, label),
          h('span.tiny.muted', {}, openCount ? `${openCount} 件未完成 / 共 ${list.length} 件` : `全部完成（${list.length} 件）`),
        ]),
        h(`div.task-list${openCount ? '' : '.muted-list'}`, {}, list.map(rowFor)),
      ]);
    }));
  }

  function plansView() {
    const active = state.plans.filter((p) => p.status === 'active');
    const finished = state.plans.filter((p) => p.status !== 'active');

    const card = (p) => {
      const total = p.stats ? p.stats.total : 0;
      const done = p.stats ? p.stats.done : 0;
      const pct = total ? Math.round((done / total) * 100) : 0;
      return h('div.card.clickable', { onclick: () => ctx.navigate(`/plan/${p.id}`) }, [
        h('div.flex.between.items-center.gap1.wrap', {}, [
          h('div', {}, [
            h('div.plan-row-title', {}, p.title),
            h('div.tiny.muted', {}, [
              PLAN_STATUS_LABEL[p.status],
              total ? ` · ${done}/${total} 个任务` : ' · 还没有任务',
              p.startDate || p.endDate ? ` · ${p.startDate || '—'} → ${p.endDate || '—'}` : '',
            ].join('')),
          ]),
          h('span.tag', {}, PLAN_STATUS_LABEL[p.status]),
        ]),
        p.description ? h('div.task-desc.mt1', {}, truncate(p.description, 100)) : null,
        total
          ? h('div.progress.mt2', {}, [h('i', { style: { width: `${pct}%` } })])
          : null,
        h('div.btn-row.mt2', {}, [
          h('button.btn.small.ghost', {
            onclick: (e) => {
              e.stopPropagation();
              newTask({ planId: p.id });
            },
          }, '＋ 给它加任务'),
          h('button.btn.small.ghost', {
            onclick: (e) => {
              e.stopPropagation();
              openPlanForm({ plan: p, onSaved: () => ctx.rerender() });
            },
          }, '编辑'),
          h('button.btn.small.ghost.danger', {
            onclick: async (e) => {
              e.stopPropagation();
              const ok = await confirmDialog(
                '删掉这个计划？',
                `计划「${p.title}」会被删除。它下面的任务不会被删掉，只会解除关联。`,
                '删掉计划'
              );
              if (!ok) return;
              try {
                const r = await api.deletePlan(p.id);
                toast(r.detachedTasks ? `计划已删除，${r.detachedTasks} 个任务已解除关联。` : '计划已删除。');
                await ctx.rerender();
              } catch (err) { toastError(err); }
            },
          }, '删除'),
        ]),
      ]);
    };

    return h('div', {}, [
      h('div.section-head.inline', {}, [
        h('h2', {}, '进行中的计划'),
        h('button.btn.small.primary', {
          style: { marginLeft: 'auto' },
          onclick: () => openPlanForm({ onSaved: () => ctx.rerender() }),
        }, '＋ 新建计划'),
      ]),
      active.length
        ? h('div', {}, active.map(card))
        : emptyState({
            icon: '◌',
            title: '还没有进行中的计划',
            hint: '计划只用来把一段时间内的任务放在一起，不建也完全可以正常使用工作台。',
            actionLabel: '建一个计划',
            onAction: () => openPlanForm({ onSaved: () => ctx.rerender() }),
          }),
      finished.length
        ? h('div.section.mt3', {}, [
            h('div.section-head', {}, [h('h2', {}, '已完成 / 已归档'), h('span.count', {}, `${finished.length} 个`)]),
            h('div', {}, finished.map(card)),
          ])
        : null,
    ]);
  }

  // ---------------------------------------------------------------- 组装

  const counts = {
    open: allOpen().length,
    today: todayOpen().length,
    done: state.tasks.filter((t) => t.status === 'done').length,
    plans: state.plans.filter((p) => p.status === 'active').length,
  };

  const body = {
    open: openView,
    today: todayView,
    done: doneView,
    date: dateView,
    plans: plansView,
  }[tab]();

  root.appendChild(
    h('div.page', {}, [
      pageHead({
        title: '所有要做的事',
        sub: '这一页不需要 AI 也能完整使用。任务、计划、日期、状态都在你自己手上。',
        actions: [
          h('button.btn.ghost', {
            type: 'button',
            title: '在桌面上开一个半透明小窗，随手勾待办、开计时',
            onclick: () => launchFloatWindow(),
          }, '浮到桌面'),
          h('button.btn', { onclick: () => openPlanForm({ onSaved: () => ctx.rerender() }) }, '＋ 新建计划'),
          h('button.btn.primary', { onclick: () => newTask() }, '＋ 新增任务'),
        ],
      }),

      h('div.tabs', {}, TABS.map((t) =>
        h(`button.tab${t.id === tab ? '.active' : ''}`, {
          onclick: () => ctx.navigate(`/tasks?tab=${t.id}`),
        }, [t.label, counts[t.id] ? h('span.tab-count', {}, String(counts[t.id])) : null])
      )),

      body,

      h('div.notice.quiet.mt3', {}, [
        h('strong', {}, '关于完成状态：'),
        ' 点任务左边的圆点可以在「待开始 → 进行中 → 已完成」之间切换，点过头了再点一圈就能回到未完成。',
        ' 已完成的任务不会消失，可以在「已完成」里找回来。',
      ]),
    ])
  );
}
