/**
 * 页面：学习项目列表
 * 把课程按项目放在一起，先看整体进度，再进详情继续学。
 */

import { api } from '../api.js';
import {
  h, toast, toastError, confirmDialog, emptyState, pageHead,
  fmtRelative, fmtDateTime, truncate,
} from '../ui.js';
import { state } from '../state.js';
import { openProjectForm } from './project-form.js';

export default async function renderProjects(root, ctx) {
  const projects = state.projects || [];

  async function removeProject(project) {
    const count = project.progress ? project.progress.courseCount : (project.courses || []).length;
    const ok = await confirmDialog(
      '删掉这个学习项目？',
      `项目「${project.title}」和它下面的 ${count} 门课程会被删除。`
      + '关联的待办不会被删除，只会解除项目和课程关联。',
      '删掉项目'
    );
    if (!ok) return;
    try {
      const result = await api.deleteProject(project.id);
      toast(result.detachedTasks
        ? `项目已删除，${result.detachedTasks} 个待办已解除关联。`
        : '项目已删除。');
      await ctx.rerender();
    } catch (err) {
      toastError(err);
    }
  }

  function projectCard(project) {
    const progress = project.progress || {};
    const percent = progress.percent;
    const calculable = percent !== null && percent !== undefined;
    const recent = progress.lastStudiedAt
      ? h('span', { title: fmtDateTime(progress.lastStudiedAt) }, `最近学习 ${fmtRelative(progress.lastStudiedAt)}`)
      : h('span', {}, '还没开始学习');

    return h('article.card.clickable.project-card', {
      onclick: () => ctx.navigate(`/projects/${project.id}`),
    }, [
      h('div.project-card-top', {}, [
        h('div.project-card-main', {}, [
          h('div.project-card-kicker', {}, `学习项目 · ${progress.courseCount || 0} 门课程`),
          h('h2.project-card-title', {}, project.title),
          project.description
            ? h('p.project-card-desc', {}, truncate(project.description, 140))
            : h('p.project-card-desc.muted', {}, '还没有写简介。'),
        ]),
        h('div.project-card-actions', {}, [
          h('button.btn.small.ghost', {
            type: 'button',
            onclick: (e) => {
              e.stopPropagation();
              openProjectForm({ project, onSaved: () => ctx.rerender() });
            },
          }, '编辑'),
          h('button.btn.small.ghost.danger', {
            type: 'button',
            onclick: (e) => {
              e.stopPropagation();
              removeProject(project);
            },
          }, '删除'),
        ]),
      ]),

      h('div.project-progress', {}, [
        h('div.project-progress-head', {}, [
          h('span.project-progress-value', {}, calculable ? `${percent}%` : '暂无进度'),
          h('span.project-progress-note', {}, calculable
            ? `已完成 ${progress.completedEpisodes || 0} / 共 ${progress.totalEpisodes || 0} 集`
            : (progress.courseCount ? '课程未填总集数' : '还没有课程')),
        ]),
        h('div.progress', {}, [
          h('i', { style: { width: `${calculable ? percent : 0}%` } }),
        ]),
      ]),

      h('div.project-meta', {}, [
        progress.finishedCourses ? h('span', {}, `${progress.finishedCourses} 门已学完`) : null,
        progress.coursesWithoutTotal
          ? h('span', {}, `${progress.coursesWithoutTotal} 门未填总集数`)
          : null,
        recent,
      ]),

      h('div.project-card-foot', {}, [
        h('span.project-enter', {}, '进入项目 →'),
      ]),
    ]);
  }

  root.appendChild(
    h('div.page.projects-page', {}, [
      pageHead({
        title: '学习项目',
        sub: '把正在学的课程放进同一个项目，记录最近看到哪一集。进度只看你自己确认过的完成集数。',
        actions: [
          h('button.btn.primary', {
            type: 'button',
            onclick: () => openProjectForm({ onSaved: () => ctx.rerender() }),
          }, '＋ 新建项目'),
        ],
      }),

      projects.length
        ? h('div.project-list', {}, projects.map(projectCard))
        : emptyState({
            icon: '▣',
            title: '还没有学习项目',
            hint: '建一个项目，把考研数学、自动控制原理这类课程放进去，就能一直看到自己学到哪了。',
            actionLabel: '新建第一个项目',
            onAction: () => openProjectForm({ onSaved: () => ctx.rerender() }),
          }),
    ])
  );
}
