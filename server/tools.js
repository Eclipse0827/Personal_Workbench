'use strict';

/**
 * 智能体可调用的工具
 * ---------------------------------------------------------------
 * 只做「读」和「增改」，不提供任何删除能力 —— 删数据是不可逆的，
 * 不该由模型决定。用户想删，自己点。
 *
 * 每个工具返回 { ok, summary, data }：
 *   summary 是给人看的一句话（会显示在对话里）
 *   data    是给模型看的紧凑结果（要小，别把整个库塞进上下文）
 */

const db = require('./db');
const models = require('./models');
const profile = require('./profile');
const projectLib = require('./projects');
const { localDayKey, focusSeconds } = require('./focus-stats');

const MAX_CREATE = 8;
const today = () => localDayKey(new Date());

function norm(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

function shortDate(d) {
  return d ? String(d).slice(5).replace('-', '/') : '';
}

async function openTasks() {
  const tasks = await db.list('tasks');
  return tasks.filter((t) => t.status !== 'done');
}

// ---------------------------------------------------------------- 读

async function getOverview() {
  const tasks = await db.list('tasks');
  const plans = await db.list('plans');
  const sessions = await db.list('focusSessions');
  const day = today();

  const open = tasks.filter((t) => t.status !== 'done');
  const todayTasks = open.filter((t) => t.scheduledDate === day || t.dueDate === day);
  const overdue = open.filter((t) => t.dueDate && t.dueDate < day);
  const undated = open.filter((t) => !t.scheduledDate && !t.dueDate);

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekSessions = sessions.filter((s) => s.createdAt && new Date(s.createdAt) >= weekAgo);
  const weekSeconds = weekSessions.reduce((sum, s) => sum + (focusSeconds(s) || 0), 0);

  const doneToday = tasks.filter((t) => t.status === 'done' && (t.completedAt || '').slice(0, 10) === day);

  const data = {
    today: day,
    未完成: open.length,
    今天要做的: todayTasks.map((t) => t.title).slice(0, 8),
    已逾期: overdue.map((t) => `${t.title}(${t.dueDate})`).slice(0, 5),
    没排日期: undated.length,
    本周专注分钟: Math.round(weekSeconds / 60),
    今天完成: doneToday.length,
    进行中的计划: plans.filter((p) => p.status === 'active').map((p) => p.title).slice(0, 5),
  };

  const bits = [`未完成 ${data.未完成} 项`];
  if (data.今天要做的.length) bits.push(`今天 ${data.今天要做的.length} 项`);
  if (data.已逾期.length) bits.push(`逾期 ${data.已逾期.length} 项`);
  if (data.本周专注分钟) bits.push(`本周专注 ${data.本周专注分钟} 分钟`);

  return { ok: true, summary: '查了工作台：' + bits.join(' · '), data };
}

async function listTasks(args = {}) {
  const scope = String(args.scope || 'open');
  const limit = Math.min(20, Math.max(1, Number(args.limit) || 10));
  const day = today();
  const tasks = await db.list('tasks');

  let picked = tasks;
  if (scope === 'today') picked = tasks.filter((t) => t.status !== 'done' && (t.scheduledDate === day || t.dueDate === day));
  else if (scope === 'done') picked = tasks.filter((t) => t.status === 'done');
  else if (scope === 'overdue') picked = tasks.filter((t) => t.status !== 'done' && t.dueDate && t.dueDate < day);
  else if (scope === 'undated') picked = tasks.filter((t) => t.status !== 'done' && !t.scheduledDate && !t.dueDate);
  else picked = tasks.filter((t) => t.status !== 'done');

  const items = picked.slice(0, limit).map((t) => ({
    id: t.id,
    title: t.title,
    状态: t.status === 'done' ? '已完成' : '未完成',
    安排: t.scheduledDate || null,
    到期: t.dueDate || null,
  }));

  return {
    ok: true,
    summary: `查了 ${scope === 'today' ? '今天的' : scope === 'done' ? '已完成的' : scope === 'overdue' ? '逾期的' : '未完成的'}任务：${items.length} 条`,
    data: { scope, total: picked.length, items },
  };
}

async function listPlans() {
  const plans = await db.list('plans');
  const tasks = await db.list('tasks');
  const data = plans.map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status,
    任务数: tasks.filter((t) => t.planId === p.id).length,
  }));
  return { ok: true, summary: `查了计划：${data.length} 个`, data };
}

// ---------------------------------------------------------------- 学习项目

async function listProjects() {
  const projects = await db.listSorted('projects');
  const data = projects.map((raw) => {
    const p = projectLib.publicProject(raw);
    return {
      id: p.id,
      title: p.title,
      课程数: p.progress.courseCount,
      进度: p.progress.percent === null ? '暂不可计算' : `${p.progress.percent}%`,
      课程: p.courses.slice(0, 10).map((c) => ({
        id: c.id,
        title: c.title,
        已学: `${c.completedEpisodes || 0}/${c.totalEpisodes || 0} 集`,
      })),
    };
  });
  return { ok: true, summary: `查了学习项目：${data.length} 个`, data };
}

function episodeArg(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 10000 ? n : 0;
}

/** 按 id 或名字找项目；找不到时把现有项目回给模型，让它能自己纠正 */
async function findProject(args = {}) {
  const projects = await db.list('projects');
  const byId = projects.find((p) => p.id === args.projectId) || null;
  if (byId) return { project: byId, projects };
  const key = norm(args.project);
  const byName = key
    ? projects.find((p) => norm(p.title).includes(key) || key.includes(norm(p.title).slice(0, 4)))
    : null;
  return { project: byName || null, projects };
}

async function createProject(args = {}) {
  const title = String(args.title || '').trim().slice(0, 200);
  if (!title) return { ok: false, summary: '没有给学习项目起名字', data: {} };

  const projects = await db.list('projects');
  const dup = projects.find((p) => norm(p.title) === norm(title));
  if (dup) {
    return {
      ok: false,
      summary: `已经有同名项目「${dup.title}」了，没有重复建`,
      data: { existing: { id: dup.id, title: dup.title } },
    };
  }

  const project = projectLib.newProject({
    title,
    description: String(args.description || '').slice(0, 2000),
  });
  const wanted = Array.isArray(args.courses) ? args.courses.slice(0, 8) : [];
  for (const c of wanted) {
    const courseTitle = String((c && c.title) || '').trim().slice(0, 200);
    if (!courseTitle) continue;
    try {
      projectLib.addCourse(project, {
        title: courseTitle,
        totalEpisodes: episodeArg(c.totalEpisodes),
        platform: 'other',
      });
    } catch { /* 单门课程参数不合法就跳过，不拖累整个项目 */ }
  }
  await db.put('projects', project);

  return {
    ok: true,
    summary: `建了学习项目「${title}」${project.courses.length ? `，含 ${project.courses.length} 门课程` : ''}`,
    data: {
      project: {
        id: project.id,
        title: project.title,
        courses: project.courses.map((c) => ({ id: c.id, title: c.title })),
      },
    },
  };
}

async function addCourse(args = {}) {
  const title = String(args.title || '').trim().slice(0, 200);
  if (!title) return { ok: false, summary: '没有给课程起名字', data: {} };

  const { project, projects } = await findProject(args);
  if (!project) {
    return {
      ok: false,
      summary: '没找到这个学习项目',
      data: { projects: projects.map((p) => ({ id: p.id, title: p.title })).slice(0, 10) },
    };
  }
  const exists = (project.courses || []).find((c) => norm(c.title) === norm(title));
  if (exists) {
    return { ok: false, summary: `「${project.title}」里已经有这门课了`, data: { existing: exists.id } };
  }

  let course;
  try {
    course = projectLib.addCourse(project, {
      title,
      totalEpisodes: episodeArg(args.totalEpisodes),
      platform: 'other',
    });
  } catch (err) {
    return { ok: false, summary: `课程没建成：${err.message}`, data: {} };
  }
  await db.put('projects', project);
  return {
    ok: true,
    summary: `在「${project.title}」里加了课程「${course.title}」`,
    data: { projectId: project.id, courseId: course.id, title: course.title },
  };
}

async function listTextbooks() {
  const books = await db.list('textbooks');
  const data = books.map((b) => ({
    id: b.id,
    title: b.title,
    章数: (b.chapters || []).length,
    页数: b.pageCount || 0,
    已读: b.progress && b.progress.percent ? `${b.progress.percent}%` : '未开始',
  }));
  return { ok: true, summary: `查了教材：${data.length} 本`, data };
}

async function readTextbook(args = {}) {
  const books = await db.list('textbooks');
  const key = norm(args.book);
  const book = books.find((b) => b.id === args.book)
    || books.find((b) => norm(b.title).includes(key) || key.includes(norm(b.title).slice(0, 6)));
  if (!book) return { ok: false, summary: '没找到这本书', data: { books: books.map((b) => b.title).slice(0, 8) } };

  const chapters = book.chapters || [];
  if (!chapters.length) return { ok: false, summary: `《${book.title}》还没有识别出章节`, data: {} };

  let idx = -1;
  const wanted = String(args.chapter || '').trim();
  if (wanted) {
    const num = Number(wanted.replace(/[^\d]/g, ''));
    if (Number.isFinite(num) && num > 0 && num <= chapters.length) idx = num - 1;
    if (idx < 0) idx = chapters.findIndex((c) => norm(c.title).includes(norm(wanted)));
  }
  if (idx < 0) idx = 0;

  const chapter = chapters[idx];
  const pages = await db.readTextbookPages(book.id).catch(() => null);
  let text = '';
  if (Array.isArray(pages) && pages.length) {
    const from = Math.max(0, (chapter.pageStart || 1) - 1);
    const to = Math.min(pages.length, chapter.pageEnd || from + 3);
    text = pages.slice(from, to).map((p) => (typeof p === 'string' ? p : p.text || '')).join('\n').trim();
  }
  text = text.replace(/\s+/g, ' ').slice(0, 1800);

  // 精读页里就这一章问过什么，也算「教材里的内容」，一起带出来
  const chats = book.chats || {};
  const chapterChat = [chapter.id, chapter.sectionId, String(idx + 1)]
    .map((k) => (k ? chats[k] : null))
    .find((v) => Array.isArray(v) && v.length) || [];
  const notes = chapterChat.slice(-4).map((m) => ({
    role: m.role === 'user' ? '问' : '答',
    text: String(m.content || '').replace(/\s+/g, ' ').slice(0, 260),
  }));

  return {
    ok: true,
    summary: `读了《${book.title}》${chapter.title}`,
    data: {
      book: book.title,
      chapter: chapter.title,
      pageRange: [chapter.pageStart, chapter.pageEnd],
      chapters: chapters.map((c, i) => `${i + 1}. ${c.title}`).slice(0, 30),
      text: text || '（这一章没有可读的正文文本）',
      notes,
    },
  };
}

// ---------------------------------------------------------------- 外刊阅读

async function listArticles() {
  const articles = await db.listSorted('articles');
  const data = articles.map((a) => ({
    id: a.id,
    title: a.title,
    source: a.source || '',
    字数: a.wordCount || 0,
    段落: a.paragraphCount || 0,
    进度: a.progress && a.progress.percent ? `${a.progress.percent}%` : '未开始',
    高亮: (a.highlights || []).length,
  }));
  return { ok: true, summary: `查了外刊：${data.length} 篇`, data };
}

async function readArticle(args = {}) {
  const articles = await db.listSorted('articles');
  const key = norm(args.article || args.title || '');
  const article = articles.find((a) => a.id === args.article || a.id === args.articleId)
    || (key
      ? articles.find((a) => norm(a.title).includes(key) || key.includes(norm(a.title).slice(0, 6)))
      : null);
  if (!article) {
    return {
      ok: false,
      summary: '没找到这篇外刊',
      data: { articles: articles.map((a) => ({ id: a.id, title: a.title })).slice(0, 10) },
    };
  }

  const paragraphs = await db.readArticleContent(article.id).catch(() => []);
  const from = Math.min(
    Math.max(0, (Number(args.paragraph) || 1) - 1),
    Math.max(0, (paragraphs || []).length - 1),
  );
  const slice = (Array.isArray(paragraphs) ? paragraphs : []).slice(from, from + 6);
  const text = slice
    .map((p) => (typeof p === 'string' ? p : (p && p.text) || ''))
    .join('\n')
    .replace(/\s+/g, ' ')
    .slice(0, 2600);

  const highlights = (article.highlights || []).slice(0, 8).map((h) => ({
    text: String(h.text || h.selectionText || h.quote || '').replace(/\s+/g, ' ').slice(0, 180),
    note: String(h.note || h.comment || '').replace(/\s+/g, ' ').slice(0, 180),
  }));

  const chat = await db.readArticleChat(article.id).catch(() => ({ messages: [] }));
  const recentQuestions = (chat.messages || [])
    .filter((m) => m.role === 'user')
    .slice(-3)
    .map((m) => String(m.content || '').replace(/\s+/g, ' ').slice(0, 160));

  return {
    ok: true,
    summary: `读了《${article.title}》第 ${from + 1} 段起共 ${slice.length} 段`,
    data: {
      article: article.title,
      source: article.source || '',
      paragraphFrom: from + 1,
      paragraphTotal: (paragraphs || []).length,
      text: text || '（这篇还没有导入正文）',
      highlights,
      recentQuestions,
    },
  };
}

/** 精读 / 外刊里问过什么的索引，用来回答「我上次问了啥」 */
async function listNotes(args = {}) {
  const scope = String(args.scope || 'all');
  const out = { textbook: [], article: [] };
  const key = norm(args.query || '');

  if (scope !== 'article') {
    const books = await db.list('textbooks');
    for (const book of books) {
      for (const [sectionId, messages] of Object.entries(book.chats || {})) {
        const list = Array.isArray(messages) ? messages : [];
        const lastUser = [...list].reverse().find((m) => m.role === 'user');
        if (!lastUser) continue;
        const text = String(lastUser.content || '').replace(/\s+/g, ' ').slice(0, 160);
        if (key && !norm(`${book.title}${sectionId}${text}`).includes(key)) continue;
        out.textbook.push({
          book: book.title,
          section: sectionId,
          question: text,
          问答条数: list.length,
        });
      }
    }
  }

  if (scope !== 'textbook') {
    const articles = await db.listSorted('articles');
    for (const article of articles) {
      const chat = await db.readArticleChat(article.id).catch(() => null);
      const messages = (chat && chat.messages) || [];
      if (!messages.length) continue;
      const last = messages[messages.length - 1];
      const text = String(last.content || '').replace(/\s+/g, ' ').slice(0, 160);
      if (key && !norm(`${article.title}${text}`).includes(key)) continue;
      out.article.push({ article: article.title, 问答条数: messages.length, 最近: text });
    }
  }

  out.textbook = out.textbook.slice(0, 12);
  out.article = out.article.slice(0, 12);
  const total = out.textbook.length + out.article.length;
  return {
    ok: true,
    summary: `查了精读/外刊里的问答：教材 ${out.textbook.length} 处、外刊 ${out.article.length} 篇`,
    data: total ? out : { ...out, hint: '系统里还没有精读或外刊的问答记录' },
  };
}

// ---------------------------------------------------------------- 写

async function createTasks(args = {}, ctx = {}) {
  const raw = Array.isArray(args.tasks) ? args.tasks : [];
  if (!raw.length) return { ok: false, summary: '没有给出要创建的任务', data: {} };

  // 用户提到某个学习项目时，先确认它真的存在，再把任务挂过去。
  // 找不到就整批不建 —— 宁可让模型查一次重来，也不悄悄把待办丢进无归属的列表。
  let projectId = null;
  let courseId = null;
  let projectTitle = null;
  if (args.project || args.projectId || args.courseId) {
    const { project, projects } = await findProject(args);
    if (!project) {
      return {
        ok: false,
        summary: `没找到学习项目${args.project ? `「${args.project}」` : ''}，任务没有创建`,
        data: {
          projects: projects.map((p) => ({ id: p.id, title: p.title })).slice(0, 10),
          hint: '先用 list_projects 查到 id，再带 projectId 重试',
        },
      };
    }
    projectId = project.id;
    projectTitle = project.title;
    if (args.courseId) {
      const hit = projectLib.locateCourse(projects, args.courseId);
      if (!hit) {
        return {
          ok: false,
          summary: '没找到这门课程，任务没有创建',
          data: { courses: (project.courses || []).map((c) => ({ id: c.id, title: c.title })) },
        };
      }
      courseId = hit.course.id;
      projectId = hit.project.id;
      projectTitle = hit.project.title;
    }
  }

  const existing = await openTasks();
  const seen = new Set(existing.map((t) => norm(t.title)));
  const created = [];
  const skipped = [];

  for (const item of raw.slice(0, MAX_CREATE)) {
    const title = String(item.title || '').trim().slice(0, 200);
    if (!title) continue;
    if (seen.has(norm(title))) { skipped.push(title); continue; }
    const task = models.newTask({
      title,
      description: String(item.detail || item.description || '').slice(0, 1200),
      scheduledDate: item.scheduledDate || null,
      status: 'todo',
      priority: item.priority || 'normal',
      planId: item.planId || args.planId || null,
      projectId,
      courseId,
      source: 'ai',
      sourceConversationId: (ctx && ctx.conversationId) || null,
    });
    await db.put('tasks', task);
    seen.add(norm(title));
    created.push(task);
  }

  return {
    ok: created.length > 0,
    summary: created.length
      ? `建了 ${created.length} 个任务${projectTitle ? `，归到「${projectTitle}」` : ''}：${created.map((t) => t.title).join('、')}${skipped.length ? `（跳过 ${skipped.length} 个重复的）` : ''}`
      : `没有新建：${skipped.length} 个都是已有的`,
    data: {
      created: created.map((t) => ({ id: t.id, title: t.title, scheduledDate: t.scheduledDate, projectId: t.projectId })),
      skipped,
      projectId,
      projectTitle,
    },
  };
}

async function updateTask(args = {}) {
  const tasks = await db.list('tasks');
  let task = null;
  if (args.taskId) task = tasks.find((t) => t.id === args.taskId) || null;
  if (!task && args.title) {
    const key = norm(args.title);
    task = tasks.find((t) => norm(t.title) === key && t.status !== 'done')
      || tasks.find((t) => norm(t.title).includes(key) && t.status !== 'done')
      || null;
  }
  if (!task) return { ok: false, summary: '没找到这个任务', data: { hint: '先用 list_tasks 查一下' } };

  const patch = {};
  if (args.status === 'done' || args.status === 'todo') patch.status = args.status;
  if (typeof args.scheduledDate === 'string') patch.scheduledDate = args.scheduledDate || null;
  if (!Object.keys(patch).length) return { ok: false, summary: '没有要改的字段', data: {} };

  const next = {
    ...task,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  if (patch.status === 'done') next.completedAt = new Date().toISOString();
  if (patch.status === 'todo') next.completedAt = null;
  await db.put('tasks', next);

  const what = patch.status === 'done' ? '标记完成' : patch.status === 'todo' ? '改回未完成' : '改了日期';
  return { ok: true, summary: `${what}：${task.title}`, data: { id: task.id, title: task.title, ...patch } };
}

// ---------------------------------------------------------------- 记忆

async function remember(args = {}) {
  const r = await profile.add(args.text);
  return {
    ok: r.added,
    summary: r.added ? `记住了：${r.text}` : `没有重复记：${r.reason}`,
    data: r,
  };
}

// ---------------------------------------------------------------- 注册表

const TOOLS = {
  get_overview: { run: getOverview },
  list_tasks: { run: listTasks },
  list_plans: { run: listPlans },
  list_projects: { run: listProjects },
  list_textbooks: { run: listTextbooks },
  read_textbook: { run: readTextbook },
  list_articles: { run: listArticles },
  read_article: { run: readArticle },
  list_notes: { run: listNotes },
  create_project: { run: createProject },
  add_course: { run: addCourse },
  create_tasks: { run: createTasks },
  update_task: { run: updateTask },
  remember: { run: remember },
};

/** 写进系统提示词的说明，要和上面的实现一一对应 */
const TOOL_SPEC = `可以调用这些工具（只读的随时可用；写操作只在用户明确要求时用）：
- get_overview {} 今天要做什么、逾期、本周专注时长
- list_tasks {"scope":"today|open|overdue|undated|done","limit":10}
- list_plans {}
- list_projects {} 学习项目 + 课程 + 进度；要给任务挂项目，先查这里的 id
- list_textbooks {}
- read_textbook {"book":"书名或 id","chapter":"章节标题或序号"} 章节正文（1800 字内）与这一章的精读问答
- list_articles {} 外刊列表：标题、字数、进度、高亮数
- read_article {"article":"标题或 id","paragraph":1} 从该段起 6 段正文、高亮、最近问过的问题
- list_notes {"scope":"all|textbook|article","query":"关键词"} 精读与外刊里问过什么的索引
- create_project {"title":"...","description":"...","courses":[{"title":"...","totalEpisodes":0}]} 建学习项目，同名不会重复建
- add_course {"projectId":"...","title":"...","totalEpisodes":0} 给已有项目加课程
- create_tasks {"tasks":[{"title":"...","detail":"...","scheduledDate":"YYYY-MM-DD"}],"planId":null,"projectId":null,"courseId":null}  最多 8 条，重复标题会自动跳过；projectId 可让任务归到学习项目
- update_task {"taskId":"...","title":"...","status":"done|todo","scheduledDate":"YYYY-MM-DD"}
- remember {"text":"..."}  记下跨对话仍然成立的事：目标、考哪几科、作息、长期限制。一次只记一条，别把闲聊塞进来`;

async function executeOne(action, ctx = {}) {
  const name = String(action && action.tool || '').trim();
  const spec = TOOLS[name];
  if (!spec) {
    return { tool: name || '?', ok: false, summary: '没有这个工具', data: { error: 'unknown tool' } };
  }
  try {
    const out = await spec.run(action.args || {}, ctx);
    return { tool: name, ...out };
  } catch (err) {
    return { tool: name, ok: false, summary: `执行失败：${err.message}`, data: { error: err.message } };
  }
}

async function execute(actions, ctx = {}) {
  const list = Array.isArray(actions) ? actions.slice(0, 4) : [];
  const out = [];
  for (const a of list) out.push(await executeOne(a, ctx));
  return out;
}

module.exports = { TOOLS, TOOL_SPEC, execute, executeOne, today };
