/**
 * 计划详情：某个计划下的全部任务
 * PRD 2.3：「查看某个计划下的全部任务」
 */

import { api } from '../api.js';
import {
  h, toast, toastError, confirmDialog, taskRow, emptyState, pageHead,
  fmtShort, truncate, PLAN_STATUS_LABEL,
} from '../ui.js';
import { state, planById } from '../state.js';
import { openTaskForm, openPlanForm } from './task-form.js';

export default async function renderPlanDetail(root, ctx) {
  const plan = planById(ctx.args.id) || (await api.listPlans()).find((p) => p.id === ctx.args.id);
  if (!plan) {
    root.replaceChildren(h('div.page', {}, [
      emptyState({
        icon: '◌', title: '找不到这个计划', hint: '它可能已经被删掉了。',
        actionLabel: '回到待办与计划', onAction: () => ctx.navigate('/tasks?tab=plans'),
      }),
    ]));
    return;
  }

  const tasks = state.tasks.filter((t) => t.planId === plan.id);
  const open = tasks.filter((t) => t.status !== 'done');
  const done = tasks.filter((t) => t.status === 'done');
  const pct = tasks.length ? Math.round((done.length / tasks.length) * 100) : 0;

  async function setStatus(task, status) {
    try {
      await api.patchTask(task.id, { status });
      await ctx.rerender();
    } catch (err) { toastError(err); }
  }

  const rowFor = (task) => taskRow(task, {
    onStatus: (s) => setStatus(task, s),
    onEdit: () => openTaskForm({ task, plans: state.plans, onSaved: () => ctx.rerender() }),
    onDelete: async () => {
      const ok = await confirmDialog('删掉这个任务？', `「${task.title}」会被删除。`, '删掉');
      if (!ok) return;
      try { await api.deleteTask(task.id); toast('已删除。'); await ctx.rerender(); } catch (err) { toastError(err); }
    },
  });

  root.appendChild(
    h('div.page', {}, [
      pageHead({
        kicker: `计划 · ${PLAN_STATUS_LABEL[plan.status]}`,
        title: plan.title,
        sub: plan.description || `${tasks.length} 个任务 · 已完成 ${done.length}`,
        actions: [
          h('button.btn', { onclick: () => openPlanForm({ plan, onSaved: () => ctx.rerender() }) }, '编辑计划'),
          h('button.btn.primary', {
            onclick: () => openTaskForm({ plans: state.plans, defaults: { planId: plan.id }, onSaved: () => ctx.rerender() }),
          }, '＋ 加任务'),
        ],
      }),

      h('div.doc-meta.mb2', {}, [
        plan.startDate || plan.endDate
          ? h('span.tag', {}, `${plan.startDate || '—'} → ${plan.endDate || '—'}`)
          : null,
        h('span.tag', {}, `${tasks.length} 个任务`),
        h('span.tag', {}, `已完成 ${done.length}`),
      ]),

      h('div.progress-wrap', {}, [
        h('div.progress', {}, [h('i', { style: { width: `${pct}%` } })]),
        h('div.progress-label', {}, `${done.length} / ${tasks.length}`),
      ]),

      h('div.btn-row.mb2', {}, [
        h('button.btn.ghost', { onclick: () => ctx.navigate('/tasks?tab=plans') }, '← 全部计划'),
      ]),

      tasks.length
        ? h('div', {}, [
            open.length
              ? h('div.card', {}, [
                  h('div.tiny.muted.mb1', {}, `未完成（${open.length}）`),
                  h('div.task-list', {}, open.map(rowFor)),
                ])
              : h('div.notice.quiet', {}, '这个计划下的任务都完成了。'),
            done.length
              ? h('div.card.mt2', {}, [
                  h('div.tiny.muted.mb1', {}, `已完成（${done.length}）`),
                  h('div.task-list.muted-list', {}, done.map(rowFor)),
                ])
              : null,
          ])
        : emptyState({
            icon: '○',
            title: '这个计划下还没有任务',
            hint: '可以从待办里挑几个关进来，也可以让 AI 拆几条，创建时选这个计划。',
            actionLabel: '给它加第一个任务',
            onAction: () => openTaskForm({ plans: state.plans, defaults: { planId: plan.id }, onSaved: () => ctx.rerender() }),
          }),

      h('div.notice.quiet.mt3', {}, '删除这个计划不会删掉它下面的任务，只会解除关联 —— 那些任务仍然在「未完成」里。'),
    ])
  );
}
