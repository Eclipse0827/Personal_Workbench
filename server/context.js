'use strict';

/**
 * AI 学习上下文构建（阶段 1：只读）
 * ---------------------------------------------------------------
 * 只汇总用户明确选择的真实记录，生成有上限的事实摘要，不把整个数据库交给模型。
 *
 * 两条硬规则：
 *   · 只描述系统里实际存在的记录；「没有记录」不能写成「没有学习」
 *   · 知识点、错题、复习进度目前没有数据模型，只能明确说无法引用
 *
 * 本文件不调用 AI，也不写数据库；预览和将来真正的对话共用同一份构建逻辑。
 */

const db = require('./db');
const models = require('./models');
const projectLib = require('./projects');
const {
  focusStats,
  focusSeconds,
  localDayKey,
} = require('./focus-stats');

const WINDOW_DAYS = [0, 7, 30];
const MAX_COURSES = 10;
const MAX_FOCUS_CONTENT = 8;
const MAX_TODAY_TITLES = 8;
const MAX_OVERDUE_TITLES = 5;
const MAX_RECENT_DONE = 10;
const MAX_TEXT_CHARS = 4000;

const EMPTY_SELECTION = {
  projectId: null,
  windowDays: 0,
  includeTasks: false,
  includeKnowledge: false,
};

function selectionError(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function emptySelection() {
  return { ...EMPTY_SELECTION };
}

function clip(text, max) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value.trim());
}

/**
 * 校验并裁剪用户选择。
 * 非法字段直接拒绝，避免把「全部数据」当成默认值悄悄发给模型。
 */
function normalizeSelection(input) {
  if (input === undefined || input === null) return emptySelection();
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw selectionError('学习数据选择格式不正确');
  }

  let projectId = null;
  if (input.projectId !== undefined && input.projectId !== null && input.projectId !== '') {
    if (!validId(input.projectId)) throw selectionError('学习项目标识不正确');
    projectId = input.projectId.trim();
  }

  const rawDays = input.windowDays === undefined || input.windowDays === null || input.windowDays === ''
    ? 0
    : Number(input.windowDays);
  if (!Number.isInteger(rawDays) || !WINDOW_DAYS.includes(rawDays)) {
    throw selectionError('学习记录只能选择不引用、最近 7 天或最近 30 天');
  }

  const readBoolean = (value, label) => {
    if (value === undefined || value === null) return false;
    if (typeof value !== 'boolean') throw selectionError(`${label}只能是开关值`);
    return value;
  };
  const includeTasks = readBoolean(input.includeTasks, '待办完成情况');
  const includeKnowledge = readBoolean(input.includeKnowledge, '知识点和错题');
  if (includeKnowledge) {
    throw selectionError('知识点、错题和复习进度目前没有记录，不能选择');
  }

  return { projectId, windowDays: rawDays, includeTasks, includeKnowledge };
}

function hasSelection(selection) {
  return Boolean(
    selection
    && (selection.projectId || selection.windowDays > 0 || selection.includeTasks)
  );
}

function recentDayKeys(days, now = new Date()) {
  const keys = new Set();
  for (let i = Math.max(0, days - 1); i >= 0; i -= 1) {
    keys.add(localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return keys;
}

function durationText(seconds) {
  const minutes = Math.round((Number(seconds) || 0) / 60);
  if (minutes <= 0) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

/** 项目只保留对话需要的字段，不带课程链接等无关内容 */
function projectFacts(raw) {
  const pub = projectLib.publicProject(raw);
  const allCourses = Array.isArray(pub.courses) ? pub.courses : [];
  const courses = allCourses.slice(0, MAX_COURSES).map((course) => ({
    title: clip(course.title, 120) || '未命名课程',
    platform: course.platform,
    source: clip(course.source, 120),
    totalEpisodes: Number(course.totalEpisodes) || 0,
    lastEpisode: Number(course.lastEpisode) || 0,
    completedEpisodes: Number(course.completedEpisodes) || 0,
    percent: Number.isFinite(course.percent) ? course.percent : null,
    finished: Boolean(course.finished),
    lastStudiedAt: course.lastStudiedAt || null,
  }));
  const progress = pub.progress || {};
  return {
    id: pub.id,
    title: clip(pub.title, 120) || '未命名学习项目',
    description: clip(pub.description, 240),
    courses,
    coursesTruncated: allCourses.length > MAX_COURSES,
    progress: {
      calculable: Boolean(progress.calculable),
      percent: Number.isFinite(progress.percent) ? progress.percent : null,
      totalEpisodes: Number(progress.totalEpisodes) || 0,
      completedEpisodes: Number(progress.completedEpisodes) || 0,
      courseCount: Number(progress.courseCount) || 0,
      finishedCourses: Number(progress.finishedCourses) || 0,
      coursesWithoutTotal: Number(progress.coursesWithoutTotal) || 0,
      lastStudiedAt: progress.lastStudiedAt || null,
    },
  };
}

function taskTitle(task) {
  return clip(task && task.title, 120) || '未命名待办';
}

function focusSummary(stats, sessions, project, tasks, now) {
  const dayKeys = new Set(stats.byDay.map((day) => day.date));
  const windowSessions = sessions.filter(
    (s) => !s.undoneAt && s.mode === 'focus' && dayKeys.has(localDayKey(s.endedAt))
  );
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  let linkedSeconds = 0;
  let linkedSessions = 0;
  for (const session of windowSessions) {
    if (!project || !session.taskId) continue;
    const task = taskById.get(session.taskId);
    if (!task || task.projectId !== project.id) continue;
    linkedSessions += 1;
    linkedSeconds += focusSeconds(session);
  }

  const latestAt = windowSessions
    .map((s) => s.endedAt)
    .filter(Boolean)
    .sort()
    .slice(-1)[0] || null;

  return {
    windowDays: stats.windowDays,
    from: stats.windowStartKey,
    to: stats.windowEndKey,
    sessionCount: stats.windowSessions,
    totalMinutes: stats.windowMinutes,
    totalSeconds: stats.windowSeconds,
    latestAt,
    byContent: stats.windowByContent.slice(0, MAX_FOCUS_CONTENT).map((item) => ({
      title: clip(item.title, 120) || '未命名专注',
      minutes: item.minutes,
      sessions: item.sessions,
    })),
    contentTruncated: stats.windowByContent.length > MAX_FOCUS_CONTENT,
    linkedToProject: project
      ? { sessions: linkedSessions, minutes: Math.round(linkedSeconds / 60) }
      : null,
    unlinked: project
      ? {
          sessions: windowSessions.length - linkedSessions,
          minutes: Math.round((stats.windowSeconds - linkedSeconds) / 60),
        }
      : null,
    generatedAt: now.toISOString(),
  };
}

function taskSummary(tasks, windowDays, now) {
  const today = localDayKey(now);
  const todayTasks = tasks.filter((task) => models.isToday(task, today));
  const todayDone = todayTasks.filter((task) => task.status === 'done');
  const todayOpen = todayTasks.filter((task) => task.status !== 'done');
  const overdue = tasks.filter((task) => models.isOverdue(task, today));
  const dayKeys = windowDays > 0 ? recentDayKeys(windowDays, now) : new Set();
  const doneInWindow = windowDays > 0
    ? tasks
        .filter((task) => task.status === 'done'
          && task.completedAt
          && dayKeys.has(localDayKey(task.completedAt)))
        .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))
    : [];
  const referenced = new Set([...todayTasks, ...overdue, ...doneInWindow].map((task) => task.id));

  return {
    today: {
      total: todayTasks.length,
      done: todayDone.length,
      open: todayOpen.length,
      openTitles: todayOpen.slice(0, MAX_TODAY_TITLES).map(taskTitle),
      titlesTruncated: todayOpen.length > MAX_TODAY_TITLES,
    },
    overdue: {
      total: overdue.length,
      titles: overdue.slice(0, MAX_OVERDUE_TITLES).map(taskTitle),
      titlesTruncated: overdue.length > MAX_OVERDUE_TITLES,
    },
    windowDone: windowDays > 0
      ? {
          days: windowDays,
          count: doneInWindow.length,
          recent: doneInWindow.slice(0, MAX_RECENT_DONE).map((task) => ({
            title: taskTitle(task),
            completedAt: localDayKey(task.completedAt),
          })),
          titlesTruncated: doneInWindow.length > MAX_RECENT_DONE,
        }
      : null,
    referencedCount: referenced.size,
  };
}

function focusText(focus, project) {
  const lines = [];
  const range = focus.from && focus.to ? `（${focus.from} 至 ${focus.to}）` : '';
  if (focus.sessionCount === 0) {
    lines.push(`【最近 ${focus.windowDays} 天专注】系统里没有这一窗口的专注记录${range}。`);
    return lines;
  }
  lines.push(`【最近 ${focus.windowDays} 天专注】${focus.sessionCount} 次，共 ${durationText(focus.totalSeconds)}${range}`);
  if (project) {
    lines.push('- 以下按专注记录里填写的标题汇总，和项目进度没有自动对应关系');
  }
  for (const item of focus.byContent) {
    lines.push(`- ${item.title}：${item.minutes} 分钟（${item.sessions} 次）`);
  }
  if (focus.contentTruncated) lines.push('- …其余专注内容较多，摘要只列出时长最长的几项');
  if (project && focus.linkedToProject) {
    lines.push(`- 其中能通过待办关联到「${project.title}」的：${focus.linkedToProject.sessions} 次，${focus.linkedToProject.minutes} 分钟`);
    if (focus.unlinked && focus.unlinked.sessions > 0) {
      lines.push(`- 另外 ${focus.unlinked.sessions} 次专注没有关联到该项目，未计入项目时长`);
    }
  }
  return lines;
}

function projectText(project) {
  const lines = [`【学习项目】${project.title}`];
  if (project.description) lines.push(`- 简介：${project.description}`);
  if (project.courses.length === 0) {
    lines.push('- 项目下还没有课程记录。');
    return lines;
  }
  for (const course of project.courses) {
    const total = course.totalEpisodes;
    const completed = Math.min(course.completedEpisodes, total || course.completedEpisodes);
    const progress = total > 0
      ? `已完成 ${completed}/${total} 集（${course.percent}%）`
      : '没有填写总集数，系统无法计算进度';
    const recent = course.lastStudiedAt
      ? `，最近学习 ${localDayKey(course.lastStudiedAt)}`
      : '';
    lines.push(`- ${course.title}：${progress}${recent}`);
  }
  if (project.coursesTruncated) lines.push('- …课程较多，摘要只列出前几门');
  if (project.progress.coursesWithoutTotal > 0) {
    lines.push(`- 有 ${project.progress.coursesWithoutTotal} 门课程未填总集数，不参与项目整体进度`);
  }
  return lines;
}

function tasksText(tasks) {
  const lines = [];
  const donePart = tasks.windowDone
    ? `；最近 ${tasks.windowDone.days} 天完成 ${tasks.windowDone.count} 项`
    : '';
  lines.push(`【待办】今天 ${tasks.today.total} 项：完成 ${tasks.today.done} 项，未完成 ${tasks.today.open} 项；逾期 ${tasks.overdue.total} 项${donePart}`);
  if (tasks.today.openTitles.length) {
    lines.push(`- 今天未完成：${tasks.today.openTitles.join('、')}`);
  }
  if (tasks.overdue.titles.length) {
    lines.push(`- 逾期：${tasks.overdue.titles.join('、')}`);
  }
  if (tasks.windowDone && tasks.windowDone.recent.length) {
    lines.push(`- 最近完成：${tasks.windowDone.recent.map((item) => `${item.title}（${item.completedAt}）`).join('、')}`);
  }
  return lines;
}

/**
 * 构建只读学习上下文。
 * 任何没有记录的情况都会写进 caveats，明确「系统没有记录」而不是「用户没有学习」。
 */
async function buildContext(input, options = {}) {
  const selection = normalizeSelection(input);
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime())
    ? options.now
    : new Date();
  const selected = hasSelection(selection);
  const needsAttribution = Boolean(selection.projectId) && selection.windowDays > 0;

  const [projectRaw, tasks, sessions, aliases] = await Promise.all([
    selection.projectId ? db.getOrNull('projects', selection.projectId) : null,
    (selection.includeTasks || needsAttribution) ? db.list('tasks') : [],
    selection.windowDays > 0 ? db.listSorted('focusSessions') : [],
    selection.windowDays > 0 ? db.getFocusAliases() : {},
  ]);

  const warnings = [];
  const caveats = [];
  const unknowns = ['知识点、错题和复习进度：系统还没有建立这些记录，无法作为依据。'];

  let project = null;
  if (selection.projectId && !projectRaw) {
    warnings.push('所选学习项目已不存在，本次没有引用项目数据。');
  } else if (projectRaw) {
    project = projectFacts(projectRaw);
  }

  let focus = null;
  if (selection.windowDays > 0) {
    const stats = focusStats(sessions, aliases, { days: selection.windowDays, now });
    focus = focusSummary(stats, sessions, project, tasks, now);
    if (focus.sessionCount === 0) {
      caveats.push(
        `最近 ${selection.windowDays} 天系统里没有专注记录；这只是没有记录，不能据此判断这段时间的学习情况。`
      );
    } else if (project && focus.linkedToProject && focus.linkedToProject.sessions === 0) {
      caveats.push('最近的专注记录都没有关联到所选项目，不能据此判断这个项目的学习时长。');
    }
  }

  let taskFacts = null;
  if (selection.includeTasks) {
    taskFacts = taskSummary(tasks, selection.windowDays, now);
    if (!tasks.length) {
      caveats.push('待办里系统没有任何记录；这只是没有记录，不能据此判断学习情况。');
    } else if (taskFacts.today.total === 0 && (!taskFacts.windowDone || taskFacts.windowDone.count === 0)) {
      caveats.push('待办里没有今天或所选窗口内的记录；这只是没有记录，不能据此判断学习情况。');
    }
    if (tasks.some((task) => task.status === 'done' && !task.completedAt)) {
      warnings.push('有已完成待办缺少完成时间，未计入最近完成记录。');
    }
  }

  if (project) {
    if (project.courses.length === 0) {
      caveats.push('这个项目下还没有课程记录，不能据此判断学习内容。');
    } else if (!project.progress.calculable) {
      caveats.push('这个项目还没有填写总集数，系统无法计算进度，也不能据此判断学到哪里。');
    }
  }

  const sources = [];
  if (project) {
    sources.push({
      id: 'project',
      label: `学习项目 · ${project.title}`,
      count: project.courses.length,
    });
  }
  if (focus) {
    sources.push({
      id: 'focus',
      label: `最近 ${focus.windowDays} 天专注`,
      count: focus.sessionCount,
    });
  }
  if (taskFacts) {
    sources.push({
      id: 'tasks',
      label: '待办完成情况',
      count: taskFacts.referencedCount,
    });
  }

  const lines = [];
  if (!selected) {
    lines.push('用户还没有选择学习数据，本次没有任何学习记录可以引用。');
  } else {
    if (project) lines.push(...projectText(project));
    if (focus) lines.push(...focusText(focus, project));
    if (taskFacts) lines.push(...tasksText(taskFacts));
    if (!project && !focus && !taskFacts) {
      lines.push('所选范围里没有可引用的记录。');
    }
  }
  lines.push(`【系统没有的记录】${unknowns.join('；')}`);
  for (const caveat of caveats) lines.push(`【注意】${caveat}`);
  for (const warning of warnings) lines.push(`【提示】${warning}`);

  let text = lines.join('\n');
  if (text.length > MAX_TEXT_CHARS) {
    text = `${text.slice(0, MAX_TEXT_CHARS)}\n…（摘要过长，已截断）`;
    warnings.push(`学习数据摘要超过 ${MAX_TEXT_CHARS} 字，已截断。`);
  }

  return {
    selection,
    selected,
    generatedAt: now.toISOString(),
    available: {
      project: Boolean(projectRaw),
      focus: selection.windowDays > 0,
      tasks: Boolean(taskFacts),
      knowledge: false,
      wrongQuestions: false,
      review: false,
    },
    facts: { project, focus, tasks: taskFacts },
    unknowns,
    caveats,
    warnings,
    sources,
    text,
  };
}

/** 预览不经过 AI，也不写入任何数据 */
async function previewContext(input, options = {}) {
  return buildContext(input, options);
}

/**
 * 给历史消息留的最小快照：只有来源、选择范围和统计信息。
 * 不包含 facts / text，避免把完整学习摘要写进对话记录。
 */
function snapshotContext(context) {
  if (!context) return null;
  const taskSource = (context.sources || []).find((source) => source.id === 'tasks');
  return {
    selection: { ...context.selection },
    sources: (context.sources || []).map((source) => ({
      id: source.id,
      label: source.label,
      count: source.count,
    })),
    generatedAt: context.generatedAt,
    counts: {
      projectCourses: context.facts && context.facts.project
        ? context.facts.project.courses.length
        : 0,
      focusSessions: context.facts && context.facts.focus
        ? context.facts.focus.sessionCount
        : 0,
      taskItems: taskSource ? taskSource.count : 0,
    },
    caveatCount: (context.caveats || []).length,
    warningCount: (context.warnings || []).length,
  };
}

module.exports = {
  WINDOW_DAYS,
  normalizeSelection,
  hasSelection,
  buildContext,
  previewContext,
  snapshotContext,
};
