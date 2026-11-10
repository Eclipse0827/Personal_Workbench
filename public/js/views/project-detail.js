/**
 * 页面：学习项目详情
 * 课程进度以服务端返回的字段为准；继续学习 / 完成本集只调用接口，不在前端算集数。
 */

import { api } from '../api.js';
import {
  h, toast, toastError, confirmDialog, taskRow, emptyState, pageHead,
  fmtRelative, fmtDateTime, COURSE_PLATFORM_LABEL,
} from '../ui.js';
import { state, projectById, planById } from '../state.js';
import { openProjectForm, openCourseForm } from './project-form.js';
import { openTaskForm } from './task-form.js';

export default async function renderProjectDetail(root, ctx) {
  const project = projectById(ctx.args.id);

  if (!project) {
    root.appendChild(
      h('div.page.projects-page', {}, [
        emptyState({
          icon: '▣',
          title: '找不到这个学习项目',
          hint: '它可能已经被删除，或者链接写错了。',
          actionLabel: '回到学习项目',
          onAction: () => ctx.navigate('/projects'),
        }),
      ])
    );
    return;
  }

  const courses = project.courses || [];
  const progress = project.progress || {};

  function openAddCourse() {
    openCourseForm({
      projectId: project.id,
      onSaved: () => ctx.rerender(),
    });
  }

  async function removeProject() {
    const ok = await confirmDialog(
      '删掉这个学习项目？',
      `项目「${project.title}」和它下面的 ${courses.length} 门课程会被删除。`
      + '关联的待办不会被删除，只会解除项目和课程关联。',
      '删掉项目'
    );
    if (!ok) return;
    try {
      const result = await api.deleteProject(project.id);
      toast(result.detachedTasks
        ? `项目已删除，${result.detachedTasks} 个待办已解除关联。`
        : '项目已删除。');
      await ctx.refresh();
      ctx.navigate('/projects');
    } catch (err) {
      toastError(err);
    }
  }

  async function removeCourse(course) {
    const ok = await confirmDialog(
      '删掉这门课程？',
      `课程「${course.title}」会被删除。关联的待办不会被删除，只会解除课程关联。`,
      '删掉课程'
    );
    if (!ok) return;
    try {
      const result = await api.deleteCourse(project.id, course.id);
      toast(result.detachedTasks
        ? `课程已删除，${result.detachedTasks} 个待办已解除课程关联。`
        : '课程已删除。');
      await ctx.rerender();
    } catch (err) {
      toastError(err);
    }
  }

  async function continueStudy(course) {
    // 先同步开一个空白页，等接口确认实际集数后再把地址填进去
    const pending = course.url ? window.open('', '_blank') : null;
    try {
      const result = await api.continueCourse(project.id, course.id);
      if (result.url) {
        if (pending && !pending.closed) {
          pending.opener = null;
          pending.location.href = result.url;
        } else {
          window.open(result.url, '_blank', 'noopener');
        }
        toast(result.finished
          ? `这门课已学完，打开第 ${result.targetEpisode} 集。`
          : `打开第 ${result.targetEpisode} 集。`);
      } else {
        if (pending) pending.close();
        toast(`已记下学习位置：第 ${result.targetEpisode} 集。这门课还没有保存链接。`, 'warn');
      }
      await ctx.rerender();
    } catch (err) {
      if (pending) pending.close();
      toastError(err);
    }
  }

  async function completeCurrent(course) {
    try {
      const result = await api.completeCourse(project.id, course.id);
      toast(`已完成第 ${result.completedEpisodes} 集。下次继续第 ${result.nextEpisode} 集。`);
      await ctx.rerender();
    } catch (err) {
      toastError(err);
    }
  }

  function stat(label, value, hint = '') {
    return h('div.course-stat', {}, [
      h('div.course-stat-label', {}, label),
      h('div.course-stat-value', {}, value),
      hint ? h('div.course-stat-hint', {}, hint) : null,
    ]);
  }

  function courseCard(course) {
    const percent = course.percent;
    const calculable = percent !== null && percent !== undefined;
    const lastText = course.lastStudiedAt
      ? h('span', { title: fmtDateTime(course.lastStudiedAt) }, `最近学习 ${fmtRelative(course.lastStudiedAt)}`)
      : h('span', {}, '还没开始');

    return h('div.card.course-card', {}, [
      h('div.course-head', {}, [
        h('div.course-head-main', {}, [
          h('div.course-title-line', {}, [
            h('h3.course-title', {}, course.title),
            course.finished ? h('span.tag.accent', {}, '已学完') : null,
          ]),
          h('div.course-sub', {}, [
            h('span.tag.calm', {}, COURSE_PLATFORM_LABEL[course.platform] || course.platform),
            h('span.course-source', {}, course.source ? `来源：${course.source}` : '来源未填写'),
            lastText,
          ]),
        ]),
        h('div.course-actions', {}, [
          h('button.btn.small.primary', {
            type: 'button',
            title: '打开课程链接，并把最近学习位置更新为实际打开的集数',
            onclick: () => continueStudy(course),
          }, '继续学习'),
          h('button.btn.small', {
            type: 'button',
            disabled: course.finished,
            title: course.finished ? '这门课已经全部学完' : '确认学完最近打开的这一集',
            onclick: () => completeCurrent(course),
          }, '完成本集'),
          h('button.btn.small.ghost', {
            type: 'button',
            onclick: () => openCourseForm({
              projectId: project.id,
              course,
              onSaved: () => ctx.rerender(),
            }),
          }, '编辑'),
          h('button.btn.small.ghost.danger', {
            type: 'button',
            onclick: () => removeCourse(course),
          }, '删除'),
        ]),
      ]),

      h('div.course-numbers', {}, [
        stat('已完成', `${course.completedEpisodes || 0} 集`),
        stat('最近学习集数', course.lastEpisode > 0 ? `第 ${course.lastEpisode} 集` : '还没开始'),
        stat('总集数', course.totalEpisodes > 0 ? `${course.totalEpisodes} 集` : '未填写',
          course.totalEpisodes > 0 ? '' : '不参与项目进度'),
      ]),

      h('div.course-progress', {}, [
        h('div.progress', {}, [
          h('i', { style: { width: `${calculable ? percent : 0}%` } }),
        ]),
        h('span.course-progress-label', {}, calculable
          ? `${percent}%`
          : '进度暂不可计算'),
      ]),
    ]);
  }

  // 归到这个项目下的待办：AI 建的、手动选的，都在这里能看见
  const relatedTasks = (state.tasks || []).filter((t) => t.projectId === project.id);
  const relatedSorted = [
    ...relatedTasks.filter((t) => t.status !== 'done'),
    ...relatedTasks.filter((t) => t.status === 'done'),
  ];

  function relatedRow(task) {
    return taskRow(task, {
      planName: task.planId ? (planById(task.planId) || {}).title : null,
      onStatus: async (s) => {
        try { await api.patchTask(task.id, { status: s }); await ctx.rerender(); }
        catch (err) { toastError(err); }
      },
      onEdit: () => openTaskForm({
        task,
        plans: state.plans || [],
        projects: state.projects || [],
        onSaved: () => ctx.rerender(),
      }),
      onDelete: async () => {
        const ok = await confirmDialog('删掉这个任务？', `「${task.title}」会被删除。`, '删掉');
        if (!ok) return;
        try { await api.deleteTask(task.id); toast('已删除。'); await ctx.rerender(); }
        catch (err) { toastError(err); }
      },
    });
  }

  root.appendChild(
    h('div.page.projects-page.project-detail-page', {}, [
      pageHead({
        kicker: `${progress.courseCount || 0} 门课程`,
        title: project.title,
        sub: project.description || '还没有写项目简介。',
        actions: [
          h('button.btn.ghost', {
            type: 'button',
            onclick: () => ctx.navigate('/projects'),
          }, '← 返回项目'),
          h('button.btn.ghost', {
            type: 'button',
            onclick: () => openProjectForm({ project, onSaved: () => ctx.rerender() }),
          }, '编辑项目'),
          h('button.btn.primary', {
            type: 'button',
            onclick: openAddCourse,
          }, '＋ 添加课程'),
        ],
      }),

      h('div.card.project-overview', {}, [
        h('div.project-overview-head', {}, [
          h('div', {}, [
            h('div.project-overview-label', {}, '项目整体进度'),
            h('div.project-overview-value', {}, progress.percent === null
              ? '暂不可计算'
              : `${progress.percent}%`),
          ]),
          h('div.project-overview-meta', {}, [
            h('span', {}, progress.percent === null
              ? (progress.courseCount
                ? '还没有课程填写总集数'
                : '添加课程并填写总集数后就能看到进度')
              : `已完成 ${progress.completedEpisodes || 0} / 共 ${progress.totalEpisodes || 0} 集`),
            progress.lastStudiedAt
              ? h('span', { title: fmtDateTime(progress.lastStudiedAt) }, `最近学习 ${fmtRelative(progress.lastStudiedAt)}`)
              : h('span', {}, '还没开始学习'),
          ]),
        ]),
        h('div.progress', {}, [
          h('i', { style: { width: `${progress.percent === null ? 0 : progress.percent}%` } }),
        ]),
        h('div.project-overview-foot', {}, [
          h('span', {}, `${progress.courseCount || 0} 门课程`),
          progress.finishedCourses ? h('span', {}, `${progress.finishedCourses} 门已学完`) : null,
          progress.coursesWithoutTotal
            ? h('span', {}, `${progress.coursesWithoutTotal} 门未填总集数，不参与进度计算`)
            : null,
          h('button.btn.small.ghost.danger', {
            type: 'button',
            onclick: removeProject,
            style: { marginLeft: 'auto' },
          }, '删除项目'),
        ]),
      ]),

      h('div.section.project-course-section', {}, [
        h('div.section-head.inline', {}, [
          h('h2', {}, '课程'),
          h('span.count', {}, `${courses.length} 门`),
          h('button.btn.small.ghost', {
            type: 'button',
            onclick: openAddCourse,
            style: { marginLeft: 'auto' },
          }, '＋ 添加课程'),
        ]),
        courses.length
          ? h('div.course-list', {}, courses.map(courseCard))
          : emptyState({
              icon: '▤',
              title: '这个项目还没有课程',
              hint: '把正在学的课程加进来，填上总集数和最近学习位置就能记录进度。',
              actionLabel: '添加第一门课程',
              onAction: openAddCourse,
            }),
      ]),

      h('div.section.project-task-section', {}, [
        h('div.section-head.inline', {}, [
          h('h2', {}, '相关待办'),
          h('span.count', {}, `${relatedTasks.length} 条`),
          h('button.btn.small.ghost', {
            type: 'button',
            style: { marginLeft: 'auto' },
            onclick: () => openTaskForm({
              plans: state.plans || [],
              projects: state.projects || [],
              defaults: { projectId: project.id },
              onSaved: () => ctx.rerender(),
            }),
          }, '＋ 加待办'),
        ]),
        relatedTasks.length
          ? h('div.task-list', {}, relatedSorted.map(relatedRow))
          : h('p.tiny.muted', {}, '还没有归到这个项目的待办。让 AI 建的时候指定项目，或点右上角加一条。'),
      ]),
    ])
  );
}
