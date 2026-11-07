'use strict';

/**
 * 学习项目与课程
 * ---------------------------------------------------------------
 * 一个项目（例如「考研数学」）下面挂着若干课程（例如「高数基础班」）。
 * 课程里有两组容易混淆的数字，必须分开：
 *   · lastEpisode       最近正在看第几集 —— 「继续学习」按它打开
 *   · completedEpisodes 连续学完了几集 —— 只有用户确认「完成本集」才增加
 *
 * 第一版采用顺序学习：completedEpisodes 只表示从第 1 集开始的连续完成数。
 * 用户跳到第 12 集时，绝不推断前面的集数都已完成。
 */

const { newId, nowIso } = require('./db');

const COURSE_PLATFORM = ['bilibili', 'mooc', 'other'];
const COURSE_PLATFORM_LABEL = { bilibili: 'B 站', mooc: '慕课', other: '其他' };

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function str(v, max = 2000) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function oneOf(v, allowed, fallback) {
  return allowed.includes(v) ? v : fallback;
}

/** 集数：缺省按 fallback，填了就必须是非负整数 */
function episode(value, label, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw bad(`${label}必须是非负整数`);
  if (n > 10000) throw bad(`${label}不能超过 10000`);
  return n;
}

function isoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** 只接受 http/https；空字符串表示这门课暂时没有链接 */
function normalizeUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw bad('课程链接要以 http:// 或 https:// 开头');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw bad('课程链接要以 http:// 或 https:// 开头');
  }
  return raw.slice(0, 2000);
}

/** 总集数确定时，两个集数都不能超过总集数；最近学习集数也不能落后于已完成集数 */
function reconcileEpisodes(total, last, completed) {
  let l = last;
  let c = completed;
  if (total > 0) {
    l = Math.min(l, total);
    c = Math.min(c, total);
  }
  if (l < c) l = c;
  return { lastEpisode: l, completedEpisodes: c };
}

// ---------------------------------------------------------------- 课程

function newCourse(input = {}) {
  const now = nowIso();
  const total = episode(input.totalEpisodes, '总集数');
  const numbers = reconcileEpisodes(
    total,
    episode(input.lastEpisode, '最近学习集数'),
    episode(input.completedEpisodes, '已完成集数'),
  );
  return {
    id: newId('course'),
    title: str(input.title, 200) || '未命名课程',
    platform: oneOf(input.platform, COURSE_PLATFORM, 'other'),
    url: normalizeUrl(input.url),
    /** 课程来源的补充说明，例如「2024 版」「讲义在网盘」 */
    source: str(input.source, 300),
    totalEpisodes: total,
    lastEpisode: numbers.lastEpisode,
    completedEpisodes: numbers.completedEpisodes,
    lastStudiedAt: isoOrNull(input.lastStudiedAt),
    createdAt: now,
    updatedAt: now,
  };
}

function patchCourse(course, patch = {}) {
  if (patch.title !== undefined) {
    const title = str(patch.title, 200);
    if (!title) throw bad('给这门课起个名字');
    course.title = title;
  }
  if (patch.platform !== undefined) {
    if (!COURSE_PLATFORM.includes(patch.platform)) throw bad('课程平台只能是 bilibili / mooc / other');
    course.platform = patch.platform;
  }
  if (patch.url !== undefined) course.url = normalizeUrl(patch.url);
  if (patch.source !== undefined) course.source = str(patch.source, 300);

  const total = patch.totalEpisodes !== undefined
    ? episode(patch.totalEpisodes, '总集数')
    : course.totalEpisodes;
  const last = patch.lastEpisode !== undefined
    ? episode(patch.lastEpisode, '最近学习集数')
    : course.lastEpisode;
  const completed = patch.completedEpisodes !== undefined
    ? episode(patch.completedEpisodes, '已完成集数')
    : course.completedEpisodes;

  const numbers = reconcileEpisodes(total, last, completed);
  course.totalEpisodes = total;
  course.lastEpisode = numbers.lastEpisode;
  course.completedEpisodes = numbers.completedEpisodes;
  course.updatedAt = nowIso();
  return course;
}

/**
 * 「继续学习」要打开第几集。
 * 学到一半时打开 lastEpisode（而不是 completedEpisodes + 1），
 * 只有这一集确认完成之后，下一次才会自然进入下一集。
 */
function continueTarget(course) {
  const total = Number(course.totalEpisodes) || 0;
  const last = Number(course.lastEpisode) || 0;
  const completed = Number(course.completedEpisodes) || 0;
  const finished = total > 0 && completed >= total;
  if (finished) return { episode: last > 0 ? last : total, finished: true };
  if (last > completed) return { episode: last, finished: false };
  return { episode: completed + 1, finished: false };
}

/**
 * 只在明确是分 P 视频时才改链接：
 *   · bilibili.com /video/ 路径本身已经带 p 参数
 *   · 其他情况一律返回用户保存的原始链接
 */
function resolveStudyUrl(raw, targetEpisode) {
  const original = typeof raw === 'string' ? raw.trim() : '';
  if (!original) return { url: '', located: false };
  let url;
  try {
    url = new URL(original);
  } catch {
    return { url: original, located: false };
  }
  if (!['http:', 'https:'].includes(url.protocol)) return { url: original, located: false };

  const host = url.hostname.toLowerCase();
  const isBilibili = host === 'bilibili.com' || host.endsWith('.bilibili.com');
  const isVideo = /^\/video\/[^/]+/.test(url.pathname);
  if (!isBilibili || !isVideo || !url.searchParams.has('p')) {
    return { url: original, located: false };
  }

  url.searchParams.set('p', String(Math.max(1, Math.round(Number(targetEpisode) || 1))));
  return { url: url.toString(), located: true };
}

/** 点「继续学习」：先把实际打开的集数写回去，保证最近位置和页面一致 */
function openForStudy(course) {
  const target = continueTarget(course);
  const link = resolveStudyUrl(course.url, target.episode);
  const now = nowIso();
  course.lastEpisode = target.episode;
  course.lastStudiedAt = now;
  course.updatedAt = now;
  return { targetEpisode: target.episode, finished: target.finished, ...link };
}

/**
 * 用户确认「完成本集」。
 * 顺序学习：最近打开的集数必须正好是已完成集数 + 1，否则说明跳集了。
 * 跳集不报错，但也不会替用户推断中间那些集已经完成 —— 会明确拒绝并说明原因。
 */
function completeCurrent(course) {
  const total = Number(course.totalEpisodes) || 0;
  const last = Number(course.lastEpisode) || 0;
  const completed = Number(course.completedEpisodes) || 0;

  if (total > 0 && completed >= total) throw bad('这门课已经全部学完了。', 409);
  if (last <= 0) throw bad('还没有打开过任何一集，先点「继续学习」。', 409);
  if (last <= completed) throw bad(`第 ${last} 集已经完成过了。`, 409);
  if (last !== completed + 1) {
    throw bad(
      `第一版按顺序记录进度：已完成 ${completed} 集，最近打开的是第 ${last} 集。`
      + `请先回到第 ${completed + 1} 集继续，或手动调整进度。`,
      409,
    );
  }

  const now = nowIso();
  course.completedEpisodes = last;
  course.lastStudiedAt = now;
  course.updatedAt = now;
  return { completedEpisodes: course.completedEpisodes, nextEpisode: continueTarget(course).episode };
}

// ---------------------------------------------------------------- 项目

function newProject(input = {}) {
  const now = nowIso();
  return {
    id: newId('proj'),
    title: str(input.title, 200) || '未命名学习项目',
    description: str(input.description, 2000),
    courses: [],
    createdAt: now,
    updatedAt: now,
  };
}

function patchProject(project, patch = {}) {
  if (patch.title !== undefined) {
    const title = str(patch.title, 200);
    if (!title) throw bad('给这个学习项目起个名字');
    project.title = title;
  }
  if (patch.description !== undefined) project.description = str(patch.description, 2000);
  project.updatedAt = nowIso();
  return project;
}

function addCourse(project, input) {
  const course = newCourse(input);
  if (!Array.isArray(project.courses)) project.courses = [];
  project.courses.push(course);
  project.updatedAt = nowIso();
  return course;
}

function findCourse(project, courseId) {
  if (!project || !Array.isArray(project.courses)) return null;
  return project.courses.find((c) => c.id === courseId) || null;
}

function removeCourse(project, courseId) {
  if (!Array.isArray(project.courses)) return null;
  const index = project.courses.findIndex((c) => c.id === courseId);
  if (index < 0) return null;
  const [course] = project.courses.splice(index, 1);
  project.updatedAt = nowIso();
  return course;
}

/** 跨项目查找课程，供「只传 courseId」的任务关联使用 */
function locateCourse(projectList, courseId) {
  for (const project of projectList || []) {
    const course = findCourse(project, courseId);
    if (course) return { project, course };
  }
  return null;
}

/** 课程的对外形状：原始字段 + 计算出来的进度 */
function courseSummary(course) {
  const total = Number(course.totalEpisodes) || 0;
  const completed = Number(course.completedEpisodes) || 0;
  const target = continueTarget(course);
  return {
    ...course,
    percent: total > 0 ? Math.round((Math.min(completed, total) / total) * 100) : null,
    finished: total > 0 && completed >= total,
    continueEpisode: target.episode,
    continueFinished: target.finished,
  };
}

/**
 * 项目进度按集数加权：
 *   Σ 已完成集数 / Σ 总集数，且只统计填写了总集数的课程。
 * 所有课程都没填总集数时，percent 为 null（界面显示「进度暂不可计算」）。
 */
function publicProject(project) {
  const courses = Array.isArray(project.courses) ? project.courses.map(courseSummary) : [];
  const known = courses.filter((c) => c.totalEpisodes > 0);
  const totalEpisodes = known.reduce((n, c) => n + Number(c.totalEpisodes || 0), 0);
  const completedEpisodes = known.reduce(
    (n, c) => n + Math.min(Number(c.completedEpisodes || 0), Number(c.totalEpisodes || 0)),
    0,
  );
  const lastStudiedAt = courses
    .map((c) => c.lastStudiedAt)
    .filter(Boolean)
    .sort()
    .slice(-1)[0] || null;

  return {
    ...project,
    courses,
    progress: {
      calculable: totalEpisodes > 0,
      percent: totalEpisodes > 0 ? Math.round((completedEpisodes / totalEpisodes) * 100) : null,
      totalEpisodes,
      completedEpisodes,
      courseCount: courses.length,
      finishedCourses: courses.filter((c) => c.finished).length,
      coursesWithoutTotal: courses.filter((c) => c.totalEpisodes === 0).length,
      lastStudiedAt,
    },
  };
}

module.exports = {
  COURSE_PLATFORM,
  COURSE_PLATFORM_LABEL,
  newProject,
  patchProject,
  newCourse,
  patchCourse,
  addCourse,
  findCourse,
  removeCourse,
  locateCourse,
  continueTarget,
  resolveStudyUrl,
  openForStudy,
  completeCurrent,
  courseSummary,
  publicProject,
};
