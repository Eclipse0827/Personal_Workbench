/**
 * 任务表单（新增 / 编辑共用）
 * PRD 2.3：手动新增最少只要求「任务标题」，其余全部可选。
 * 所以这里刻意不做任何必填校验，除了标题。
 */

import { api } from '../api.js';
import { h, modal, toast, toastError, TASK_STATUS_LABEL, TASK_PRIORITY_LABEL, today } from '../ui.js';

/**
 * 打开任务表单。
 * @param {object} opts
 *   task     要编辑的任务（不传＝新增）
 *   plans    可关联的计划列表
 *   projects 可关联的学习项目列表
 *   defaults 新增时的默认值（例如 { scheduledDate: today, planId, projectId }）
 *   onSaved  保存成功回调
 */
export function openTaskForm({ task = null, plans = [], projects = [], defaults = {}, onSaved } = {}) {
  const isEdit = Boolean(task);
  const t = task || {};

  const title = h('input', { type: 'text', value: t.title || '', placeholder: '例如：完成数学第一章的 20 道题' });
  const description = h('textarea', { rows: 2, value: t.description || '', placeholder: '可选的补充说明' });
  const scheduledDate = h('input', { type: 'date', value: t.scheduledDate || defaults.scheduledDate || '' });
  const dueDate = h('input', { type: 'date', value: t.dueDate || defaults.dueDate || '' });
  const priority = h('select', {}, [
    h('option', { value: 'normal', selected: (t.priority || 'normal') === 'normal' }, '普通'),
    h('option', { value: 'important', selected: t.priority === 'important' }, '重要'),
  ]);
  const status = h('select', {}, ['todo', 'doing', 'done'].map((s) =>
    h('option', { value: s, selected: (t.status || 'todo') === s }, TASK_STATUS_LABEL[s])));
  const plan = h('select', {}, [
    h('option', { value: '', selected: !(t.planId || defaults.planId) }, '不关联计划'),
    ...plans.map((p) =>
      h('option', {
        value: p.id,
        selected: (t.planId || defaults.planId) === p.id,
      }, p.title)),
  ]);
  const project = h('select', {}, [
    h('option', { value: '', selected: !(t.projectId || defaults.projectId) }, '不关联学习项目'),
    ...projects.map((p) =>
      h('option', {
        value: p.id,
        selected: (t.projectId || defaults.projectId) === p.id,
      }, p.title)),
  ]);

  const body = h('div', {}, [
    h('label.field', {}, [
      h('span.label-text', {}, '要做什么'),
      title,
    ]),
    h('label.field', {}, [
      h('span.label-text', {}, '补充说明'),
      h('span.label-hint', {}, '可选。'),
      description,
    ]),
    h('div.split', {}, [
      h('label.field', {}, [
        h('span.label-text', {}, '哪天做'),
        h('span.label-hint', {}, '可选。定了就出现在那天的今日计划里。'),
        scheduledDate,
      ]),
      h('label.field', {}, [
        h('span.label-text', {}, '截止日期'),
        h('span.label-hint', {}, '可选。'),
        dueDate,
      ]),
    ]),
    h('div.split', {}, [
      h('label.field', {}, [h('span.label-text', {}, '优先级'), priority]),
      h('label.field', {}, [h('span.label-text', {}, '状态'), status]),
    ]),
    h('div.split', {}, [
      plans.length
        ? h('label.field.mb0', {}, [
            h('span.label-text', {}, '属于哪个计划'),
            h('span.label-hint', {}, '可选。'),
            plan,
          ])
        : h('p.tiny.muted.mb0', {}, '还没有学习计划。需要的话可以在「待办与计划」里先建一个。'),
      projects.length
        ? h('label.field.mb0', {}, [
            h('span.label-text', {}, '属于哪个学习项目'),
            h('span.label-hint', {}, '可选。归到项目里，在项目页就能看到这条。'),
            project,
          ])
        : h('p.tiny.muted.mb0', {}, '还没有学习项目，可以先在「学习项目」里建一个。'),
    ]),
  ]);

  modal({
    title: isEdit ? '编辑任务' : '新增任务',
    body,
    actions: [
      { label: '取消' },
      {
        label: isEdit ? '保存' : '创建',
        primary: true,
        onClick: async () => {
          if (!title.value.trim()) {
            toast('给它起个名字吧，一句话就行。', 'warn');
            title.focus();
            return false;
          }
          try {
            const nextProjectId = project.value || null;
            const payload = {
              title: title.value,
              description: description.value,
              scheduledDate: scheduledDate.value || null,
              dueDate: dueDate.value || null,
              priority: priority.value,
              status: status.value,
              planId: plan.value || null,
              projectId: nextProjectId,
              // 换了项目就把旧课程关联清掉，免得课程挂在别的项目下面
              courseId: nextProjectId === (t.projectId || null) ? (t.courseId || null) : null,
            };
            if (isEdit) await api.patchTask(t.id, payload);
            else await api.createTask(payload);
            toast(isEdit ? '改好了。' : '加进去了。');
            if (onSaved) await onSaved();
          } catch (err) {
            toastError(err);
            return false;
          }
        },
      },
    ],
  });
}

/** 建计划 */
export function openPlanForm({ plan = null, onSaved } = {}) {
  const isEdit = Boolean(plan);
  const p = plan || {};
  const title = h('input', { type: 'text', value: p.title || '', placeholder: '例如：考研初试 · 数学一 + 英语一' });
  const description = h('textarea', { rows: 2, value: p.description || '', placeholder: '这个计划大概要到什么时候、做到什么程度' });
  const startDate = h('input', { type: 'date', value: p.startDate || '' });
  const endDate = h('input', { type: 'date', value: p.endDate || '' });
  const status = h('select', {}, ['active', 'done', 'archived'].map((s) =>
    h('option', { value: s, selected: (p.status || 'active') === s },
      { active: '进行中', done: '已完成', archived: '已归档' }[s])));

  modal({
    title: isEdit ? '编辑计划' : '新建学习计划',
    body: h('div', {}, [
      h('label.field', {}, [h('span.label-text', {}, '计划名称'), title]),
      h('label.field', {}, [
        h('span.label-text', {}, '说明'),
        h('span.label-hint', {}, '可选。'),
        description,
      ]),
      h('div.split', {}, [
        h('label.field', {}, [h('span.label-text', {}, '开始'), startDate]),
        h('label.field', {}, [h('span.label-text', {}, '结束'), endDate]),
      ]),
      isEdit ? h('label.field.mb0', {}, [h('span.label-text', {}, '状态'), status]) : null,
    ]),
    actions: [
      { label: '取消' },
      {
        label: isEdit ? '保存' : '创建',
        primary: true,
        onClick: async () => {
          if (!title.value.trim()) {
            toast('给这个计划起个名字吧。', 'warn');
            return false;
          }
          try {
            const payload = {
              title: title.value,
              description: description.value,
              startDate: startDate.value || null,
              endDate: endDate.value || null,
              status: status.value,
            };
            if (isEdit) await api.patchPlan(p.id, payload);
            else await api.createPlan(payload);
            toast(isEdit ? '改好了。' : '计划建好了。');
            if (onSaved) await onSaved();
          } catch (err) {
            toastError(err);
            return false;
          }
        },
      },
    ],
  });
}
