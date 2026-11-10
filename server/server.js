'use strict';

/**
 * 《缓一缓》个人学术工作台 —— HTTP 服务
 * ---------------------------------------------------------------
 * 只用 Node 内置模块，不需要 npm install。
 *
 *   node server/server.js              http://127.0.0.1:5180
 *   node server/server.js --open       启动并打开浏览器
 *   node server/server.js --port 8080  换端口
 *
 * 分层（PRD 6.2）：
 *   静态文件  →  public/
 *   API 路由  →  本文件（只做参数校验和流程编排）
 *   数据访问  →  db.js（唯一入口，也是将来切后端的接口边界）
 *   数据模型  →  models.js（字段与校验）
 *   AI 服务   →  ai.js（mock / real，可替换）
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

const db = require('./db');
const models = require('./models');
const projectLib = require('./projects');
const ai = require('./ai');
const textbook = require('./textbook');
const articles = require('./articles');
const articleAI = require('./article-ai');
const contextLib = require('./context');
const {
  localDayKey,
  focusContentKey,
  focusTitleKey,
  resolveFocusAlias,
  focusAliasList,
  focusStats,
} = require('./focus-stats');
const { runMigrations, rememberDismissed } = require('./migrate');

const PUBLIC_DIR = path.join(db.ROOT, 'public');

// ---------------------------------------------------------------- 启动参数

const argv = process.argv.slice(2);
function argValue(name, fallback) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  const pref = `${name}=`;
  const hit = argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}

const PORT = Number(argValue('--port', process.env.PORT || 5180));
const HOST = argValue('--host', '127.0.0.1');

// ---------------------------------------------------------------- HTTP 工具

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(text);
}

function fail(res, err) {
  const status = err && err.status ? err.status : 500;
  if (status >= 500) console.error('[错误]', err);
  const body = { error: (err && err.message) || '服务器内部错误' };
  if (err && err.code) body.code = String(err.code);
  sendJson(res, status, body);
}

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求内容过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(badRequest('请求内容不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/** 原始二进制上传（PDF）。超限后停止缓冲并尽快回 413，同时把剩余数据排掉。 */
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > limit) {
        settled = true;
        reject(Object.assign(new Error(`文件超过上限（${Math.round(limit / 1024 / 1024)}MB）`), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(PUBLIC_DIR, `.${rel}`);
  if (!target.startsWith(PUBLIC_DIR)) return sendText(res, 403, '禁止访问');

  let stat;
  try { stat = await fsp.stat(target); } catch { return sendText(res, 404, '没有这个文件'); }
  if (stat.isDirectory()) return sendText(res, 404, '没有这个文件');

  const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': stat.size });
  fs.createReadStream(target).pipe(res);
}

// ---------------------------------------------------------------- 汇总

/** 工作台需要的统计，一次算完，避免首屏发一堆请求 */
async function buildOverview() {
  const today = models.todayStr();
  const [tasks, plans, projects, archives, conversations, focusSessions, textbooks] = await Promise.all([
    db.listSorted('tasks'),
    db.listSorted('plans'),
    db.listSorted('projects'),
    db.listSorted('archives'),
    db.listSorted('conversations'),
    db.listSorted('focusSessions'),
    db.listSorted('textbooks'),
  ]);

  const open = tasks.filter((t) => t.status !== 'done');
  const todayTasks = tasks.filter((t) => t.status !== 'done' && models.isToday(t, today));
  const todayDone = tasks.filter((t) => t.status === 'done' && models.isToday(t, today));
  const overdue = tasks.filter((t) => models.isOverdue(t, today));
  const todayKey = localDayKey(new Date());
  const focusToday = focusSessions.filter(
    (s) => !s.undoneAt && s.mode === 'focus' && localDayKey(s.endedAt) === todayKey
  );
  const focusMinutesToday = focusToday.reduce((n, s) => n + Math.round((s.actualSeconds || 0) / 60), 0);

  const planStats = new Map();
  for (const t of tasks) {
    if (!t.planId) continue;
    const s = planStats.get(t.planId) || { total: 0, done: 0 };
    s.total += 1;
    if (t.status === 'done') s.done += 1;
    planStats.set(t.planId, s);
  }

  /** 按日期分组，供「按日期查看」使用；没有日期的任务单独归到一处，不会消失 */
  const byDate = new Map();
  for (const t of tasks) {
    const key = t.scheduledDate || t.dueDate || '未安排日期';
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key).push(t);
  }

  return {
    today,
    tasks,
    plans: plans.map((p) => ({ ...p, stats: planStats.get(p.id) || { total: 0, done: 0 } })),
    projects: projects.map(projectLib.publicProject),
    archives,
    byDate: [...byDate.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    conversations: conversations.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messageCount: (c.messages || []).length,
      lastMessage: (c.messages || []).slice(-1)[0]?.content?.slice(0, 80) || '',
      pendingProposals: (c.proposals || []).filter((p) => p.status === 'pending').length,
    })),
    stats: {
      total: tasks.length,
      open: open.length,
      today: todayTasks.length,
      todayDone: todayDone.length,
      done: tasks.length - open.length,
      overdue: overdue.length,
      plans: plans.filter((p) => p.status === 'active').length,
      projects: projects.length,
      archives: archives.length,
      conversations: conversations.length,
      focusToday: focusToday.length,
      focusMinutesToday,
      textbooks: textbooks.length,
    },
    dueToday: todayTasks,
    dueTodayDone: todayDone,
    overdueTasks: overdue,
    focusToday,
  };
}

// ---------------------------------------------------------------- 任务

/**
 * 把任务上的项目和课程关联统一校验一遍。
 * `undefined` 表示这次不改，null / 空字符串表示解除关联。
 */
async function resolveTaskLinks(input, current = {}) {
  let projectId = input.projectId !== undefined
    ? (input.projectId ? String(input.projectId).trim() : null)
    : (current.projectId || null);
  let courseId = input.courseId !== undefined
    ? (input.courseId ? String(input.courseId).trim() : null)
    : (current.courseId || null);

  // 只给了课程：从课程反推出它所属的项目，避免存出「无项目的课程」
  if (courseId && !projectId) {
    const found = projectLib.locateCourse(await db.list('projects'), courseId);
    if (!found) throw badRequest('找不到要关联的课程');
    projectId = found.project.id;
  }

  if (projectId) {
    const project = await db.getOrNull('projects', projectId);
    if (!project) throw badRequest('找不到要关联的学习项目');
    if (courseId && !projectLib.findCourse(project, courseId)) {
      throw badRequest('找不到要关联的课程');
    }
  } else {
    courseId = null;
  }

  return { projectId, courseId };
}

async function detachTasksFromCourse(courseId) {
  const tasks = await db.list('tasks');
  let removed = 0;
  for (const task of tasks) {
    if (task.courseId !== courseId) continue;
    task.courseId = null;
    await db.put('tasks', task);
    removed += 1;
  }
  return removed;
}

async function handleTasks(req, res, seg, query) {
  const method = req.method.toUpperCase();

  if (seg.length === 2) {
    if (method === 'GET') {
      const tasks = await db.listSorted('tasks');
      const filter = query.get('filter');
      const today = models.todayStr();
      let out = tasks;
      if (filter === 'open') out = tasks.filter((t) => t.status !== 'done');
      else if (filter === 'today') out = tasks.filter((t) => models.isToday(t, today));
      else if (filter === 'done') out = tasks.filter((t) => t.status === 'done');
      else if (filter === 'overdue') out = tasks.filter((t) => models.isOverdue(t, today));
      const planId = query.get('planId');
      if (planId) out = out.filter((t) => t.planId === planId);
      const projectId = query.get('projectId');
      if (projectId) out = out.filter((t) => t.projectId === projectId);
      const courseId = query.get('courseId');
      if (courseId) out = out.filter((t) => t.courseId === courseId);
      return sendJson(res, 200, { tasks: out });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body.title || !String(body.title).trim()) throw badRequest('给这个任务起个名字吧');
      if (body.planId) {
        const plan = await db.getOrNull('plans', body.planId);
        if (!plan) throw badRequest('找不到要关联的计划');
      }
      const links = await resolveTaskLinks(body);
      const task = models.newTask({ ...body, ...links, source: 'manual' });
      await db.put('tasks', task);
      return sendJson(res, 201, { task });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  const id = seg[2];
  if (seg.length === 3) {
    if (method === 'GET') return sendJson(res, 200, { task: await db.get('tasks', id) });
    if (method === 'PATCH') {
      const body = await readBody(req);
      const task = await db.get('tasks', id);
      if (body.planId) {
        const plan = await db.getOrNull('plans', body.planId);
        if (!plan) throw badRequest('找不到要关联的计划');
      }
      if (body.projectId !== undefined || body.courseId !== undefined) {
        Object.assign(body, await resolveTaskLinks(body, task));
      }
      models.patchTask(task, body);
      await db.put('tasks', task);
      return sendJson(res, 200, { task });
    }
    if (method === 'DELETE') {
      const result = await db.remove('tasks', id);
      if (!result.existed) throw Object.assign(new Error('这个任务已经不在了'), { status: 404 });
      return sendJson(res, 200, { ok: true });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  throw Object.assign(new Error('没有这个接口'), { status: 404 });
}

// ---------------------------------------------------------------- 计划

async function handlePlans(req, res, seg) {
  const method = req.method.toUpperCase();

  if (seg.length === 2) {
    if (method === 'GET') {
      const plans = await db.listSorted('plans');
      const tasks = await db.list('tasks');
      return sendJson(res, 200, {
        plans: plans.map((p) => {
          const mine = tasks.filter((t) => t.planId === p.id);
          return { ...p, stats: { total: mine.length, done: mine.filter((t) => t.status === 'done').length } };
        }),
      });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body.title || !String(body.title).trim()) throw badRequest('给这个计划起个名字吧');
      const plan = models.newPlan(body);
      await db.put('plans', plan);
      return sendJson(res, 201, { plan });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  const id = seg[2];
  const tasks = await db.list('tasks');

  if (seg.length === 3) {
    if (method === 'GET') {
      const plan = await db.get('plans', id);
      return sendJson(res, 200, {
        plan,
        tasks: tasks
          .filter((t) => t.planId === id)
          .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))),
      });
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const plan = await db.get('plans', id);
      models.patchPlan(plan, body);
      await db.put('plans', plan);
      return sendJson(res, 200, { plan });
    }
    if (method === 'DELETE') {
      const plan = await db.getOrNull('plans', id);
      if (!plan) throw Object.assign(new Error('这个计划已经不在了'), { status: 404 });
      // 只解除关联，绝不连带删除任务——那些任务可能还是用户要做的
      const affected = tasks.filter((t) => t.planId === id);
      for (const t of affected) {
        t.planId = null;
        await db.put('tasks', t);
      }
      await db.remove('plans', id);
      return sendJson(res, 200, { ok: true, detachedTasks: affected.length });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  if (seg.length === 4 && seg[3] === 'tasks' && method === 'GET') {
    return sendJson(res, 200, { tasks: tasks.filter((t) => t.planId === id) });
  }

  throw Object.assign(new Error('没有这个接口'), { status: 404 });
}

// ---------------------------------------------------------------- 学习项目

async function handleProjects(req, res, seg) {
  const method = req.method.toUpperCase();

  if (seg.length === 2) {
    if (method === 'GET') {
      const list = await db.listSorted('projects');
      return sendJson(res, 200, { projects: list.map(projectLib.publicProject) });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body.title || !String(body.title).trim()) throw badRequest('给这个学习项目起个名字');
      const project = projectLib.newProject(body);
      await db.put('projects', project);
      return sendJson(res, 201, { project: projectLib.publicProject(project) });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  const id = seg[2];

  if (seg.length === 3) {
    if (method === 'GET') {
      const project = await db.get('projects', id);
      return sendJson(res, 200, { project: projectLib.publicProject(project) });
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const project = await db.get('projects', id);
      projectLib.patchProject(project, body);
      await db.put('projects', project);
      return sendJson(res, 200, { project: projectLib.publicProject(project) });
    }
    if (method === 'DELETE') {
      const project = await db.getOrNull('projects', id);
      if (!project) throw Object.assign(new Error('这个学习项目已经不在了'), { status: 404 });
      const courseIds = new Set((project.courses || []).map((c) => c.id));
      const tasks = await db.list('tasks');
      let detachedTasks = 0;
      for (const task of tasks) {
        const touchProject = task.projectId === id;
        const touchCourse = task.courseId && courseIds.has(task.courseId);
        if (!touchProject && !touchCourse) continue;
        // 只清除关联，任务本身必须原样保留
        task.projectId = null;
        task.courseId = null;
        await db.put('tasks', task);
        detachedTasks += 1;
      }
      await db.remove('projects', id);
      return sendJson(res, 200, { ok: true, detachedTasks });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  if (seg[3] !== 'courses') throw Object.assign(new Error('没有这个接口'), { status: 404 });

  if (seg.length === 4) {
    const project = await db.get('projects', id);
    if (method === 'GET') {
      return sendJson(res, 200, {
        project: projectLib.publicProject(project),
        courses: (project.courses || []).map(projectLib.courseSummary),
      });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body.title || !String(body.title).trim()) throw badRequest('给这门课起个名字');
      const course = projectLib.addCourse(project, body);
      await db.put('projects', project);
      return sendJson(res, 201, {
        project: projectLib.publicProject(project),
        course: projectLib.courseSummary(course),
      });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  const courseId = seg[4];
  const project = await db.get('projects', id);

  if (seg.length === 5) {
    const course = projectLib.findCourse(project, courseId);
    if (!course) throw Object.assign(new Error('找不到这门课程'), { status: 404 });

    if (method === 'GET') {
      return sendJson(res, 200, {
        project: projectLib.publicProject(project),
        course: projectLib.courseSummary(course),
      });
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      projectLib.patchCourse(course, body);
      await db.put('projects', project);
      return sendJson(res, 200, {
        project: projectLib.publicProject(project),
        course: projectLib.courseSummary(course),
      });
    }
    if (method === 'DELETE') {
      projectLib.removeCourse(project, courseId);
      // 删除课程只解除任务上的课程关联，任务和它所属的项目都保留
      const detachedTasks = await detachTasksFromCourse(courseId);
      await db.put('projects', project);
      return sendJson(res, 200, {
        ok: true,
        detachedTasks,
        project: projectLib.publicProject(project),
      });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  if (seg.length === 6) {
    if (method !== 'POST') throw Object.assign(new Error('不支持的方法'), { status: 405 });
    const course = projectLib.findCourse(project, courseId);
    if (!course) throw Object.assign(new Error('找不到这门课程'), { status: 404 });

    const action = seg[5];
    if (action === 'continue') {
      const result = projectLib.openForStudy(course);
      await db.put('projects', project);
      return sendJson(res, 200, {
        project: projectLib.publicProject(project),
        course: projectLib.courseSummary(course),
        ...result,
      });
    }
    if (action === 'complete') {
      const result = projectLib.completeCurrent(course);
      await db.put('projects', project);
      return sendJson(res, 200, {
        project: projectLib.publicProject(project),
        course: projectLib.courseSummary(course),
        ...result,
      });
    }
  }

  throw Object.assign(new Error('没有这个接口'), { status: 404 });
}

// ---------------------------------------------------------------- 对话与方案

/** 预览接口的查询参数 → 选择对象；没有任何参数时沿用对话里保存的选择 */
function selectionFromQuery(query) {
  const keys = ['projectId', 'windowDays', 'includeTasks', 'includeKnowledge'];
  if (!query || !keys.some((key) => query.has(key))) return null;
  const flag = (value) => value === '1' || value === 'true';
  return {
    projectId: query.get('projectId') || null,
    windowDays: query.get('windowDays') || 0,
    includeTasks: flag(query.get('includeTasks')),
    includeKnowledge: flag(query.get('includeKnowledge')),
  };
}

async function handleConversations(req, res, seg, query) {
  const method = req.method.toUpperCase();

  if (seg.length === 2) {
    if (method === 'GET') {
      const list = await db.listSorted('conversations');
      return sendJson(res, 200, {
        conversations: list.map((c) => ({
          id: c.id,
          title: c.title,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          messageCount: (c.messages || []).length,
          pendingProposals: (c.proposals || []).filter((p) => p.status === 'pending').length,
        })),
      });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const conv = models.newConversation({ title: body.title });
      await db.put('conversations', conv);
      return sendJson(res, 201, { conversation: conv });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  const id = seg[2];

  if (seg.length === 3) {
    if (method === 'GET') return sendJson(res, 200, { conversation: await db.get('conversations', id) });
    if (method === 'PATCH') {
      const body = await readBody(req);
      const conv = await db.get('conversations', id);
      if (typeof body.title === 'string' && body.title.trim()) conv.title = body.title.trim().slice(0, 120);
      if (body.context !== undefined) {
        conv.context = {
          ...contextLib.normalizeSelection(body.context),
          updatedAt: db.nowIso(),
        };
      }
      await db.put('conversations', conv);
      return sendJson(res, 200, { conversation: conv });
    }
    if (method === 'DELETE') {
      const result = await db.remove('conversations', id);
      if (!result.existed) throw Object.assign(new Error('这个对话已经不在了'), { status: 404 });
      return sendJson(res, 200, { ok: true });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  // 只读预览：这次会让 AI 参考哪些真实记录
  if (seg.length === 4 && seg[3] === 'context' && method === 'GET') {
    const conv = await db.get('conversations', id);
    const override = selectionFromQuery(query);
    let built;
    if (override) {
      built = await contextLib.previewContext(override);
    } else {
      try {
        built = await contextLib.previewContext(conv.context);
      } catch {
        // 旧数据里如果存了失效的选择，降级为「不引用」，而不是让预览接口报错
        built = await contextLib.previewContext(null);
        built.warnings.push('保存的学习数据选择已失效，本次没有引用任何数据。');
      }
    }
    return sendJson(res, 200, { selection: built.selection, context: built });
  }

  // 发消息
  if (seg.length === 4 && seg[3] === 'messages' && method === 'POST') {
    const body = await readBody(req);
    const text = String(body.content || '').trim();
    if (!text) throw badRequest('说点什么吧，一句话就行');

    const conv = await db.get('conversations', id);
    conv.messages.push(models.newMessage({ role: 'user', content: text, provider: 'mock' }));

    // 首条用户消息用来给对话取标题
    if (conv.messages.filter((m) => m.role === 'user').length === 1) {
      conv.title = text.replace(/\s+/g, ' ').slice(0, 40) || '新的对话';
    }

    const settings = await db.getSettings();

    // 每轮都按保存的选择重新构建真实上下文；历史里只存最小快照
    let builtContext = null;
    let contextWarning = null;
    if (conv.context && contextLib.hasSelection(conv.context)) {
      try {
        builtContext = await contextLib.buildContext(conv.context);
      } catch {
        contextWarning = '保存的学习数据选择已失效，本轮没有引用任何数据。';
      }
    }

    const result = await ai.respond({ conversation: conv, userText: text, settings, context: builtContext });

    let proposalId = null;
    if (result.proposal) {
      const idx = conv.proposals.findIndex((p) => p.status === 'pending' && p.title === result.proposal.title);
      if (idx >= 0) {
        // 同一对话里同标题的待确认方案：更新它，而不是堆一堆重复的
        conv.proposals[idx] = { ...conv.proposals[idx], ...result.proposal, id: conv.proposals[idx].id };
        proposalId = conv.proposals[idx].id;
      } else {
        conv.proposals.push(result.proposal);
        proposalId = result.proposal.id;
      }
    }

    const assistantMsg = models.newMessage({
      role: 'assistant',
      content: result.reply,
      problemCard: result.problemCard,
      proposalId,
      provider: result.provider,
      meta: result.meta || null,
      context: builtContext ? contextLib.snapshotContext(builtContext) : null,
    });
    conv.messages.push(assistantMsg);

    for (const a of result.asked || []) {
      if (!conv.asked.includes(a)) conv.asked.push(a);
    }
    // 记住「正在等用户回答哪个问题、当时想做什么」，下一轮才不会丢掉上下文
    if (result.pendingIntent !== undefined) conv.pendingIntent = result.pendingIntent;

    await db.put('conversations', conv);
    return sendJson(res, 201, {
      conversation: conv,
      message: assistantMsg,
      warning: [result.warning, contextWarning].filter(Boolean).join(' ') || null,
    });
  }

  // 编辑某一轮的问题梳理卡（用户可以随时纠正 AI 的理解）
  if (seg.length === 5 && seg[3] === 'messages' && method === 'PATCH') {
    const body = await readBody(req);
    const conv = await db.get('conversations', id);
    const msg = conv.messages.find((m) => m.id === seg[4]);
    if (!msg) throw Object.assign(new Error('找不到这条消息'), { status: 404 });
    if (!msg.problemCard) throw badRequest('这条消息没有整理卡');

    const card = msg.problemCard;
    for (const field of ['expressed', 'unknowns', 'directions', 'nextSteps']) {
      if (Array.isArray(body[field])) card[field] = body[field].map((x) => String(x)).filter((x) => x.trim());
    }
    if (typeof body.summary === 'string') card.summary = body.summary;
    if (body.emotion === null) card.emotion = null;
    msg.editedByUser = true;
    await db.put('conversations', conv);
    return sendJson(res, 200, { conversation: conv });
  }

  // 编辑待确认方案里的建议行动
  if (seg.length === 5 && seg[3] === 'proposals' && method === 'PATCH') {
    const body = await readBody(req);
    const conv = await db.get('conversations', id);
    const prop = conv.proposals.find((p) => p.id === seg[4]);
    if (!prop) throw Object.assign(new Error('找不到这个方案'), { status: 404 });
    if (prop.status !== 'pending') throw badRequest('这个方案已经处理过了，不能再改');

    if (typeof body.title === 'string') prop.title = body.title.slice(0, 200);
    if (typeof body.summary === 'string') prop.summary = body.summary.slice(0, 2000);
    if (Array.isArray(body.pendingItems)) {
      prop.pendingItems = body.pendingItems.map((x) => String(x)).filter((x) => x.trim());
    }
    if (Array.isArray(body.actions)) {
      prop.actions = prop.actions.map((existing) => {
        const patch = body.actions.find((a) => a && a.id === existing.id);
        if (!patch) return existing;
        return {
          ...existing,
          title: typeof patch.title === 'string' ? patch.title.slice(0, 200) : existing.title,
          detail: typeof patch.detail === 'string' ? patch.detail.slice(0, 1000) : existing.detail,
          scheduledDate: patch.scheduledDate !== undefined ? models.dateOnly(patch.scheduledDate) : existing.scheduledDate,
          dueDate: patch.dueDate !== undefined ? models.dateOnly(patch.dueDate) : existing.dueDate,
          estimateMinutes: typeof patch.estimateMinutes === 'number'
            ? Math.max(1, Math.min(600, patch.estimateMinutes))
            : existing.estimateMinutes,
          doneStandard: typeof patch.doneStandard === 'string' ? patch.doneStandard.slice(0, 300) : existing.doneStandard,
        };
      });
    }
    await db.put('conversations', conv);
    return sendJson(res, 200, { conversation: conv });
  }

  // 确认方案 → 创建正式任务（PRD 3.2 / 8.4：可只选部分、防重复、取消不产生任务）
  if (seg.length === 6 && seg[3] === 'proposals' && seg[5] === 'confirm' && method === 'POST') {
    const body = await readBody(req);
    const conv = await db.get('conversations', id);
    const prop = conv.proposals.find((p) => p.id === seg[4]);
    if (!prop) throw Object.assign(new Error('找不到这个方案'), { status: 404 });

    const wanted = Array.isArray(body.actionIds) && body.actionIds.length
      ? prop.actions.filter((a) => body.actionIds.includes(a.id))
      : prop.actions;
    if (!wanted.length) throw badRequest('至少选一条要创建的行动');

    const planId = body.planId ? String(body.planId) : null;
    if (planId) {
      const plan = await db.getOrNull('plans', planId);
      if (!plan) throw badRequest('找不到要关联的计划');
    }

    const created = [];
    const skipped = [];
    for (const action of wanted) {
      // 第一层防重复：这一条行动已经创建过任务，而且任务还在
      if (action.createdTaskId) {
        const existing = await db.getOrNull('tasks', action.createdTaskId);
        if (existing) {
          skipped.push({ actionId: action.id, taskId: existing.id, reason: '这一条已经创建过了' });
          continue;
        }
      }
      // 第二层：同一方案里同标题的任务已经存在（防止重复点击造成的副本）
      const all = await db.list('tasks');
      const dup = all.find((t) => t.sourceProposalId === prop.id && t.title === action.title);
      if (dup) {
        action.createdTaskId = dup.id;
        skipped.push({ actionId: action.id, taskId: dup.id, reason: '同名任务已存在' });
        continue;
      }

      const task = models.newTask({
        title: action.title,
        description: [action.detail, action.doneStandard ? `完成标准：${action.doneStandard}` : '']
          .filter(Boolean).join('\n'),
        status: 'todo',
        priority: 'normal',
        planId: planId || action.planId || null,
        scheduledDate: action.scheduledDate,
        dueDate: action.dueDate,
        source: 'ai',
        sourceProposalId: prop.id,
      });
      await db.put('tasks', task);
      action.createdTaskId = task.id;
      created.push(task);
    }

    // 只有真的创建了任务才算「已确认」；全部被跳过时保持 pending，让用户看见原因
    if (created.length) {
      prop.status = 'confirmed';
      prop.confirmedAt = db.nowIso();
    }
    if (!Array.isArray(conv.confirmedActionIds)) conv.confirmedActionIds = [];
    for (const a of wanted) if (!conv.confirmedActionIds.includes(a.id)) conv.confirmedActionIds.push(a.id);

    await db.put('conversations', conv);
    return sendJson(res, 200, { conversation: conv, created, skipped });
  }

  // 放弃方案
  if (seg.length === 6 && seg[3] === 'proposals' && seg[5] === 'dismiss' && method === 'POST') {
    const conv = await db.get('conversations', id);
    const prop = conv.proposals.find((p) => p.id === seg[4]);
    if (!prop) throw Object.assign(new Error('找不到这个方案'), { status: 404 });
    prop.status = 'dismissed';
    prop.dismissedAt = db.nowIso();
    await db.put('conversations', conv);
    return sendJson(res, 200, { conversation: conv });
  }

  throw Object.assign(new Error('没有这个接口'), { status: 404 });
}

// ---------------------------------------------------------------- 档案

async function handleArchives(req, res, seg, query) {
  const method = req.method.toUpperCase();

  if (seg.length === 2) {
    if (method === 'GET') {
      let list = await db.listSorted('archives');
      const type = query.get('type');
      if (type && models.ARCHIVE_TYPE.includes(type)) list = list.filter((a) => a.type === type);
      const q = (query.get('q') || '').trim().toLowerCase();
      if (q) list = list.filter((a) => `${a.title} ${a.content}`.toLowerCase().includes(q));
      return sendJson(res, 200, { archives: list });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      if (!body.title || !String(body.title).trim()) throw badRequest('给这份档案起个名字吧');
      if (!body.content || !String(body.content).trim()) throw badRequest('档案内容是空的');
      const archive = models.newArchive({
        title: body.title,
        content: body.content,
        type: body.type,
        origin: 'manual',
        sourceConversationId: body.sourceConversationId,
      });
      await db.put('archives', archive);
      return sendJson(res, 201, { archive });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  const id = seg[2];
  if (seg.length === 3) {
    if (method === 'GET') return sendJson(res, 200, { archive: await db.get('archives', id) });
    if (method === 'PATCH') {
      const body = await readBody(req);
      const archive = await db.get('archives', id);
      models.patchArchive(archive, body);
      await db.put('archives', archive);
      return sendJson(res, 200, { archive });
    }
    if (method === 'DELETE') {
      const existing = await db.getOrNull('archives', id);
      if (!existing) throw Object.assign(new Error('这份档案已经不在了'), { status: 404 });
      await db.remove('archives', id);
      // 迁移过来的档案：记下「用户删过它」，否则下次启动会被自动补回来
      if (existing.legacyEntryId) await rememberDismissed(existing.legacyEntryId);
      // 删档案不动来源对话（PRD 5.7 / 8.5）
      return sendJson(res, 200, { ok: true });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  throw Object.assign(new Error('没有这个接口'), { status: 404 });
}

// ---------------------------------------------------------------- 专注（番茄钟）

const TEXTBOOK_IMPORT_BYTES = 64 * 1024 * 1024;
const TEXTBOOK_FILE_BYTES = 200 * 1024 * 1024;
const ARTICLE_IMPORT_BYTES = 4 * 1024 * 1024;

/**
 * 把一种写法归到另一项。只记标题的指向，不改原始专注记录：
 * 统计时统一换成目标标题，历史记录仍然保留当时写下的文字。
 */
async function mergeFocusContent(body = {}) {
  const rawFrom = String(body.from || '');
  const rawTo = String(body.to || '');
  if (!rawFrom.trim() || !rawTo.trim()) throw badRequest('先选要归到哪一项');
  if (rawFrom.length > 160 || rawTo.length > 160) throw badRequest('名称太长了');

  const from = focusContentKey(rawFrom);
  const aliases = await db.getFocusAliases();
  const target = resolveFocusAlias(rawTo, aliases);
  if (focusTitleKey(from) === focusTitleKey(target)) {
    throw badRequest('这两项已经是同一个名字了，不用再归类');
  }

  const now = db.nowIso();
  const next = { ...aliases };
  // 已经归到 from 的写法，一并改指向目标，避免多绕一层或成环
  for (const [key, entry] of Object.entries(aliases)) {
    if (!entry || !entry.to) continue;
    if (focusTitleKey(resolveFocusAlias(entry.to, aliases)) === focusTitleKey(from)) {
      next[key] = { ...entry, to: target, updatedAt: now };
    }
  }
  next[focusTitleKey(from)] = { from, to: target, updatedAt: now };

  if (focusTitleKey(resolveFocusAlias(target, next)) !== focusTitleKey(target)) {
    throw badRequest('这两项不能互相归类');
  }

  const saved = await db.saveFocusAliases(next);
  return { alias: { from, to: target }, aliases: focusAliasList(saved) };
}

async function unmergeFocusContent(body = {}) {
  const from = focusContentKey(body.from);
  const aliases = await db.getFocusAliases();
  const key = focusTitleKey(from);
  if (!aliases[key]) throw Object.assign(new Error('这一项还没有归类'), { status: 404 });

  const next = { ...aliases };
  const removed = next[key];
  delete next[key];
  const saved = await db.saveFocusAliases(next);
  return {
    removed: { from: focusContentKey(removed.from), to: resolveFocusAlias(removed.to, aliases) },
    aliases: focusAliasList(saved),
  };
}

/**
 * 进行中的这一轮由浏览器和桌面浮窗共用。
 * 两边可能在同一秒点按钮，所以所有读改写都排进同一条队列，
 * 避免「浮窗刚暂停、浏览器又按继续」时把结束时间写回旧值。
 */
let focusQueue = Promise.resolve();
function withFocusLock(fn) {
  const run = focusQueue.then(fn, fn);
  focusQueue = run.catch(() => {});
  return run;
}

/** 最近一次结束的结果，两个窗口刷新时看到的是同一份 */
let lastFocusResult = null;
/** 刚被放弃的那一轮；网页据此清掉本地表，而不是把计时又交回服务端 */
let lastCancelledToken = null;

function publicActive(active) {
  if (!active) return null;
  const remainingMs = models.focusRemainingMs(active);
  return {
    ...active,
    remainingMs,
    running: !active.pausedAt,
    paused: Boolean(active.pausedAt),
  };
}

/** 写一条已完成的专注，并处理「自动勾选待办」。接口与浮窗共用这一份逻辑。 */
async function recordFocusSession(body = {}) {
  const mode = models.FOCUS_MODE.includes(body.mode) ? body.mode : 'focus';

  // 同一次结束可能因为断网重试被提交多次：clientToken 保证只记一条
  if (body.clientToken) {
    const token = String(body.clientToken).slice(0, 80);
    const existing = (await db.list('focusSessions')).find((s) => s.clientToken === token);
    if (existing) {
      const task = existing.taskId ? await db.getOrNull('tasks', existing.taskId) : null;
      return { session: existing, task, duplicate: true };
    }
  }

  let task = null;
  if (mode === 'focus' && body.taskId) {
    task = await db.getOrNull('tasks', String(body.taskId));
    if (!task) throw badRequest('找不到要关联的任务，可能已经被删掉了');
  }

  let planId = body.planId ? String(body.planId) : (task && task.planId) || null;
  if (planId) {
    const plan = await db.getOrNull('plans', planId);
    if (!plan) planId = null;
  }

  // 只有「专注」结束才勾任务；而且本来就已经完成的，不改动它的完成时间
  const canComplete = mode === 'focus' && task && body.completeTask !== false && task.status !== 'done';
  const session = models.newFocusSession({
    ...body,
    mode,
    title: body.title || (task ? task.title : (mode === 'break' ? '休息' : '专注')),
    taskId: task ? task.id : null,
    planId,
    autoCompleted: Boolean(canComplete),
    taskCompleted: Boolean(canComplete),
    taskPreviousStatus: canComplete ? task.status : null,
  });
  await db.put('focusSessions', session);

  if (canComplete) {
    task.status = 'done';
    task.completedAt = db.nowIso();
    await db.put('tasks', task);
  }

  return { session, task };
}

/** 结束活动计时：提前结束按实际经过的时间记录，自然结束按计划时长记录。 */
async function finishActiveLocked(active, { natural = false } = {}) {
  const left = models.focusRemainingMs(active);
  const isNatural = Boolean(natural) && left <= 0;
  const plannedSeconds = Math.round(Number(active.minutes) * 60);
  const actualSeconds = isNatural
    ? plannedSeconds
    : Math.max(1, Math.min(plannedSeconds, Math.round((plannedSeconds * 1000 - left) / 1000)));
  const endedAt = isNatural && active.endAt
    ? new Date(Number(active.endAt)).toISOString()
    : db.nowIso();
  // 计时期间待办被删掉时，仍然保留这一轮专注记录，只是不再关联任务
  const task = active.taskId ? await db.getOrNull('tasks', active.taskId) : null;
  const payload = {
    clientToken: active.token,
    mode: active.mode,
    title: active.title,
    taskId: task ? task.id : null,
    planId: task ? (active.planId || task.planId) : active.planId,
    minutes: active.minutes,
    actualSeconds,
    startedAt: active.startedAt,
    endedAt,
    completeTask: active.mode === 'focus' && Boolean(active.completeTask),
  };

  const result = await recordFocusSession(payload);
  await db.clearActiveFocus();
  lastFocusResult = { ...result, ok: true, completedAt: db.nowIso(), payload, natural: isNatural };
  return lastFocusResult;
}

/** 读活动计时；如果已经到点但没人按结束，就在这里补记一次自然结束。 */
async function activeState() {
  return withFocusLock(async () => {
    const active = await db.getActiveFocus();
    if (!active) {
      return { active: null, lastResult: lastFocusResult, cancelledToken: lastCancelledToken };
    }
    if (!active.pausedAt && models.focusRemainingMs(active) <= 0) {
      const result = await finishActiveLocked(active, { natural: true });
      return { active: null, lastResult: result, justFinished: result };
    }
    return { active: publicActive(active), lastResult: lastFocusResult };
  });
}

async function startActiveFocus(body) {
  return withFocusLock(async () => {
    const existing = await db.getActiveFocus();
    if (existing) {
      if (!existing.pausedAt && models.focusRemainingMs(existing) <= 0) {
        await finishActiveLocked(existing, { natural: true });
      } else {
        throw Object.assign(new Error('已经有一轮专注在进行中了'), { status: 409, code: 'FOCUS_ACTIVE' });
      }
    }

    const mode = models.FOCUS_MODE.includes(body.mode) ? body.mode : 'focus';
    let task = null;
    if (mode === 'focus' && body.taskId) {
      task = await db.getOrNull('tasks', String(body.taskId));
      if (!task) throw badRequest('找不到要关联的任务，可能已经被删掉了');
      if (task.status === 'done') throw badRequest('这条待办已经完成了，换一条吧');
    }

    let planId = task ? (task.planId || null) : null;
    if (!planId && body.planId) planId = String(body.planId);
    if (planId) {
      const plan = await db.getOrNull('plans', planId);
      if (!plan) {
        if (body.planId) throw badRequest('找不到要关联的计划');
        planId = null;
      }
    }

    const active = models.newActiveFocus({
      token: body.clientToken,
      mode,
      title: body.title || (task ? task.title : undefined),
      taskId: task ? task.id : null,
      planId,
      minutes: body.minutes,
      completeTask: mode === 'focus' && Boolean(task) && body.completeTask !== false,
      remainingMs: body.remainingMs,
      startedAt: body.startedAt,
    });
    await db.saveActiveFocus(active);
    lastFocusResult = null;
    lastCancelledToken = null;
    return { active: publicActive(active), lastResult: null };
  });
}

async function patchActiveFocus(body) {
  return withFocusLock(async () => {
    const active = await db.getActiveFocus();
    if (!active) throw Object.assign(new Error('现在没有正在进行的专注'), { status: 404 });

    if (!active.pausedAt && models.focusRemainingMs(active) <= 0) {
      const result = await finishActiveLocked(active, { natural: true });
      return { active: null, lastResult: result, justFinished: result };
    }

    const action = String(body.action || '');
    if (action === 'pause') {
      if (!active.pausedAt) {
        active.pausedRemainingMs = models.focusRemainingMs(active);
        active.pausedAt = db.nowIso();
        await db.saveActiveFocus(active);
      }
    } else if (action === 'resume') {
      if (active.pausedAt) {
        const left = Math.max(1000, Number(active.pausedRemainingMs) || 0);
        active.endAt = Date.now() + left;
        active.pausedAt = null;
        active.pausedRemainingMs = null;
        await db.saveActiveFocus(active);
      }
    } else {
      throw badRequest('未知的计时操作');
    }
    return { active: publicActive(active), lastResult: lastFocusResult };
  });
}

async function cancelActiveFocus() {
  return withFocusLock(async () => {
    const active = await db.getActiveFocus();
    if (active) await db.clearActiveFocus();
    lastCancelledToken = active ? active.token : null;
    lastFocusResult = null;
    return { ok: true, active: null, already: !active, cancelledToken: lastCancelledToken };
  });
}

async function finishActiveFocus(body = {}) {
  return withFocusLock(async () => {
    const active = await db.getActiveFocus();
    if (!active) {
      // 结束请求因为网络问题重发时，按 token 找回已经记下的那一条
      const token = body.clientToken ? String(body.clientToken).slice(0, 80) : '';
      const existing = token
        ? (await db.list('focusSessions')).find((s) => s.clientToken === token)
        : null;
      if (existing) {
        const task = existing.taskId ? await db.getOrNull('tasks', existing.taskId) : null;
        lastFocusResult = {
          session: existing, task, duplicate: true, ok: true, completedAt: db.nowIso(), payload: null,
        };
        return { ...lastFocusResult, active: null };
      }
      throw Object.assign(new Error('现在没有正在进行的专注'), { status: 404 });
    }
    const result = await finishActiveLocked(active, { natural: body.natural === true });
    return { ...result, active: null };
  });
}

async function handleFocus(req, res, seg) {
  const method = req.method.toUpperCase();

  if (seg.length === 2) {
    if (method !== 'GET') throw Object.assign(new Error('不支持的方法'), { status: 405 });
    const [all, aliases, active] = await Promise.all([
      db.listSorted('focusSessions'),
      db.getFocusAliases(),
      db.getActiveFocus(),
    ]);
    const sessions = [...all]
      .sort((a, b) => String(b.endedAt || b.createdAt).localeCompare(String(a.endedAt || a.createdAt)))
      .slice(0, 200);
    return sendJson(res, 200, {
      sessions,
      stats: focusStats(all, aliases),
      contentAliases: focusAliasList(aliases),
      active: publicActive(active),
      lastResult: lastFocusResult,
    });
  }

  if (seg.length === 4 && seg[2] === 'content' && method === 'POST') {
    const body = await readBody(req);
    if (seg[3] === 'merge') return sendJson(res, 200, await mergeFocusContent(body));
    if (seg[3] === 'unmerge') return sendJson(res, 200, await unmergeFocusContent(body));
  }

  if (seg.length === 3 && seg[2] === 'sessions') {
    if (method !== 'POST') throw Object.assign(new Error('不支持的方法'), { status: 405 });
    const body = await readBody(req);
    const result = await withFocusLock(async () => {
      const out = await recordFocusSession(body);
      // 浏览器断网时先把这一轮结束掉，服务端可能还挂着同一个活动计时；补交时顺手清掉
      if (body.clientToken) {
        const active = await db.getActiveFocus();
        if (active && active.token === String(body.clientToken)) await db.clearActiveFocus();
      }
      return out;
    });
    return sendJson(res, result.duplicate ? 200 : 201, result);
  }

  if (seg.length === 3 && seg[2] === 'active') {
    if (method === 'GET') return sendJson(res, 200, await activeState());
    if (method === 'POST') return sendJson(res, 201, await startActiveFocus(await readBody(req)));
    if (method === 'PATCH') return sendJson(res, 200, await patchActiveFocus(await readBody(req)));
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  if (seg.length === 4 && seg[2] === 'active' && seg[3] === 'cancel' && method === 'POST') {
    return sendJson(res, 200, await cancelActiveFocus());
  }

  if (seg.length === 4 && seg[2] === 'active' && seg[3] === 'finish' && method === 'POST') {
    return sendJson(res, 200, await finishActiveFocus(await readBody(req)));
  }

  // 撤销一次自动勾选：按记录的原状态还原，重复调用是安全的
  if (seg.length === 5 && seg[2] === 'sessions' && seg[4] === 'undo' && method === 'POST') {
    const session = await db.get('focusSessions', seg[3]);
    let task = session.taskId ? await db.getOrNull('tasks', session.taskId) : null;

    if (session.undoneAt) {
      return sendJson(res, 200, { session, task, alreadyUndone: true });
    }

    if (session.autoCompleted && task && session.taskPreviousStatus && task.status === 'done') {
      task.status = session.taskPreviousStatus;
      if (session.taskPreviousStatus !== 'done') task.completedAt = null;
      await db.put('tasks', task);
    }
    session.taskCompleted = false;
    session.undoneAt = db.nowIso();
    await db.put('focusSessions', session);
    return sendJson(res, 200, { session, task });
  }

  throw Object.assign(new Error('没有这个接口'), { status: 404 });
}

// ---------------------------------------------------------------- 教材

async function streamPdf(req, res, book) {
  const file = db.textbookFilePath(book.id);
  let stat;
  try { stat = await fsp.stat(file); } catch {
    throw Object.assign(new Error('这本教材的原始 PDF 不在本地了'), { status: 404 });
  }
  if (!stat.isFile() || !stat.size) throw Object.assign(new Error('这本教材的原始 PDF 是空的'), { status: 404 });

  const safeName = String(book.fileName || `${book.title || '教材'}.pdf`).replace(/["\\\r\n]/g, '');
  const disposition = `inline; filename="textbook.pdf"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
  const range = req.headers.range;

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!m || (!m[1] && !m[2])) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    let start;
    let end;
    if (!m[1]) {
      const suffix = Math.min(Number(m[2]) || 0, stat.size);
      start = stat.size - suffix;
      end = stat.size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), stat.size - 1) : stat.size - 1;
    }
    if (!Number.isFinite(start) || start < 0 || start > end || start >= stat.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': 'application/pdf',
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${stat.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Disposition': disposition,
      'Cache-Control': 'private, max-age=0',
    });
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': disposition,
    'Cache-Control': 'private, max-age=0',
  });
  fs.createReadStream(file).pipe(res);
}

async function handleTextbooks(req, res, seg, query) {
  const method = req.method.toUpperCase();

  if (seg.length === 2) {
    if (method !== 'GET') throw Object.assign(new Error('不支持的方法'), { status: 405 });
    const books = await db.listSorted('textbooks');
    return sendJson(res, 200, { textbooks: books.map((b) => textbook.bookSummary(b)) });
  }

  // 导入：目录结构 + 逐页文字由浏览器提取后一次性提交
  if (seg.length === 3 && seg[2] === 'import') {
    if (method !== 'POST') throw Object.assign(new Error('不支持的方法'), { status: 405 });
    const body = await readBody(req, TEXTBOOK_IMPORT_BYTES);

    const pageCount = Math.round(Number(body.pageCount));
    if (!Number.isFinite(pageCount) || pageCount < 1) throw badRequest('没有读到 PDF 的页数，请重新选择文件');
    if (pageCount > textbook.MAX_PAGES) throw badRequest(`这本书有 ${pageCount} 页，超过 ${textbook.MAX_PAGES} 页的上限`);

    const fileSize = Math.max(0, Number(body.fileSize) || 0);
    if (fileSize > TEXTBOOK_FILE_BYTES) throw badRequest('PDF 超过 200MB，太大了');

    const fileName = String(body.fileName || '').replace(/[\r\n]/g, '').slice(0, 260);
    const title = String(body.title || '').trim().slice(0, 200)
      || fileName.replace(/\.pdf$/i, '')
      || '未命名教材';

    const pages = textbook.sanitizePages(body.pages, pageCount);
    const book = textbook.newBookRecord({
      title,
      fileName,
      fileSize,
      pageCount,
      outlineItems: body.outlineItems,
    });
    await db.put('textbooks', book);
    await db.writeTextbookPages(book.id, pages);
    return sendJson(res, 201, { book: textbook.publicBook(book), textPages: pages.filter((p) => p.text).length });
  }

  const id = seg[2];
  const book = await db.getOrNull('textbooks', id);
  if (!book) throw Object.assign(new Error('这本教材已经不在了'), { status: 404 });

  if (seg.length === 3) {
    if (method === 'GET') {
      await textbook.ensureChapterGuides(book);
      return sendJson(res, 200, { book: textbook.publicBook(book) });
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      if (typeof body.title === 'string' && body.title.trim()) {
        book.title = body.title.trim().slice(0, 200);
        await db.put('textbooks', book);
      }
      return sendJson(res, 200, { book: textbook.publicBook(book) });
    }
    if (method === 'DELETE') {
      await db.remove('textbooks', id);
      await db.removeTextbookAssets(id);
      return sendJson(res, 200, { ok: true });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  // 原始 PDF：支持 Range，浏览器内置阅读器可以直接翻页
  if (seg.length === 4 && seg[3] === 'file') {
    if (method === 'GET') return streamPdf(req, res, book);
    if (method === 'PUT') {
      if (!book.hasFile) {
        const lenHeader = Number(req.headers['content-length']);
        if (Number.isFinite(lenHeader) && lenHeader > TEXTBOOK_FILE_BYTES) {
          throw Object.assign(new Error('PDF 超过 200MB，太大了'), { status: 413 });
        }
        const buf = await readRawBody(req, TEXTBOOK_FILE_BYTES);
        if (buf.length < 5 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
          throw badRequest('这个文件看起来不是 PDF');
        }
        const target = db.textbookFilePath(id);
        const tmp = path.join(path.dirname(target), `.${id}.${process.pid}.${Date.now()}.tmp`);
        await fsp.writeFile(tmp, buf);
        await fsp.rename(tmp, target);
        book.hasFile = true;
        book.fileSize = buf.length;
        const name = query.get('name');
        if (name) book.fileName = String(name).replace(/[\r\n]/g, '').slice(0, 260);
        await db.put('textbooks', book);
        return sendJson(res, 200, { book: textbook.bookSummary(book), bytes: buf.length });
      }
      return sendJson(res, 200, { book: textbook.bookSummary(book), already: true });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  if (seg.length === 4 && seg[3] === 'analyze') {
    if (method !== 'POST') throw Object.assign(new Error('不支持的方法'), { status: 405 });
    const settings = await db.getSettings();
    const analyzed = await textbook.analyze(id, settings);
    return sendJson(res, 200, { book: textbook.publicBook(analyzed) });
  }

  if (seg.length === 5 && seg[3] === 'sections') {
    const sectionId = seg[4];
    const hit = textbook.findSection(book, sectionId);
    if (!hit) throw Object.assign(new Error('找不到这一节'), { status: 404 });

    if (method === 'GET') {
      await textbook.ensureChapterGuides(book);
      const payload = await textbook.sectionPayload(book, sectionId);
      const lesson = hit.section.lesson || null;
      const stale = Boolean(lesson) && (
        payload.textInfo.ocrJustApplied > 0
        || (!lesson.textSource && payload.textInfo.source !== 'pdf')
        || (lesson.textSource === 'none' && payload.textInfo.usable)
      );
      return sendJson(res, 200, {
        ...payload,
        lesson: stale ? null : lesson,
        lessonStale: stale,
        chat: book.chats[sectionId] || [],
        chapterTitle: hit.chapter.title,
        chapterGuide: (book.chapterGuides || {})[hit.chapter.id] || null,
      });
    }

    if (method === 'PATCH') {
      const body = await readBody(req);
      if (typeof body.done === 'boolean') {
        hit.section.done = body.done;
        hit.section.doneAt = body.done ? db.nowIso() : null;
      }
      book.progress = book.progress || {};
      book.progress.lastSectionId = sectionId;
      book.progress.lastReadAt = db.nowIso();
      textbook.refreshProgress(book);
      await db.put('textbooks', book);
      return sendJson(res, 200, {
        book: textbook.bookSummary(book),
        section: hit.section,
      });
    }

    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  // 生成（或重新生成）一节讲义
  if (seg.length === 6 && seg[3] === 'sections' && seg[5] === 'explain' && method === 'POST') {
    const body = await readBody(req);
    const sectionId = seg[4];
    const hit = textbook.findSection(book, sectionId);
    if (!hit) throw Object.assign(new Error('找不到这一节'), { status: 404 });

    const payload = await textbook.sectionPayload(book, sectionId);
    const cachedLesson = hit.section.lesson;
    const stale = Boolean(cachedLesson) && (
      payload.textInfo.ocrJustApplied > 0
      || (!cachedLesson.textSource && payload.textInfo.source !== 'pdf')
      || (cachedLesson.textSource === 'none' && payload.textInfo.usable)
    );

    if (cachedLesson && !body.refresh && !stale) {
      return sendJson(res, 200, {
        lesson: cachedLesson,
        textInfo: payload.textInfo,
        terms: payload.terms,
        chat: book.chats[sectionId] || [],
        cached: true,
      });
    }

    const settings = await db.getSettings();
    const lesson = await textbook.generateLesson({
      settings,
      book,
      chapter: hit.chapter,
      section: hit.section,
      text: payload.text,
      textInfo: payload.textInfo,
      previous: textbook.previousSection(book, sectionId),
      next: textbook.nextSection(book, sectionId),
    });
    lesson.textSource = payload.textInfo.source;

    hit.section.lesson = lesson;
    book.progress = book.progress || {};
    book.progress.lastSectionId = sectionId;
    book.progress.lastReadAt = db.nowIso();
    await db.put('textbooks', book);

    return sendJson(res, 200, {
      lesson,
      textInfo: payload.textInfo,
      terms: payload.terms,
      regeneratedAfterOcr: stale,
      chat: book.chats[sectionId] || [],
      section: hit.section,
    });
  }

  // 教材内问答：历史只存在服务端，模型只看这一节相关的原文
  if (seg.length === 6 && seg[3] === 'sections' && seg[5] === 'chat' && method === 'POST') {
    const body = await readBody(req);
    const question = String(body.question || '').trim();
    if (!question) throw badRequest('写下你的问题吧');
    if (question.length > 3000) throw badRequest('问题太长了，精简到 3000 字以内');

    const sectionId = seg[4];
    const hit = textbook.findSection(book, sectionId);
    if (!hit) throw Object.assign(new Error('找不到这一节'), { status: 404 });

    const settings = await db.getSettings();
    const payload = await textbook.sectionPayload(book, sectionId);
    const existing = Array.isArray(book.chats[sectionId]) ? book.chats[sectionId] : [];
    const history = existing.slice(-(textbook.MAX_CHAT_MESSAGES - 2));

    let out;
    if (settings.aiProvider === 'mock') {
      out = {
        content: textbook.localChatAnswer({
          question,
          section: hit.section,
          lesson: hit.section.lesson,
          text: payload.text,
          textInfo: payload.textInfo,
        }),
        provider: 'local',
        model: null,
        warning: null,
      };
    } else {
      try {
        out = await textbook.answerWithModel({
          settings,
          book,
          chapter: hit.chapter,
          section: hit.section,
          lesson: hit.section.lesson,
          text: payload.text,
          question,
          history,
          textInfo: payload.textInfo,
        });
      } catch (err) {
        out = {
          content: textbook.localChatAnswer({
            question,
            section: hit.section,
            lesson: hit.section.lesson,
            text: payload.text,
            textInfo: payload.textInfo,
          }),
          provider: 'local',
          model: null,
          warning: `模型这次没有回答，已改用本地原文检索。原因：${err.message}`,
        };
      }
    }

    const now = db.nowIso();
    const userMsg = {
      id: db.newId('tmsg'),
      role: 'user',
      content: question,
      provider: 'user',
      model: null,
      warning: null,
      createdAt: now,
    };
    const assistantMsg = {
      id: db.newId('tmsg'),
      role: 'assistant',
      content: out.content,
      provider: out.provider,
      model: out.model || null,
      warning: out.warning || null,
      createdAt: db.nowIso(),
    };
    const chat = [...existing, userMsg, assistantMsg].slice(-textbook.MAX_CHAT_MESSAGES);
    book.chats = book.chats || {};
    book.chats[sectionId] = chat;
    book.progress = book.progress || {};
    book.progress.lastSectionId = sectionId;
    book.progress.lastReadAt = db.nowIso();
    await db.put('textbooks', book);

    return sendJson(res, 201, { answer: assistantMsg, chat, textInfo: payload.textInfo });
  }

  // 把某个问题整理成流程图：模型可用时出结构化步骤，不可用时按本地讲义退化为顺序链
  if (seg.length === 6 && seg[3] === 'sections' && seg[5] === 'diagram' && method === 'POST') {
    const body = await readBody(req);
    const question = String(body.question || '').trim().slice(0, 3000);
    const sectionId = seg[4];
    const hit = textbook.findSection(book, sectionId);
    if (!hit) throw Object.assign(new Error('找不到这一节'), { status: 404 });

    const settings = await db.getSettings();
    const payload = await textbook.sectionPayload(book, sectionId);
    const diagram = await textbook.generateDiagram({
      settings,
      book,
      chapter: hit.chapter,
      section: hit.section,
      lesson: hit.section.lesson,
      text: payload.text,
      question,
    });
    return sendJson(res, 200, { diagram });
  }

  throw Object.assign(new Error('没有这个接口'), { status: 404 });
}

// ---------------------------------------------------------------- 导出

function toMarkdown({ tasks, plans, projects = [], archives, conversations }) {
  const L = [];
  const when = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN') : '—');
  const projectNames = new Map(projects.map((p) => [p.id, p.title]));
  const courseNames = new Map();
  for (const p of projects) {
    for (const c of p.courses || []) courseNames.set(c.id, c.title);
  }
  L.push('# 缓一缓 · 我的工作台数据');
  L.push('');
  L.push(`导出时间：${new Date().toLocaleString('zh-CN')}`);
  L.push('');

  L.push('## 学习计划');
  L.push('');
  if (!plans.length) L.push('（暂无）');
  for (const p of plans) {
    L.push(`### ${p.title}`);
    L.push('');
    L.push(`- 状态：${models.PLAN_STATUS_LABEL[p.status] || p.status}`);
    if (p.startDate || p.endDate) L.push(`- 时间：${p.startDate || '—'} → ${p.endDate || '—'}`);
    if (p.description) L.push(`- 说明：${p.description}`);
    const mine = tasks.filter((t) => t.planId === p.id);
    if (mine.length) {
      L.push('');
      for (const t of mine) L.push(`  - [${t.status === 'done' ? 'x' : ' '}] ${t.title}`);
    }
    L.push('');
  }

  L.push('## 学习项目');
  L.push('');
  if (!projects.length) L.push('（暂无）');
  for (const raw of projects) {
    const p = projectLib.publicProject(raw);
    L.push(`### ${p.title}`);
    L.push('');
    if (p.description) L.push(`- 说明：${p.description}`);
    L.push(`- 项目进度：${
      p.progress.percent === null
        ? '暂不可计算（还没有课程填写总集数）'
        : `${p.progress.percent}%（已完成 ${p.progress.completedEpisodes} / 共 ${p.progress.totalEpisodes} 集）`
    }`);
    if (p.progress.coursesWithoutTotal) {
      L.push(`- 另有 ${p.progress.coursesWithoutTotal} 门课程未填写总集数，不参与进度计算`);
    }
    L.push('');
    for (const c of p.courses) {
      const platform = projectLib.COURSE_PLATFORM_LABEL[c.platform] || c.platform;
      const progress = c.totalEpisodes > 0
        ? `${c.completedEpisodes}/${c.totalEpisodes} 集（${c.percent}%）`
        : `已完成 ${c.completedEpisodes} 集 · 总集数未填`;
      L.push(`#### ${c.title}`);
      L.push('');
      L.push(`- 平台：${platform} · ${progress}`);
      if (c.lastEpisode > 0) L.push(`- 最近学习：第 ${c.lastEpisode} 集`);
      if (c.lastStudiedAt) L.push(`- 最近打开：${when(c.lastStudiedAt)}`);
      if (c.source) L.push(`- 备注：${c.source}`);
      if (c.url) L.push(`- 链接：${c.url}`);
      L.push('');
    }
  }

  L.push('## 任务');
  L.push('');
  if (!tasks.length) L.push('（暂无）');
  for (const t of tasks) {
    const meta = [
      models.TASK_STATUS_LABEL[t.status],
      models.TASK_PRIORITY_LABEL[t.priority],
      t.scheduledDate ? `安排 ${t.scheduledDate}` : '',
      t.dueDate ? `截止 ${t.dueDate}` : '',
      t.projectId && projectNames.has(t.projectId) ? `项目：${projectNames.get(t.projectId)}` : '',
      t.courseId && courseNames.has(t.courseId) ? `课程：${courseNames.get(t.courseId)}` : '',
      t.source === 'ai' ? '来自 AI 建议' : '手动创建',
    ].filter(Boolean).join(' · ');
    L.push(`- [${t.status === 'done' ? 'x' : ' '}] ${t.title}`);
    L.push(`  - ${meta}`);
    if (t.description) L.push(`  - ${t.description.replace(/\n/g, ' ')}`);
  }
  L.push('');

  L.push('## 我的档案');
  L.push('');
  if (!archives.length) L.push('（暂无）');
  for (const a of archives) {
    L.push(`### ${a.title}`);
    L.push('');
    const origin = a.origin === 'legacy' ? '从第一版记录迁移'
      : a.origin === 'ai' ? '来自 AI 对话' : '我手动保存';
    L.push(`- 类型：${models.ARCHIVE_TYPE_LABEL[a.type] || a.type} · ${origin} · 保存于 ${when(a.createdAt)}`);
    L.push('');
    L.push(a.content);
    L.push('');
  }

  L.push('## 对话');
  L.push('');
  if (!conversations.length) L.push('（暂无）');
  for (const c of conversations) {
    L.push(`### ${c.title}`);
    L.push('');
    L.push(`- 开始于 ${when(c.createdAt)}`);
    L.push('');
    for (const m of c.messages || []) {
      L.push(`**${m.role === 'user' ? '我' : 'AI'}**（${m.provider === 'mock' ? '本地模拟引擎' : '真实模型'}）`);
      L.push('');
      L.push(m.content);
      L.push('');
    }
    for (const p of c.proposals || []) {
      L.push(`**行动方案：${p.title}**（${
        p.status === 'confirmed' ? '已确认' : p.status === 'dismissed' ? '已放弃' : '待确认'
      }）`);
      L.push('');
      for (const a of p.actions) {
        L.push(`- [${a.createdTaskId ? 'x' : ' '}] ${a.title}${a.doneStandard ? `（完成标准：${a.doneStandard}）` : ''}`);
      }
      L.push('');
    }
  }

  return L.join('\n');
}

// ---------------------------------------------------------------- AI 状态

/**
 * 引擎状态的唯一来源。
 * 探测 Ollama 可能要花几百毫秒，所以加一个很短的缓存，
 * 避免每次打开页面都去敲 11434 端口。
 */
let aiStatusCache = { at: 0, value: null };
const AI_STATUS_TTL_MS = 8000;

async function buildAiStatus({ force = false } = {}) {
  const now = Date.now();
  if (!force && aiStatusCache.value && now - aiStatusCache.at < AI_STATUS_TTL_MS) {
    return aiStatusCache.value;
  }
  const settings = await db.getSettings();
  const ollama = await ai.listOllamaModels(settings.ollamaUrl);
  const selectedName = settings.ollamaModel || (ollama.models[0] && ollama.models[0].name) || null;
  const selectedInfo = ollama.models.find((m) => m.name === selectedName) || null;
  // 参数量 < 3B 的模型基本写不出合格的对话措辞，界面要如实提示，不能让用户以为坏了
  const sizeNum = selectedInfo
    ? parseFloat(String(selectedInfo.parameterSize || '').replace(/[^\d.]/g, ''))
    : NaN;
  const value = {
    provider: settings.aiProvider,
    /** 当前实际会用到的模型标识 */
    model: settings.aiProvider === 'ollama'
      ? selectedName
      : settings.aiProvider === 'real'
        ? settings.model
        : null,
    ollama: {
      url: settings.ollamaUrl,
      online: ollama.online,
      models: ollama.models,
      error: ollama.error,
      selected: selectedName,
      parameterSize: selectedInfo ? selectedInfo.parameterSize : null,
      /** 是否是偏小的模型（< 3B）：界面据此给出「可能经常回退」的提示 */
      smallModel: Number.isFinite(sizeNum) ? sizeNum < 3 : false,
    },
  };
  aiStatusCache = { at: now, value };
  return value;
}

// ---------------------------------------------------------------- 桌面浮窗

/**
 * 打开真正的桌面浮窗。
 * Electron 只是一个可选的桌面外壳：没装的时候网页端照常使用，
 * 这里会如实告诉用户需要先安装，而不是假装窗口已经弹出来了。
 */
function launchFloatWindow() {
  let electronPath = null;
  try {
    // 只检查已下载的可执行文件，绝不在请求里触发 Electron 的二次下载（那会把服务卡住）
    electronPath = require('../desktop/resolve-electron').resolveElectron();
  } catch { /* 没装就是没装 */ }
  if (!electronPath) {
    throw Object.assign(
      new Error('桌面浮窗需要 Electron。先在这个目录运行：npm install --save-dev electron'),
      { status: 501, code: 'ELECTRON_NOT_INSTALLED' }
    );
  }

  const main = path.join(db.ROOT, 'desktop', 'float-main.js');
  const url = `http://${HOST}:${activePort}`;
  const startElectron = (extra) => {
    const child = spawn(electronPath, [...extra, main, `--url=${url}`], {
      cwd: db.ROOT,
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => console.error('[浮窗] 启动失败：', err.message));
    child.unref();
    return child;
  };

  const child = startElectron([]);
  // 少数受限环境里 Chromium 沙箱不可用，Electron 会静默退出：
  // Git Bash 里看到的是 3，Node 直接拿到的是 Windows 的 0x80000003（STATUS_BREAKPOINT）
  child.on('exit', (code) => {
    if (code !== 3 && code !== 2147483651) return;
    console.warn('[浮窗] 当前环境不允许 Chromium 沙箱，改用 --no-sandbox 重试。');
    startElectron(['--no-sandbox']);
  });
  return { ok: true, url };
}

// ---------------------------------------------------------------- 外刊阅读

async function loadArticle(id) {
  const article = await db.get('articles', id);
  const paragraphs = await db.readArticleContent(id);
  return { article, paragraphs };
}

function aiFailure(err) {
  if (err && err.status) return err;
  return Object.assign(new Error((err && err.message) || 'AI 调用失败'), { status: 502 });
}

async function handleArticles(req, res, seg, query) {
  const method = req.method.toUpperCase();

  if (seg.length === 2) {
    if (method === 'GET') {
      const list = await db.listSorted('articles');
      return sendJson(res, 200, { articles: list.map(articles.articleSummary) });
    }
    if (method === 'POST') {
      const body = await readBody(req, ARTICLE_IMPORT_BYTES);
      const format = ['md', 'markdown', 'pdf'].includes(body.format) ? body.format : 'plain';
      const paragraphs = articles.parseArticleText(body.text, format);
      const firstHeading = paragraphs.find((p) => p.kind === 'heading' && p.text);
      const fileName = String(body.fileName || '').replace(/[\r\n]/g, '').slice(0, 260);
      const title = String(body.title || '').trim().slice(0, 200)
        || (firstHeading && firstHeading.text)
        || fileName.replace(/\.[^.]+$/, '')
        || '未命名外刊';
      const article = articles.newArticleRecord({
        title,
        source: body.source,
        author: body.author,
        issue: body.issue,
        url: body.url,
        format,
        fileName,
        paragraphs,
      });
      if (body.tags !== undefined) articles.patchArticle(article, { tags: body.tags });
      await db.put('articles', article);
      await db.writeArticleContent(article.id, paragraphs);
      return sendJson(res, 201, { article: articles.articleDetail(article) });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  const id = seg[2];
  const { article, paragraphs } = await loadArticle(id);

  if (seg.length === 3) {
    if (method === 'GET') {
      return sendJson(res, 200, { article: articles.articleDetail(article), paragraphs });
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      articles.patchArticle(article, body);
      await db.put('articles', article);
      return sendJson(res, 200, { article: articles.articleDetail(article) });
    }
    if (method === 'DELETE') {
      await db.remove('articles', id);
      await db.removeArticleAssets(id);
      return sendJson(res, 200, { ok: true });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  if (seg.length === 4 && seg[3] === 'content') {
    if (method !== 'PUT') throw Object.assign(new Error('不支持的方法'), { status: 405 });
    const body = await readBody(req, ARTICLE_IMPORT_BYTES);
    const next = articles.parseArticleText(body.text, body.format || article.format);
    articles.refreshArticleStats(article, next);
    // 正文变了，旧的字符偏移就不再可靠：高亮和阅读位置一起清空
    article.highlights = [];
    article.progress = {
      anchorParagraphId: null,
      anchorRatio: 0,
      percent: 0,
      lastReadAt: null,
    };
    article.finishedAt = null;
    articles.clearQuiz(article);
    await db.writeArticleContent(id, next);
    await db.put('articles', article);
    return sendJson(res, 200, { article: articles.articleDetail(article), paragraphs: next });
  }

  if (seg.length === 4 && seg[3] === 'progress') {
    if (method !== 'PATCH') throw Object.assign(new Error('不支持的方法'), { status: 405 });
    const body = await readBody(req);
    const progress = articles.applyProgress(article, paragraphs, body);
    await db.put('articles', article);
    return sendJson(res, 200, { progress });
  }

  if (seg.length === 4 && seg[3] === 'finish') {
    if (method === 'POST') {
      const finishedAt = articles.markFinished(article, true);
      await db.put('articles', article);
      return sendJson(res, 200, { finishedAt });
    }
    if (method === 'DELETE') {
      const finishedAt = articles.markFinished(article, false);
      await db.put('articles', article);
      return sendJson(res, 200, { finishedAt });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  if (seg.length === 4 && seg[3] === 'quiz') {
    if (method === 'PATCH') {
      const body = await readBody(req);
      if (typeof body.questionId === 'string' && body.questionId) {
        articles.setQuizAnswer(article, body.questionId, body.selected);
      } else {
        article.quiz = articles.buildQuiz(body);
      }
      await db.put('articles', article);
      return sendJson(res, 200, { quiz: articles.quizView(article.quiz) });
    }
    if (method === 'DELETE') {
      articles.clearQuiz(article);
      await db.put('articles', article);
      return sendJson(res, 200, { quiz: null });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  if (seg.length === 4 && seg[3] === 'highlights') {
    if (method !== 'POST') throw Object.assign(new Error('不支持的方法'), { status: 405 });
    const body = await readBody(req);
    const highlight = articles.buildHighlight(article, paragraphs, body);
    article.highlights.push(highlight);
    await db.put('articles', article);
    return sendJson(res, 201, { highlight });
  }

  if (seg.length === 5 && seg[3] === 'highlights') {
    const highlight = articles.findHighlight(article, seg[4]);
    if (!highlight) throw Object.assign(new Error('这条高亮已经不在了'), { status: 404 });
    if (method === 'PATCH') {
      const body = await readBody(req);
      articles.buildHighlight(article, paragraphs, body, highlight);
      await db.put('articles', article);
      return sendJson(res, 200, { highlight });
    }
    if (method === 'DELETE') {
      article.highlights = article.highlights.filter((h) => h.id !== highlight.id);
      await db.put('articles', article);
      return sendJson(res, 200, { ok: true });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  if (seg.length === 4 && seg[3] === 'lookup') {
    if (method !== 'POST') throw Object.assign(new Error('不支持的方法'), { status: 405 });
    const body = await readBody(req);
    const selection = articles.normalizeSelection(paragraphs, body.selection || body);
    const settings = await db.getSettings();
    const contextText = articles.buildLookupContext(article, paragraphs, selection);
    try {
      const result = await articleAI.lookup({ settings, article, selection, contextText });
      return sendJson(res, 200, result);
    } catch (err) {
      throw aiFailure(err);
    }
  }

  if (seg.length === 4 && seg[3] === 'chat') {
    const chat = await db.readArticleChat(id);
    if (method === 'GET') {
      return sendJson(res, 200, { messages: chat.messages });
    }
    if (method === 'DELETE') {
      await db.writeArticleChat(id, { messages: [] });
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const question = String(body.content || '').trim().slice(0, articles.MAX_CHAT_CHARS);
      if (!question) throw badRequest('说点什么吧，一句话就行');

      let selection = null;
      if (body.selection && body.selection.paragraphId) {
        const normalized = articles.normalizeSelection(paragraphs, body.selection);
        selection = {
          paragraphId: normalized.paragraphId,
          start: normalized.start,
          end: normalized.end,
          text: normalized.text,
          mode: normalized.mode,
        };
      }
      const anchorId = selection
        ? selection.paragraphId
        : (article.progress && article.progress.anchorParagraphId) || '';
      const contextText = articles.buildChatContext(article, paragraphs, {
        paragraphId: anchorId,
        selectionText: selection ? selection.text : '',
      });
      const settings = await db.getSettings();
      let result;
      try {
        result = await articleAI.chat({
          settings,
          article,
          contextText,
          question,
          history: chat.messages.slice(-8),
        });
      } catch (err) {
        throw aiFailure(err);
      }

      articles.appendChatMessage(chat, articles.newChatMessage({
        role: 'user',
        content: question,
        selection,
        provider: settings.aiProvider,
      }));
      const reply = articles.newChatMessage({
        role: 'assistant',
        content: result.content,
        provider: result.provider,
        model: result.model,
      });
      articles.appendChatMessage(chat, reply);
      await db.writeArticleChat(id, chat);
      return sendJson(res, 200, { messages: chat.messages, reply });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  throw Object.assign(new Error('没有这个接口'), { status: 404 });
}

async function handleVocabulary(req, res, seg) {
  const method = req.method.toUpperCase();

  if (seg.length === 2) {
    if (method === 'GET') {
      const list = await db.listSorted('vocabulary');
      list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      return sendJson(res, 200, { vocabulary: list });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const article = body.articleId ? await db.getOrNull('articles', body.articleId) : null;
      if (body.articleId && !article) throw badRequest('找不到这篇文章');
      const entry = { ...(body.entry || {}) };
      if (!entry.term && body.term) entry.term = body.term;
      const incoming = articles.newVocabularyRecord({
        article: article || { id: '', title: '' },
        contextText: body.contextText || body.selectionText || '',
        selectionText: body.selectionText || body.term || '',
        kind: body.kind || entry.kind,
        entry,
      });
      const existing = (await db.list('vocabulary'))
        .find((item) => item.normalized === incoming.normalized);
      if (existing) {
        articles.mergeVocabulary(existing, incoming);
        await db.put('vocabulary', existing);
        return sendJson(res, 200, { entry: existing, merged: true });
      }
      await db.put('vocabulary', incoming);
      return sendJson(res, 201, { entry: incoming });
    }
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  const id = seg[2];
  const entry = await db.get('vocabulary', id);

  if (seg.length === 3) {
    if (method === 'PATCH') {
      const body = await readBody(req);
      if (typeof body.note === 'string') entry.note = body.note.trim().slice(0, 1000);
      await db.put('vocabulary', entry);
      return sendJson(res, 200, { entry });
    }
    if (method === 'DELETE') {
      const result = await db.remove('vocabulary', id);
      if (!result.existed) throw Object.assign(new Error('这个词已经不在了'), { status: 404 });
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'GET') return sendJson(res, 200, { entry });
    throw Object.assign(new Error('不支持的方法'), { status: 405 });
  }

  throw Object.assign(new Error('没有这个接口'), { status: 404 });
}

// ---------------------------------------------------------------- 路由

async function handleApi(req, res, pathname, query) {
  const method = req.method.toUpperCase();
  const seg = pathname.split('/').filter(Boolean); // ['api', ...]

  if (seg[1] === 'bootstrap' && method === 'GET') {
    const [overview, settings, aiStatus] = await Promise.all([
      buildOverview(), db.getPublicSettings(), buildAiStatus(),
    ]);
    return sendJson(res, 200, { ...overview, settings, ai: aiStatus });
  }

  if (seg[1] === 'ai' && seg[2] === 'status' && method === 'GET') {
    return sendJson(res, 200, await buildAiStatus({ force: query.get('refresh') === '1' }));
  }

  if (seg[1] === 'tasks') return handleTasks(req, res, seg, query);
  if (seg[1] === 'plans') return handlePlans(req, res, seg);
  if (seg[1] === 'projects') return handleProjects(req, res, seg);
  if (seg[1] === 'conversations') return handleConversations(req, res, seg, query);
  if (seg[1] === 'archives') return handleArchives(req, res, seg, query);
  if (seg[1] === 'focus') return handleFocus(req, res, seg);
  if (seg[1] === 'float' && seg[2] === 'launch' && method === 'POST') {
    return sendJson(res, 202, launchFloatWindow());
  }
  if (seg[1] === 'textbooks') return handleTextbooks(req, res, seg, query);
  if (seg[1] === 'articles') return handleArticles(req, res, seg, query);
  if (seg[1] === 'vocabulary') return handleVocabulary(req, res, seg);

  if (seg[1] === 'settings') {
    if (method === 'GET') return sendJson(res, 200, await db.getPublicSettings());
    if (method === 'PATCH') {
      const body = await readBody(req);
      const next = await db.saveSettings(body || {});
      // 设置一变，引擎状态缓存立刻作废，否则页面还会显示上一套配置
      aiStatusCache = { at: 0, value: null };
      return sendJson(res, 200, next);
    }
  }

  if (seg[1] === 'stats' && method === 'GET') {
    const o = await buildOverview();
    return sendJson(res, 200, o.stats);
  }

  if (seg[1] === 'export' && method === 'GET') {
    const [tasks, plans, projects, archives, conversations] = await Promise.all([
      db.listSorted('tasks'), db.listSorted('plans'), db.listSorted('projects'),
      db.listSorted('archives'), db.listSorted('conversations'),
    ]);
    const stamp = new Date().toISOString().slice(0, 10);
    const format = query.get('format') || 'json';

    if (format === 'markdown' || format === 'md') {
      const md = toMarkdown({ tasks, plans, projects, archives, conversations });
      return sendText(res, 200, md, 'text/markdown; charset=utf-8', {
        'Content-Disposition': `attachment; filename="huan-yi-huan-${stamp}.md"`,
      });
    }

    // JSON 导出绝不包含 API Key
    const payload = {
      exportedAt: db.nowIso(),
      app: '缓一缓',
      version: 3,
      plans, tasks, projects, conversations, archives,
    };
    return sendText(res, 200, JSON.stringify(payload, null, 2), 'application/json; charset=utf-8', {
      'Content-Disposition': `attachment; filename="huan-yi-huan-${stamp}.json"`,
    });
  }

  throw Object.assign(new Error('没有这个接口'), { status: 404 });
}

// ---------------------------------------------------------------- 启动

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname, url.searchParams);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, '不支持的方法');
    await serveStatic(req, res, pathname);
  } catch (err) {
    if (!res.headersSent) fail(res, err);
    else res.end();
  }
});

/**
 * 端口策略：
 *   · 用户/测试明确指定了 --port 或 PORT 环境变量 → 就听那个端口，被占用就如实报错
 *   · 没指定（例如双击 start.bat）→ 5180 被占就自动顺延到 5181、5182…，最多试 10 个
 *
 * 这样双击启动永远不会因为「端口被占用」而失败，
 * 而自动化测试仍然能确定地拿到自己要求的端口。
 */
const portExplicit = argv.includes('--port')
  || argv.some((a) => a.startsWith('--port='))
  || Boolean(process.env.PORT);
const MAX_PORT_TRIES = 10;

let activePort = PORT;
let portAttempts = 0;

async function start() {
  db.ensureDirs();
  const migration = await runMigrations();
  if (migration.restored > 0) {
    console.log(`  补回了 ${migration.restored} 条第一版记录对应的档案（原始文件未动）`);
  } else if (migration.migrated > 0) {
    console.log(`  已把 ${migration.migrated} 条第一版记录迁到「我的档案」（原始文件保留未动）`);
  }
  if (migration.textbookDemos > 0) {
    console.log(`  已按新规则重算 ${migration.textbookDemos} 本教材的辅助动画`);
  }
  if (migration.textbookLessons > 0) {
    console.log(`  已把 ${migration.textbookLessons} 本教材的旧讲义改为「文字为主」`);
  }

  listen();
}

/**
 * 启动横幅只在 'listening' 事件里打印，而且这个监听器只注册一次。
 *
 * 踩过的坑：如果把回调塞进 server.listen(port, host, cb)，cb 会被注册成
 * once('listening')。第一次监听失败（EADDRINUSE）时 'listening' 永远不触发，
 * 那个 once 监听器也不会被移除；重试成功后两个监听器一起触发，横幅就打印两遍。
 * 所以这里把 'listening' 独立出来注册，retry 只负责换端口。
 */
server.on('listening', () => {
  // 端口写成 0 时由系统分配：横幅和浮窗都必须拿到真实端口
  const addr = server.address();
  if (addr && addr.port) activePort = addr.port;
  const url = `http://${HOST}:${activePort}`;
  console.log('');
  console.log('  缓一缓 · 个人学术工作台');
  console.log('  ------------------------------------------');
  console.log(`  打开这个地址：  ${url}`);
  console.log(`  数据存在这里：  ${db.DATA_DIR}`);
  console.log('  按 Ctrl + C 停止');
  console.log('');

  if (argv.includes('--open')) {
    try {
      if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      else if (process.platform === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    } catch { /* 打不开浏览器不影响服务 */ }
  }
});

function listen() {
  server.listen(activePort, HOST);
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    if (!portExplicit && portAttempts < MAX_PORT_TRIES) {
      const busy = activePort;
      portAttempts += 1;
      activePort = PORT + portAttempts;
      console.log(`  端口 ${busy} 被占用了，自动换到 ${activePort} …`);
      // 稍等一点再试，给对方进程释放端口的时间
      setTimeout(() => listen(), 120);
      return;
    }
    console.error(
      portExplicit
        ? `\n  端口 ${activePort} 已被占用。换一个端口：node server/server.js --port ${activePort + 1}\n`
        : `\n  5180–${PORT + MAX_PORT_TRIES} 都被占用了。请关掉别的窗口，或用 --port 指定一个空闲端口。\n`
    );
    process.exit(1);
    return;
  }
  console.error('\n  服务器启动失败：', err.message, '\n');
  process.exit(1);
});

if (require.main === module) start();

module.exports = { server, start, buildOverview, toMarkdown };
