'use strict';

/**
 * 接口自测 —— 对照 PRD 第八章「验收标准」
 * ---------------------------------------------------------------
 * 用法：node server/selftest.js [--port 5180]
 *
 * 真实走一遍：
 *   工作台 → 手动建任务 → 建计划 → 关联 → 专注番茄钟 → AI 对话 → 方案 → 确认创建
 *   → 教材导入与讲义 → 防重复 → 档案 → 导出
 *
 * 安全：只删除本脚本自己创建的数据，绝不碰用户已有的记录和档案。
 * 专注记录没有公开的删除接口，测试结束时直接按 id 删除自己写入的那一条。
 */

const fs = require('fs/promises');
const http = require('http');
const path = require('path');
const db = require('./db');
const llm = require('./llm');
const articleAI = require('./article-ai');
const contextLib = require('./context');
const ai = require('./ai');
const { focusStats } = require('./focus-stats');
const textbook = require('./textbook');
const ocr = require('./ocr');
const glossary = require('./glossary');
const ocrToc = require('./ocr-toc');

const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 5180;
})();
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push(`${name}${extra ? ` — ${extra}` : ''}`); console.log(`  ✗ ${name}${extra ? `  — ${extra}` : ''}`); }
}

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const shift = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function main() {
  console.log(`\n缓一缓 · 个人学术工作台 · 接口自测  →  ${BASE}\n`);

  const before = (await req('GET', '/api/bootstrap')).data;
  const beforeTaskIds = new Set(before.tasks.map((t) => t.id));
  const beforePlanIds = new Set(before.plans.map((p) => p.id));
  const beforeProjectIds = new Set((before.projects || []).map((p) => p.id));
  const beforeArchiveIds = new Set(before.archives.map((a) => a.id));
  const beforeConvIds = new Set(before.conversations.map((c) => c.id));
  const userArchives = before.archives.filter((a) => a.origin === 'legacy');
  let focusSessionId = null;
  let yesterdayFocusSessionId = null;
  const extraFocusSessionIds = [];
  const activeTokens = new Set();
  // 用户可能正开着一轮专注；测试不碰它，也不覆盖进行中的计时文件
  const activeFocusFile = db.ACTIVE_FOCUS_FILE;
  const activeFocusSnapshot = await fs.readFile(activeFocusFile, 'utf8').catch(() => null);
  // 归类关系是全局的；测试只在最后恢复，确保中途失败也不会留下测试别名
  const aliasesFile = db.FOCUS_ALIASES_FILE;
  const aliasesSnapshot = await fs.readFile(aliasesFile, 'utf8').catch(() => null);
  const activeAtStart = await db.getActiveFocus();
  const canTestActive = !activeAtStart;
  let textbookId = null;
  console.log(`（起始：${beforeTaskIds.size} 个任务、${beforePlanIds.size} 个计划、${beforeArchiveIds.size} 份档案、${beforeConvIds.size} 个对话）\n`);

  // ---------------------------------------------------------------- 8.1 工作台
  console.log('【8.1 工作台】');
  const boot = await req('GET', '/api/bootstrap');
  ok('bootstrap 返回 200', boot.status === 200, `实际 ${boot.status}`);
  ok('返回今天的日期', /^\d{4}-\d{2}-\d{2}$/.test(boot.data.today), boot.data.today);
  ok('返回 tasks / plans / archives / settings',
    Array.isArray(boot.data.tasks) && Array.isArray(boot.data.plans)
    && Array.isArray(boot.data.archives) && Boolean(boot.data.settings));
  ok('返回统计数据', typeof boot.data.stats === 'object' && typeof boot.data.stats.open === 'number');
  ok('设置不回显 API Key', boot.data.settings.apiKey === undefined && typeof boot.data.settings.hasApiKey === 'boolean');
  ok('AI 引擎配置是三种实现之一（不冒充模型）',
    ['mock', 'ollama', 'real'].includes(boot.data.settings.aiProvider),
    boot.data.settings.aiProvider);

  // ---------------------------------------------------------------- 8.2 任务
  console.log('\n【8.2 待办与计划 · 任务】');
  const c1 = await req('POST', '/api/tasks', { title: '手动创建的任务' });
  ok('手动创建任务 → 201', c1.status === 201, `实际 ${c1.status}`);
  const manualTask = c1.data.task;
  ok('source 标记为 manual', manualTask.source === 'manual');
  ok('默认状态是待开始', manualTask.status === 'todo');
  ok('默认优先级是普通', manualTask.priority === 'normal');

  ok('标题为空被拒绝 → 400', (await req('POST', '/api/tasks', { title: '   ' })).status === 400);

  const todayTask = (await req('POST', '/api/tasks', {
    title: '今天的任务', scheduledDate: today(), priority: 'important',
  })).data.task;
  ok('可以设置执行日期与优先级', todayTask.scheduledDate === today() && todayTask.priority === 'important');

  const undatedTask = (await req('POST', '/api/tasks', { title: '没有日期的任务' })).data.task;
  ok('可以创建没有日期的任务', undatedTask.scheduledDate === null && undatedTask.dueDate === null);

  const ownedProject = (await req('POST', '/api/projects', { title: '自测 · 任务归属验证' })).data.project;
  const ownedTask = (await req('POST', '/api/tasks', {
    title: '归到学习项目的任务',
    projectId: ownedProject.id,
    source: 'ai',
    sourceKind: 'reading',
    sourceRefId: 'article:selftest-probe',
    sourceLabel: '外刊 · 自测探针',
  })).data.task;
  ok('★ 任务可以归到学习项目', ownedTask.projectId === ownedProject.id);
  ok('★ 阅读问答转来的待办带来源标记',
    ownedTask.sourceKind === 'reading'
    && ownedTask.sourceRefId === 'article:selftest-probe'
    && ownedTask.sourceLabel === '外刊 · 自测探针');
  ok('★ 按项目筛选能查到归属任务',
    (await req('GET', `/api/tasks?projectId=${ownedProject.id}`)).data.tasks.some((t) => t.id === ownedTask.id));
  await req('DELETE', `/api/tasks/${ownedTask.id}`);
  await req('DELETE', `/api/projects/${ownedProject.id}`);

  const todayList = (await req('GET', '/api/tasks?filter=today')).data.tasks;
  ok('「今天」筛选包含今天安排的任务', todayList.some((t) => t.id === todayTask.id));
  ok('「今天」筛选不包含没有日期的任务', !todayList.some((t) => t.id === undatedTask.id));

  const openList = (await req('GET', '/api/tasks?filter=open')).data.tasks;
  ok('★ 没有日期的任务不会从「全部未完成」里消失', openList.some((t) => t.id === undatedTask.id));

  const toDoing = await req('PATCH', `/api/tasks/${manualTask.id}`, { status: 'doing' });
  ok('任务可改为进行中', toDoing.data.task.status === 'doing');
  const toDone = await req('PATCH', `/api/tasks/${manualTask.id}`, { status: 'done' });
  ok('任务可标记为已完成', toDone.data.task.status === 'done');
  ok('完成时写入完成时间', Boolean(toDone.data.task.completedAt));
  const backToTodo = await req('PATCH', `/api/tasks/${manualTask.id}`, { status: 'todo' });
  ok('★ 已完成可以恢复为未完成', backToTodo.data.task.status === 'todo');
  ok('★ 恢复为未完成时清掉完成时间', backToTodo.data.task.completedAt === null, String(backToTodo.data.task.completedAt));

  const edited = await req('PATCH', `/api/tasks/${manualTask.id}`, {
    title: '改过标题的任务', description: '补充说明', priority: 'important', dueDate: shift(3),
  });
  ok('可以编辑标题、描述、优先级、截止日期',
    edited.data.task.title === '改过标题的任务'
    && edited.data.task.description === '补充说明'
    && edited.data.task.priority === 'important'
    && edited.data.task.dueDate === shift(3));

  const tmp = (await req('POST', '/api/tasks', { title: '待删除' })).data.task;
  ok('删除任务 → 200', (await req('DELETE', `/api/tasks/${tmp.id}`)).status === 200);
  ok('删除后取不到 → 404', (await req('GET', `/api/tasks/${tmp.id}`)).status === 404);
  ok('重复删除 → 404', (await req('DELETE', `/api/tasks/${tmp.id}`)).status === 404);

  // ---------------------------------------------------------------- 8.2 计划
  console.log('\n【8.2 待办与计划 · 计划】');
  const p1 = await req('POST', '/api/plans', { title: '考研初试计划', description: '数学 + 英语' });
  ok('创建计划 → 201', p1.status === 201, `实际 ${p1.status}`);
  const plan = p1.data.plan;
  ok('计划默认进行中', plan.status === 'active');

  const linked = await req('PATCH', `/api/tasks/${todayTask.id}`, { planId: plan.id });
  ok('可以把任务关联到计划', linked.data.task.planId === plan.id);
  ok('关联不存在的计划被拒绝 → 400',
    (await req('PATCH', `/api/tasks/${todayTask.id}`, { planId: 'no-such-plan' })).status === 400);

  const planDetail = await req('GET', `/api/plans/${plan.id}/tasks`);
  ok('可以查看某计划下的全部任务', planDetail.data.tasks.some((t) => t.id === todayTask.id));

  const planEdit = await req('PATCH', `/api/plans/${plan.id}`, { status: 'archived', endDate: shift(30) });
  ok('可以编辑计划状态与日期', planEdit.data.plan.status === 'archived' && planEdit.data.plan.endDate === shift(30));

  const planToDelete = (await req('POST', '/api/plans', { title: '要删掉的计划' })).data.plan;
  const taskInPlan = (await req('POST', '/api/tasks', { title: '计划里的任务', planId: planToDelete.id })).data.task;
  const delPlan = await req('DELETE', `/api/plans/${planToDelete.id}`);
  ok('删除计划 → 200', delPlan.status === 200);
  ok('★ 删计划不会连带删任务', delPlan.data.detachedTasks === 1, `detached=${delPlan.data.detachedTasks}`);
  const afterDelTask = await req('GET', `/api/tasks/${taskInPlan.id}`);
  ok('★ 原任务仍然存在', afterDelTask.status === 200);
  ok('★ 原任务的计划关联被解除', afterDelTask.data.task.planId === null);

  // ---------------------------------------------------------------- 学习项目
  console.log('\n【学习项目与课程】');
  const projectRes = await req('POST', '/api/projects', {
    title: '考研数学（自测）', description: '数学一 + 线性代数',
  });
  ok('创建学习项目 → 201', projectRes.status === 201, `实际 ${projectRes.status}`);
  const project = projectRes.data.project;
  ok('新项目还没有课程', project.courses.length === 0);
  ok('没有总集数时进度暂不可计算',
    project.progress.calculable === false && project.progress.percent === null);

  const courseRes = await req('POST', `/api/projects/${project.id}/courses`, {
    title: '高数基础班', platform: 'bilibili',
    url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=1&vd_source=test',
    totalEpisodes: 20, lastEpisode: 12, completedEpisodes: 11,
  });
  ok('添加课程 → 201', courseRes.status === 201, `实际 ${courseRes.status}`);
  const course = courseRes.data.course;
  ok('★ 最近学习集数与已完成集数分开保存',
    course.lastEpisode === 12 && course.completedEpisodes === 11);
  ok('课程按总集数算百分比', course.percent === 55, `实际 ${course.percent}`);
  ok('项目进度按集数加权', courseRes.data.project.progress.percent === 55,
    `实际 ${courseRes.data.project.progress.percent}`);

  const unknownRes = await req('POST', `/api/projects/${project.id}/courses`, {
    title: '线代（总集数未填）', platform: 'other', totalEpisodes: 0,
    lastEpisode: 4, completedEpisodes: 4,
  });
  ok('★ 未填总集数的课程不参与进度计算',
    unknownRes.data.project.progress.percent === 55
    && unknownRes.data.project.progress.coursesWithoutTotal === 1,
    `percent=${unknownRes.data.project.progress.percent}`);

  const knownRes = await req('POST', `/api/projects/${project.id}/courses`, {
    title: '概率论', platform: 'mooc', totalEpisodes: 30, lastEpisode: 20, completedEpisodes: 20,
  });
  ok('★ 多门课程按总集数加权：31 / 50 = 62%',
    knownRes.data.project.progress.percent === 62
    && knownRes.data.project.progress.completedEpisodes === 31
    && knownRes.data.project.progress.totalEpisodes === 50,
    `percent=${knownRes.data.project.progress.percent}`);

  const unknownOnlyProject = (await req('POST', '/api/projects', { title: '只有未知集数（自测）' })).data.project;
  const unknownOnlyCourse = (await req('POST', `/api/projects/${unknownOnlyProject.id}/courses`, {
    title: '没填总集数的课程', totalEpisodes: 0, completedEpisodes: 3,
  })).data;
  ok('★ 所有课程都没填总集数时，项目进度暂不可计算',
    unknownOnlyCourse.project.progress.calculable === false
    && unknownOnlyCourse.project.progress.percent === null
    && unknownOnlyCourse.project.progress.coursesWithoutTotal === 1);

  const continued = await req('POST', `/api/projects/${project.id}/courses/${course.id}/continue`, {});
  ok('继续学习 → 200', continued.status === 200, `实际 ${continued.status}`);
  ok('★ 继续学习打开的是最近正在看的第 12 集', continued.data.targetEpisode === 12);
  ok('★ B 站分 P 视频按实际打开集数定位', continued.data.located === true
    && continued.data.url.includes('p=12'), continued.data.url);
  ok('继续学习后写入最近学习集数与时间',
    continued.data.course.lastEpisode === 12 && Boolean(continued.data.course.lastStudiedAt));

  const completedOnce = await req('POST', `/api/projects/${project.id}/courses/${course.id}/complete`, {});
  ok('★ 完成第 12 集后已完成集数变成 12',
    completedOnce.status === 200 && completedOnce.data.completedEpisodes === 12,
    `status=${completedOnce.status}`);

  const repeatComplete = await req('POST', `/api/projects/${project.id}/courses/${course.id}/complete`, {});
  ok('★ 重复完成同一集 → 409', repeatComplete.status === 409, `实际 ${repeatComplete.status}`);

  const afterComplete = await req('POST', `/api/projects/${project.id}/courses/${course.id}/continue`, {});
  ok('★ 完成本集后下一次打开第 13 集', afterComplete.data.targetEpisode === 13);

  // 跳集：允许手动记录「最近看到第 18 集」，但不能据此认为 13–17 集都完成了
  const jumped = await req('PATCH', `/api/projects/${project.id}/courses/${course.id}`, {
    lastEpisode: 18,
  });
  ok('手动把最近学习集数改到第 18 集', jumped.data.course.lastEpisode === 18
    && jumped.data.course.completedEpisodes === 12);
  const jumpComplete = await req('POST', `/api/projects/${project.id}/courses/${course.id}/complete`, {});
  ok('★ 跳集后不能直接完成，也不会推断中间集数',
    jumpComplete.status === 409 && jumpComplete.data.error.includes('顺序'),
    `实际 ${jumpComplete.status}`);

  // 恢复成连续状态，确保「继续学习」永远回到实际打开的位置
  await req('PATCH', `/api/projects/${project.id}/courses/${course.id}`, { lastEpisode: 13 });
  const backOnTrack = await req('POST', `/api/projects/${project.id}/courses/${course.id}/continue`, {});
  ok('★ 回到第 13 集后继续学习仍然打开第 13 集', backOnTrack.data.targetEpisode === 13);

  const singleRes = await req('POST', `/api/projects/${project.id}/courses`, {
    title: '单集公开课', platform: 'bilibili',
    url: 'https://www.bilibili.com/video/BV1singleOnly', totalEpisodes: 0,
  });
  const singleCourse = singleRes.data.course;
  const singleContinue = await req('POST', `/api/projects/${project.id}/courses/${singleCourse.id}/continue`, {});
  ok('★ 无法确认是分 P 视频时保留原始链接',
    singleContinue.data.located === false
    && singleContinue.data.url === 'https://www.bilibili.com/video/BV1singleOnly');

  const otherRes = await req('POST', `/api/projects/${project.id}/courses`, {
    title: '非 B 站课程', platform: 'other',
    url: 'https://example.com/course?p=3', totalEpisodes: 0,
  });
  const otherContinue = await req('POST', `/api/projects/${project.id}/courses/${otherRes.data.course.id}/continue`, {});
  ok('★ 非 B 站链接绝不改写', otherContinue.data.located === false
    && otherContinue.data.url === 'https://example.com/course?p=3');

  const clamped = await req('PATCH', `/api/projects/${project.id}/courses/${course.id}`, {
    totalEpisodes: 20, lastEpisode: 2, completedEpisodes: 25,
  });
  ok('★ 手动编辑时已完成集数不超过总集数，最近学习集数不低于已完成',
    clamped.data.course.completedEpisodes === 20 && clamped.data.course.lastEpisode === 20,
    `${clamped.data.course.completedEpisodes}/${clamped.data.course.lastEpisode}`);

  // 任务关联
  const linkedCourseTask = await req('POST', '/api/tasks', {
    title: '看高数第 13 集', projectId: project.id, courseId: course.id,
  });
  ok('任务可以关联学习项目和课程',
    linkedCourseTask.data.task.projectId === project.id
    && linkedCourseTask.data.task.courseId === course.id);

  const linkedByCourseOnly = await req('POST', '/api/tasks', {
    title: '只给课程也能反推项目', courseId: knownRes.data.course.id,
  });
  ok('只给课程时自动补上所属项目',
    linkedByCourseOnly.data.task.projectId === project.id
    && linkedByCourseOnly.data.task.courseId === knownRes.data.course.id);

  ok('关联不存在的项目 → 400',
    (await req('PATCH', `/api/tasks/${linkedCourseTask.data.task.id}`, { projectId: 'no-such-project' })).status === 400);
  ok('关联不存在的课程 → 400',
    (await req('PATCH', `/api/tasks/${linkedCourseTask.data.task.id}`, { courseId: 'no-such-course' })).status === 400);

  const otherProject = (await req('POST', '/api/projects', { title: '英语学习（自测）' })).data.project;
  const otherCourse = (await req('POST', `/api/projects/${otherProject.id}/courses`, {
    title: '阅读课', platform: 'other', totalEpisodes: 10,
  })).data.course;
  ok('项目和课程不匹配 → 400',
    (await req('PATCH', `/api/tasks/${linkedCourseTask.data.task.id}`, {
      projectId: project.id, courseId: otherCourse.id,
    })).status === 400);

  // 删除课程：只解除课程关联，任务和项目都保留
  const tempCourse = (await req('POST', `/api/projects/${project.id}/courses`, {
    title: '要删掉的课程', totalEpisodes: 5,
  })).data.course;
  const taskInCourse = (await req('POST', '/api/tasks', {
    title: '课程里的任务', projectId: project.id, courseId: tempCourse.id,
  })).data.task;
  const delCourse = await req('DELETE', `/api/projects/${project.id}/courses/${tempCourse.id}`);
  ok('删除课程 → 200', delCourse.status === 200);
  ok('★ 删课程只解除课程关联', delCourse.data.detachedTasks === 1);
  const taskAfterCourse = await req('GET', `/api/tasks/${taskInCourse.id}`);
  ok('★ 删课程不会删任务，项目关联也保留',
    taskAfterCourse.status === 200
    && taskAfterCourse.data.task.courseId === null
    && taskAfterCourse.data.task.projectId === project.id);

  // 删除项目：课程一起删，任务只解除关联
  const tempProject = (await req('POST', '/api/projects', { title: '待删除项目（自测）' })).data.project;
  const tempProjectCourse = (await req('POST', `/api/projects/${tempProject.id}/courses`, {
    title: '项目里的课程', totalEpisodes: 3,
  })).data.course;
  const taskProjectOnly = (await req('POST', '/api/tasks', {
    title: '只挂项目的任务', projectId: tempProject.id,
  })).data.task;
  const taskProjectCourse = (await req('POST', '/api/tasks', {
    title: '挂项目和课程的任务', projectId: tempProject.id, courseId: tempProjectCourse.id,
  })).data.task;
  const delProject = await req('DELETE', `/api/projects/${tempProject.id}`);
  ok('删除项目 → 200', delProject.status === 200);
  ok('★ 删项目解除全部关联任务', delProject.data.detachedTasks === 2,
    `detached=${delProject.data.detachedTasks}`);
  const projectGone = await req('GET', `/api/projects/${tempProject.id}`);
  ok('删除后项目取不到 → 404', projectGone.status === 404);
  const pTask1 = await req('GET', `/api/tasks/${taskProjectOnly.id}`);
  const pTask2 = await req('GET', `/api/tasks/${taskProjectCourse.id}`);
  ok('★ 删项目不会删任务', pTask1.status === 200 && pTask2.status === 200);
  ok('★ 原任务的项目与课程关联都被清除',
    pTask1.data.task.projectId === null && pTask2.data.task.projectId === null
    && pTask2.data.task.courseId === null);

  ok('项目列表包含新建项目',
    (await req('GET', '/api/projects')).data.projects.some((p) => p.id === project.id));
  ok('bootstrap 带回学习项目',
    (await req('GET', '/api/bootstrap')).data.projects.some((p) => p.id === project.id));

  // ---------------------------------------------------------------- 专注
  console.log('\n【专注番茄钟】');
  const focusTask = (await req('POST', '/api/tasks', {
    title: '用番茄钟背单词', scheduledDate: today(),
  })).data.task;
  const focusStarted = new Date(Date.now() - 25 * 60 * 1000).toISOString();
  const focusPayload = {
    clientToken: `selftest-focus-${Date.now()}`,
    mode: 'focus',
    title: '背 50 个单词',
    taskId: focusTask.id,
    minutes: 25,
    actualSeconds: 1500,
    startedAt: focusStarted,
    endedAt: new Date().toISOString(),
    completeTask: true,
  };
  const f1 = await req('POST', '/api/focus/sessions', focusPayload);
  ok('记录一轮专注 → 201', f1.status === 201, `实际 ${f1.status}`);
  const focusSession = f1.data.session;
  focusSessionId = focusSession.id;
  ok('★ 关联的待办被自动勾成已完成', f1.data.task.status === 'done');
  ok('记录了待办原来的状态，方便撤销', focusSession.taskPreviousStatus === 'todo');
  ok('专注标题与关联待办被保存下来',
    focusSession.title === '背 50 个单词' && focusSession.taskId === focusTask.id);

  const fDup = await req('POST', '/api/focus/sessions', focusPayload);
  ok('★ 同一个 clientToken 重试不会产生第二条记录',
    fDup.status === 200 && fDup.data.duplicate === true);

  const focusList = (await req('GET', '/api/focus')).data;
  ok('可以读到最近的专注记录', focusList.sessions.some((s) => s.id === focusSession.id));
  ok('今天的统计包含这一轮', focusList.stats.todaySessions >= 1, `实际 ${focusList.stats.todaySessions}`);
  const todayRow = focusList.stats.byDay.find((d) => d.date === focusList.stats.todayKey);
  ok('★ 按天统计会给出当天的内容分布',
    Boolean(todayRow && todayRow.content.some((c) => c.title === '背 50 个单词' && c.seconds >= 1500)));
  const contentRow = focusList.stats.byContent.find((c) => c.title === '背 50 个单词');
  ok('★ 按内容累计包含实际专注秒数', Boolean(contentRow && contentRow.seconds >= 1500 && contentRow.sessions >= 1));
  ok('专注统计提供昨天与本周的数据字段',
    typeof focusList.stats.yesterdaySeconds === 'number' && Array.isArray(focusList.stats.byContent));

  const yEnd = new Date();
  yEnd.setDate(yEnd.getDate() - 1);
  yEnd.setHours(20, 0, 0, 0);
  const yTitle = `自测·昨天背单词 ${Date.now()}`;
  const yFocus = await req('POST', '/api/focus/sessions', {
    clientToken: `selftest-focus-yesterday-${Date.now()}`,
    mode: 'focus',
    title: yTitle,
    minutes: 15,
    actualSeconds: 900,
    startedAt: new Date(yEnd.getTime() - 15 * 60 * 1000).toISOString(),
    endedAt: yEnd.toISOString(),
  });
  ok('记录一轮昨天的专注 → 201', yFocus.status === 201, `实际 ${yFocus.status}`);
  yesterdayFocusSessionId = yFocus.data.session.id;
  const withYesterday = (await req('GET', '/api/focus')).data;
  ok('★ 昨天完成的专注今天仍然统计得到',
    withYesterday.stats.yesterdaySessions >= 1 && withYesterday.stats.yesterdaySeconds >= 900);
  const yContent = withYesterday.stats.byContent.find((c) => c.title === yTitle);
  ok('★ 昨天专注的内容进入累计列表',
    Boolean(yContent && yContent.seconds >= 900 && yContent.sessions >= 1));

  // ---------------------------------------------------------------- 专注内容归类
  console.log('\n【专注 · 把相似写法归类】');
  const selfMerge = await req('POST', '/api/focus/content/merge', {
    from: '自测归类·单词', to: '自测归类·单词',
  });
  ok('把一项归到它自己 → 400', selfMerge.status === 400, `实际 ${selfMerge.status}`);

  const mergeNow = new Date();
  const mergeA = await req('POST', '/api/focus/sessions', {
    clientToken: `selftest-merge-a-${Date.now()}`,
    mode: 'focus',
    title: '自测归类·单词',
    minutes: 10,
    actualSeconds: 600,
    startedAt: new Date(mergeNow.getTime() - 10 * 60 * 1000).toISOString(),
    endedAt: mergeNow.toISOString(),
  });
  const mergeB = await req('POST', '/api/focus/sessions', {
    clientToken: `selftest-merge-b-${Date.now()}`,
    mode: 'focus',
    title: '自测归类·背单词',
    minutes: 5,
    actualSeconds: 300,
    startedAt: new Date(mergeNow.getTime() - 5 * 60 * 1000).toISOString(),
    endedAt: mergeNow.toISOString(),
  });
  extraFocusSessionIds.push(mergeA.data.session.id, mergeB.data.session.id);

  const merged = await req('POST', '/api/focus/content/merge', {
    from: '自测归类·单词', to: '自测归类·背单词',
  });
  ok('可以把一种写法归到另一项 → 200', merged.status === 200, `实际 ${merged.status}`);
  ok('接口返回归类后的目标标题',
    merged.data.alias && merged.data.alias.from === '自测归类·单词' && merged.data.alias.to === '自测归类·背单词');

  const mergedStats = (await req('GET', '/api/focus')).data;
  const mergedRow = mergedStats.stats.byContent.find((c) => c.title === '自测归类·背单词');
  const sourceRow = mergedStats.stats.byContent.find((c) => c.title === '自测归类·单词');
  ok('★ 归类后时长汇总只剩一行',
    Boolean(mergedRow) && mergedRow.seconds >= 900 && mergedRow.sessions >= 2 && !sourceRow,
    mergedRow ? `${mergedRow.seconds}s / ${mergedRow.sessions} 次` : '没有目标行');
  ok('★ 归类不改写原始专注记录',
    mergedStats.sessions.some((s) => s.title === '自测归类·单词')
    && mergedStats.sessions.some((s) => s.title === '自测归类·背单词'));
  ok('归类关系随统计一起返回',
    mergedStats.contentAliases.some((a) => a.from === '自测归类·单词' && a.to === '自测归类·背单词'));
  const mergedToday = mergedStats.stats.byDay.find((d) => d.date === mergedStats.stats.todayKey);
  ok('★ 当天的内容分布也合并成一项',
    Boolean(mergedToday && mergedToday.content.some((c) => c.title === '自测归类·背单词' && c.seconds >= 900)));

  const unmerged = await req('POST', '/api/focus/content/unmerge', { from: '自测归类·单词' });
  ok('可以取消归类 → 200', unmerged.status === 200, `实际 ${unmerged.status}`);
  const unmergedStats = (await req('GET', '/api/focus')).data;
  ok('★ 取消归类后恢复成两行',
    Boolean(unmergedStats.stats.byContent.find((c) => c.title === '自测归类·单词'))
    && Boolean(unmergedStats.stats.byContent.find((c) => c.title === '自测归类·背单词')));

  const statsBeforeUndo = (await req('GET', '/api/focus')).data;
  const fUndo = await req('POST', `/api/focus/sessions/${focusSession.id}/undo`, {});
  ok('★ 撤销后待办回到原来的状态',
    fUndo.data.task.status === 'todo' && fUndo.data.task.completedAt === null);
  const focusAfterUndo = (await req('GET', '/api/focus')).data;
  ok('★ 撤销掉的一轮不再计入统计',
    focusAfterUndo.stats.todaySessions === statsBeforeUndo.stats.todaySessions - 1);
  ok('★ 撤销后也不再出现在按内容累计里',
    !focusAfterUndo.stats.byContent.some((c) => c.title === '背 50 个单词'));
  const fUndo2 = await req('POST', `/api/focus/sessions/${focusSession.id}/undo`, {});
  ok('重复撤销是安全的', fUndo2.data.alreadyUndone === true);

  // ---------------------------------------------------------------- AI 学习上下文（阶段 1）
  console.log('\n【AI 学习上下文 · 只读构建】');
  let ctxConv;
  {
    const fakeNow = new Date();
    const dayAgo = (n) => {
      const d = new Date(fakeNow);
      d.setDate(d.getDate() - n);
      return d.toISOString();
    };
    const fakeSessions = [
      { mode: 'focus', title: '窗口测试·近', actualSeconds: 600, endedAt: dayAgo(1) },
      { mode: 'focus', title: '窗口测试·远', actualSeconds: 1200, endedAt: dayAgo(20) },
    ];
    const stats7 = focusStats(fakeSessions, {}, { days: 7, now: fakeNow });
    const stats30 = focusStats(fakeSessions, {}, { days: 30, now: fakeNow });
    ok('专注统计支持 7 天与 30 天窗口',
      stats7.byDay.length === 7 && stats30.byDay.length === 30
      && stats7.windowSeconds === 600 && stats30.windowSeconds === 1800,
      `${stats7.windowSeconds}s / ${stats30.windowSeconds}s`);
    ok('★ 30 天窗口不改变 week* 的最近 7 天含义',
      stats30.weekSeconds === stats7.windowSeconds && stats30.weekMinutes === 10);

    const ctxTask = (await req('POST', '/api/tasks', {
      title: '上下文·关联待办', projectId: project.id, courseId: course.id, scheduledDate: today(),
    })).data.task;
    const ctxDoneTask = (await req('POST', '/api/tasks', {
      title: '上下文·已完成待办', projectId: project.id, status: 'done', scheduledDate: today(),
    })).data.task;
    ok('准备好关联项目与课程的任务', ctxTask.projectId === project.id && ctxTask.courseId === course.id);
    ok('完成的任务带有完成时间', Boolean(ctxDoneTask.completedAt));

    const now = new Date();
    const ctxFocus = await req('POST', '/api/focus/sessions', {
      clientToken: `selftest-context-${Date.now()}`,
      mode: 'focus',
      title: '上下文·高数',
      taskId: ctxTask.id,
      minutes: 10,
      actualSeconds: 600,
      startedAt: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
      endedAt: now.toISOString(),
      completeTask: false,
    });
    ok('记录一轮可关联到项目的专注 → 201', ctxFocus.status === 201, `实际 ${ctxFocus.status}`);
    extraFocusSessionIds.push(ctxFocus.data.session.id);

    const oldEnd = new Date();
    oldEnd.setDate(oldEnd.getDate() - 20);
    oldEnd.setHours(20, 0, 0, 0);
    const ctxOldFocus = await req('POST', '/api/focus/sessions', {
      clientToken: `selftest-context-old-${Date.now()}`,
      mode: 'focus',
      title: '上下文·旧记录',
      taskId: ctxTask.id,
      minutes: 20,
      actualSeconds: 1200,
      startedAt: new Date(oldEnd.getTime() - 20 * 60 * 1000).toISOString(),
      endedAt: oldEnd.toISOString(),
      completeTask: false,
    });
    ok('记录一轮 20 天前的专注 → 201', ctxOldFocus.status === 201, `实际 ${ctxOldFocus.status}`);
    extraFocusSessionIds.push(ctxOldFocus.data.session.id);

    ctxConv = (await req('POST', '/api/conversations', {})).data.conversation;
    const emptyPreview = await req('GET', `/api/conversations/${ctxConv.id}/context`);
    ok('上下文预览接口 → 200', emptyPreview.status === 200, `实际 ${emptyPreview.status}`);
    const empty = emptyPreview.data.context;
    ok('★ 默认不引用任何学习数据',
      empty.selected === false && empty.facts.project === null
      && empty.facts.focus === null && empty.facts.tasks === null && empty.sources.length === 0);
    ok('不选数据时明确说没有可引用记录', empty.text.includes('还没有选择学习数据'));
    ok('★ 知识点 / 错题 / 复习进度明确标注不可用',
      empty.available.knowledge === false && empty.available.wrongQuestions === false
      && empty.available.review === false
      && empty.unknowns.join('').includes('知识点')
      && empty.unknowns.join('').includes('错题'));

    const savedCtx = await req('PATCH', `/api/conversations/${ctxConv.id}`, {
      context: { projectId: project.id, windowDays: 7, includeTasks: true },
    });
    ok('可以保存学习数据选择',
      savedCtx.status === 200
      && savedCtx.data.conversation.context.projectId === project.id
      && savedCtx.data.conversation.context.windowDays === 7
      && savedCtx.data.conversation.context.includeTasks === true
      && savedCtx.data.conversation.context.includeKnowledge === false);

    ok('14 天等非法窗口被拒绝',
      (await req('PATCH', `/api/conversations/${ctxConv.id}`, {
        context: { windowDays: 14 },
      })).status === 400);
    ok('★ 知识点和错题开关被拒绝',
      (await req('PATCH', `/api/conversations/${ctxConv.id}`, {
        context: { windowDays: 7, includeKnowledge: true },
      })).status === 400);
    ok('非法项目标识被拒绝',
      (await req('PATCH', `/api/conversations/${ctxConv.id}`, {
        context: { projectId: '../secret', windowDays: 7 },
      })).status === 400);
    const stillSaved = (await req('GET', `/api/conversations/${ctxConv.id}`)).data.conversation;
    ok('★ 非法选择不会覆盖已保存的范围', stillSaved.context.windowDays === 7);

    const preview = await req('GET', `/api/conversations/${ctxConv.id}/context`);
    const built = preview.data.context;
    ok('预览沿用对话里保存的选择',
      built.selection.projectId === project.id && built.selection.windowDays === 7
      && built.selection.includeTasks === true);
    ok('项目事实来自真实课程记录',
      built.facts.project.title === project.title
      && built.facts.project.courses.some((c) => c.title === '高数基础班' && c.totalEpisodes === 20));
    ok('★ 最近 7 天专注包含本次记录',
      built.facts.focus.latestAt === ctxFocus.data.session.endedAt
      && built.facts.focus.totalSeconds >= 600);
    ok('★ 能通过待办关联算出项目内的专注',
      built.facts.focus.linkedToProject.sessions === 1
      && built.facts.focus.linkedToProject.minutes >= 10,
      JSON.stringify(built.facts.focus.linkedToProject));
    ok('待办完成情况读到今天与最近完成的记录',
      built.facts.tasks.today.total >= 1
      && Boolean(built.facts.tasks.windowDone)
      && built.facts.tasks.windowDone.count >= 1);
    ok('上下文文本写清来源、范围与统计',
      built.text.includes(project.title)
      && built.text.includes('最近 7 天专注')
      && built.text.includes('待办')
      && built.sources.some((s) => s.id === 'focus'));
    ok('★ 预览接口本身不写入数据',
      (await req('GET', `/api/conversations/${ctxConv.id}`)).data.conversation.messages.length === 0);

    const wide = await req(
      'GET',
      `/api/conversations/${ctxConv.id}/context?projectId=${project.id}&windowDays=30`
    );
    ok('★ 30 天窗口包含 20 天前的记录',
      wide.status === 200
      && wide.data.context.facts.focus.windowDays === 30
      && wide.data.context.facts.focus.linkedToProject.sessions >= 2
      && wide.data.context.facts.focus.from < built.facts.focus.from,
      JSON.stringify(wide.data.context.facts.focus && wide.data.context.facts.focus.linkedToProject));
    ok('★ 预览查询不会改写已保存的选择',
      (await req('GET', `/api/conversations/${ctxConv.id}`)).data.conversation.context.windowDays === 7);

    const missingProject = await req('GET', `/api/conversations/${ctxConv.id}/context?projectId=proj-doesnotexist&windowDays=7`);
    ok('★ 所选项目不存在时降级并提示',
      missingProject.status === 200
      && missingProject.data.context.facts.project === null
      && missingProject.data.context.warnings.join('').includes('已不存在'));

    const future = await contextLib.buildContext(
      { windowDays: 7, includeTasks: true },
      { now: new Date('2040-01-01T12:00:00') }
    );
    ok('★ 没有记录时明确说不能据此判断',
      future.facts.focus.sessionCount === 0
      && future.facts.tasks.today.total === 0
      && future.caveats.length >= 2
      && future.caveats.join('').includes('不能据此判断'));
    ok('★ 不把「没有记录」写成「没有学习」', !future.text.includes('没有学习'));

    const snapshot = contextLib.snapshotContext(built);
    ok('★ 历史快照只保留来源、范围与统计',
      snapshot
      && !('text' in snapshot)
      && !('facts' in snapshot)
      && snapshot.selection.projectId === project.id
      && snapshot.sources.length >= 1
      && typeof snapshot.counts.focusSessions === 'number',
      JSON.stringify(snapshot && Object.keys(snapshot)));
    ok('快照不包含课程标题等完整摘要',
      !JSON.stringify(snapshot).includes('高数基础班'));
  }

  // ---------------------------------------------------------------- AI 学习上下文（阶段 2A）
  console.log('\n【AI 学习上下文 · 接入 Ollama（阶段 2A）】');
  {
    const builtForAi = (await req('GET', `/api/conversations/${ctxConv.id}/context`)).data.context;
    const freshConv = () => ({ id: 'selftest-context', messages: [], asked: [] });

    const focusAsk = ai.mockRespond(freshConv(), '我最近学了多久？', { context: builtForAi });
    ok('★ 问到学习时长时草稿引用真实专注记录',
      focusAsk.contextUsed === true
      && /专注记录/.test(focusAsk.reply)
      && /(\d+)\s*分钟|(\d+)\s*小时/.test(focusAsk.reply),
      focusAsk.reply);

    const progressAsk = ai.mockRespond(freshConv(), '我的考研数学项目进度到哪了？', { context: builtForAi });
    const realProgress = builtForAi.facts.project.progress;
    ok('★ 问到项目进度时使用真实集数',
      progressAsk.contextUsed === true
      && progressAsk.reply.includes(`${realProgress.percent}%`)
      && progressAsk.reply.includes(String(realProgress.completedEpisodes))
      && progressAsk.reply.includes(String(realProgress.totalEpisodes)),
      progressAsk.reply);
    ok('★ 只是问进度时不自动生成方案', progressAsk.proposal === null);

    const taskAsk = ai.mockRespond(freshConv(), '我今天还有哪些待办？', { context: builtForAi });
    ok('★ 问到待办时使用真实任务数量',
      taskAsk.contextUsed === true && /待办今天\s*\d+\s*项/.test(taskAsk.reply),
      taskAsk.reply);

    const vent = ai.mockRespond(freshConv(), '我今天真的好累，什么都不想做。', { context: builtForAi });
    ok('★ 表达疲惫时不强行引用学习数据',
      vent.contextUsed === false && !/系统里的记录/.test(vent.reply) && !vent.reply.includes('62%'),
      vent.reply);
    ok('★ 倾诉时不自动生成方案', vent.proposal === null);

    const planAsk = ai.mockRespond(freshConv(), '帮我规划一下考研数学接下来怎么复习。', { context: builtForAi });
    ok('★ 明确要求规划时才生成方案', Boolean(planAsk.proposal));
    ok('★ 规划时引用真实项目记录',
      planAsk.contextUsed === true && planAsk.reply.includes(`${realProgress.percent}%`), planAsk.reply);

    const noRecord = await contextLib.buildContext(
      { projectId: project.id, windowDays: 7, includeTasks: true },
      { now: new Date('2040-01-01T12:00:00') }
    );
    const noRecordAsk = ai.mockRespond(freshConv(), '我最近学了多久？', { context: noRecord });
    ok('★ 没有记录时写成「系统里没有记录」而不是下结论',
      noRecordAsk.reply.includes('系统里没有专注记录')
      && noRecordAsk.reply.includes('这只是没有记录')
      && noRecordAsk.reply.includes('不能说明'),
      noRecordAsk.reply);

    const allowedDraft = {
      reply: '最近 7 天共 20 分钟，项目 50 集已完成 31 集（62%）。',
      contextFactText: '最近 7 天共 20 分钟，项目 50 集已完成 31 集（62%）。',
    };
    ok('★ 事实一致性：没有依据的数字会被拒绝',
      ai.checkFactConsistency('你最近 3 天学了 5 小时，完成了 40 集。', {
        context: builtForAi, draft: allowedDraft,
      }).ok === false);
    ok('★ 事实一致性：普通语言里的数字不会被误判',
      ai.checkFactConsistency('这件事分成 2 步，先深呼吸 3 次。', {
        context: builtForAi, draft: allowedDraft,
      }).ok === true);
    ok('★ 事实一致性：草稿里的事实不能被漏掉',
      ai.checkFactCoverage('最近 7 天共 20 分钟。', allowedDraft.contextFactText).ok === false);
    ok('★ 改写质量：混入英文、空泛安慰或提示词回显会被拒绝',
      ai.replyIsUnusable('今天的 you 基本上是休息了。', '我今天好累。', { sourceText: '嗯，我在。', intent: 'pour' })
      && ai.replyIsUnusable('多休息一下，别太逼自己，加油！', '我今天好累。', { sourceText: '嗯，我在。', intent: 'pour' })
      && ai.replyIsUnusable('系统记录改写为一句自然的中文回复：', '进度到哪了？', { rewriteWithContext: true }));
    ok('★ 改写质量：正常的接住与事实改写可以通过',
      !ai.replyIsUnusable('嗯，我在。先不用急着做什么，想说就说。', '我今天好累。', { sourceText: '嗯，我在。', intent: 'pour' })
      && !ai.replyIsUnusable('数学共 46 集，已完成 19 集，完成率 41%。', '进度到哪了？', { rewriteWithContext: true }));

    const prompt = ai.buildOllamaPrompt({
      userText: '我的考研数学项目进度到哪了？', draft: progressAsk, context: builtForAi,
    });
    ok('★ Ollama 实际收到 Context Builder 的上下文',
      prompt.rewriteWithContext === true
      && prompt.contextText.length > 0
      && prompt.user.includes('系统记录')
      && prompt.user.includes(String(realProgress.percent))
      && prompt.system.includes('不能新增数字')
      && prompt.system.includes('不能说成「你没有学习」'));

    // 走真实 API：服务端每轮构建上下文，助手消息只保存快照
    const focusMsg = await req('POST', `/api/conversations/${ctxConv.id}/messages`, {
      content: '我最近学了多久？',
    });
    ok('★ 对话接口把真实上下文传给规则引擎',
      focusMsg.status === 201
      && focusMsg.data.message.provider === 'mock'
      && /专注记录/.test(focusMsg.data.message.content),
      focusMsg.data.message.content);
    const savedSnapshot = focusMsg.data.message.context;
    ok('★ 助手消息只保存上下文快照，不保存完整摘要',
      savedSnapshot
      && !('text' in savedSnapshot)
      && !('facts' in savedSnapshot)
      && savedSnapshot.selection.projectId === project.id
      && savedSnapshot.counts.focusSessions >= 1
      && !JSON.stringify(savedSnapshot).includes('高数基础班'),
      JSON.stringify(savedSnapshot && Object.keys(savedSnapshot)));

    const ventMsg = await req('POST', `/api/conversations/${ctxConv.id}/messages`, {
      content: '我今天真的好累，什么都不想做。',
    });
    ok('★ 通过 API 表达疲惫时也不会被数据打断',
      !/系统里的记录/.test(ventMsg.data.message.content),
      ventMsg.data.message.content);

    const planMsg = await req('POST', `/api/conversations/${ctxConv.id}/messages`, {
      content: '帮我规划一下考研数学接下来怎么复习。',
    });
    ok('★ 通过 API 明确请求计划时才出现方案',
      planMsg.data.conversation.proposals.length >= 1
      && /系统里的记录/.test(planMsg.data.message.content),
      planMsg.data.message.content);

    const fallback = await ai.respond({
      conversation: freshConv(),
      userText: '我最近学了多久？',
      settings: { aiProvider: 'ollama', ollamaUrl: '', ollamaModel: '' },
      context: builtForAi,
    });
    ok('★ Ollama 不可用时回退到规则引擎草稿',
      fallback.provider === 'mock'
      && fallback.contextUsed === true
      && /专注记录/.test(fallback.reply)
      && fallback.warning.includes('Ollama')
      && fallback.warning.includes('规则引擎'),
      fallback.warning);

    const originalFetch = global.fetch;
    try {
      global.fetch = async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          message: { content: '你最近 3 天学了 5 小时，项目也完成了 40 集。' },
          model: 'selftest-fake',
        }),
      });
      const badModel = await ai.respond({
        conversation: freshConv(),
        userText: '我最近学了多久？',
        settings: { aiProvider: 'ollama', ollamaUrl: 'http://selftest.invalid', ollamaModel: 'fake' },
        context: builtForAi,
      });
      ok('★ 模型改写改坏学习数据时回退到规则引擎',
        badModel.provider === 'mock'
        && badModel.warning.includes('改动了学习数据')
        && /专注记录/.test(badModel.reply),
        badModel.warning);
    } finally {
      global.fetch = originalFetch;
    }
  }

  // ---------------------------------------------------------------- 桌面浮窗共用计时
  console.log('\n【桌面浮窗 · 共用计时】');
  if (!canTestActive) {
    console.log('  跳过：现在有一轮专注正在进行，测试不去打扰它。');
  } else {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const activeTask = (await req('POST', '/api/tasks', { title: '浮窗里勾选的待办' })).data.task;
    const t1 = `selftest-active-${Date.now()}`;
    activeTokens.add(t1);
    const start1 = await req('POST', '/api/focus/active', {
      clientToken: t1, mode: 'focus', taskId: activeTask.id, title: '浮窗专注', minutes: 25, completeTask: true,
    });
    ok('可以开始一轮共享计时 → 201', start1.status === 201, `实际 ${start1.status}`);
    ok('计时带着客户端 token，浏览器与浮窗能对上',
      Boolean(start1.data.active && start1.data.active.token === t1));
    ok('刚开始时剩余时间是完整的',
      start1.data.active.remainingMs > 24 * 60 * 1000, String(start1.data.active.remainingMs));
    ok('另一个窗口能读到同一轮计时',
      (await req('GET', '/api/focus/active')).data.active.token === t1);
    ok('已有计时时再开一轮 → 409',
      (await req('POST', '/api/focus/active', { clientToken: `selftest-other-${Date.now()}`, minutes: 25 })).status === 409);

    const paused = await req('PATCH', '/api/focus/active', { action: 'pause' });
    ok('浮窗可以暂停计时', paused.data.active.paused === true);
    const pausedLeft = paused.data.active.pausedRemainingMs;
    await sleep(300);
    const stillPaused = (await req('GET', '/api/focus/active')).data.active;
    ok('暂停后剩余时间不再走', stillPaused && stillPaused.pausedRemainingMs === pausedLeft);
    const resumed = await req('PATCH', '/api/focus/active', { action: 'resume' });
    ok('可以继续计时', resumed.data.active.paused === false);

    const finished = await req('POST', '/api/focus/active/finish', { clientToken: t1 });
    ok('可以提前结束并记下这一轮',
      finished.status === 200 && Boolean(finished.data.session) && finished.data.active === null);
    extraFocusSessionIds.push(finished.data.session.id);
    ok('★ 提前结束也勾选关联待办', finished.data.task && finished.data.task.status === 'done');
    ok('结束后的会话能算出实际专注秒数',
      finished.data.session.actualSeconds >= 1 && finished.data.session.actualSeconds <= 1500,
      String(finished.data.session.actualSeconds));
    const dupFinish = await req('POST', '/api/focus/active/finish', { clientToken: t1 });
    ok('重复结束不会产生第二条记录',
      dupFinish.data.duplicate === true && dupFinish.data.session.id === finished.data.session.id);
    const finishUndo = await req('POST', `/api/focus/sessions/${finished.data.session.id}/undo`, {});
    ok('结束后的待办可以撤销回未完成', finishUndo.data.task.status === 'todo');

    const naturalTask = (await req('POST', '/api/tasks', { title: '自然到点的待办' })).data.task;
    const t2 = `selftest-natural-${Date.now()}`;
    activeTokens.add(t2);
    const naturalStart = await req('POST', '/api/focus/active', {
      clientToken: t2, taskId: naturalTask.id, title: '到点自动结束', minutes: 1, remainingMs: 1000, completeTask: true,
    });
    ok('可以用剩余时间接上一轮离线计时',
      naturalStart.status === 201 && naturalStart.data.active.remainingMs <= 1000);
    await sleep(1300);
    const natural = await req('GET', '/api/focus/active');
    // 自测与正在使用的网页共用一份数据：到点后可能是另一个窗口先补记了自然结束，
    // 这时本进程没有 justFinished，但这一轮同样已经正确地结掉。
    let naturalSession = natural.data.justFinished ? natural.data.justFinished.session : null;
    if (!naturalSession) {
      const list = await req('GET', '/api/focus');
      naturalSession = list.data.sessions.find((s) => s.clientToken === t2) || null;
    }
    ok('★ 到点后任何窗口来问，都会自动结掉这一轮',
      natural.data.active === null && Boolean(naturalSession));
    const naturalTaskNow = (await req('GET', '/api/bootstrap')).data.tasks.find((x) => x.id === naturalTask.id);
    ok('★ 自然结束同样勾选待办', Boolean(naturalTaskNow) && naturalTaskNow.status === 'done');
    extraFocusSessionIds.push(naturalSession.id);
    const naturalUndo = await req('POST', `/api/focus/sessions/${naturalSession.id}/undo`, {});
    ok('自然结束也可以撤销勾选', naturalUndo.data.task && naturalUndo.data.task.status === 'todo');

    const t3 = `selftest-cancel-${Date.now()}`;
    activeTokens.add(t3);
    ok('可以开始一轮准备放弃的计时', (await req('POST', '/api/focus/active', {
      clientToken: t3, title: '要放弃的专注', minutes: 25,
    })).status === 201);
    const cancelled = await req('POST', '/api/focus/active/cancel', {});
    ok('放弃计时后没有活动记录', cancelled.data.ok === true && cancelled.data.active === null);
    const afterCancel = await req('GET', '/api/focus/active');
    ok('★ 放弃留下取消标记，别的窗口不会把它接回来',
      afterCancel.data.active === null && afterCancel.data.cancelledToken === t3);
    ok('放弃不会产生专注记录',
      !(await req('GET', '/api/focus')).data.sessions.some((s) => s.clientToken === t3));

    ok('给不存在的待办开计时 → 400', (await req('POST', '/api/focus/active', {
      mode: 'focus', taskId: 'no-such-task', minutes: 25,
    })).status === 400);
    ok('没有计时时结束 → 404', (await req('POST', '/api/focus/active/finish', {
      clientToken: 'no-such-token',
    })).status === 404);
  }

  // ---------------------------------------------------------------- 教材
  console.log('\n【教材精读】');
  const fill = (s) => String(s).repeat(3);
  const outlineItems = [
    { title: '第1章 直流电路', pageStart: 1, level: 0 },
    { title: '1.1 欧姆定律', pageStart: 2, level: 1 },
    { title: '1.2 串联与并联', pageStart: 4, level: 1 },
    { title: '第2章 计算机网络', pageStart: 6, level: 0 },
    { title: '2.1 TCP 三次握手', pageStart: 7, level: 1 },
  ];
  const pageTexts = [
    [1, '第1章 直流电路\n本章从电压、电流和电阻三个基本量开始，讨论直流电路的分析方法。'],
    [2, '1.1 欧姆定律\n在同一电路中，导体中的电流跟导体两端的电压成正比，跟导体的电阻成反比。欧姆定律把所有线性电阻电路连接了起来。'],
    [3, '使用欧姆定律时要注意电压与电流的参考方向。方向选得不同，式子前面的正负号也要跟着改变。'],
    [4, '1.2 串联与并联\n串联电路中电流处处相等，总电阻等于各电阻之和。并联电路中各支路电压相同，总电阻的倒数等于各支路电阻倒数之和。'],
    [5, '分析串并联电路时，先判断电流有几条路径，再决定用分压还是分流。'],
    [6, '第2章 计算机网络\n计算机网络把分布在不同地点的计算机连接起来，交换数据与资源共享。'],
    [7, '2.1 TCP 三次握手\nTCP 建立连接需要三次握手：客户端发送 SYN，服务器回复 SYN + ACK，客户端再发送 ACK。三次握手确认了双方的发送与接收能力。'],
    [8, '连接建立之后，TCP 用序号、确认和重传保证数据可靠、有序地到达。'],
  ].map(([page, text]) => ({ page, text: fill(text) }));
  const imported = await req('POST', '/api/textbooks/import', {
    title: '测试教材：电路与网络',
    fileName: 'selftest-textbook.pdf',
    fileSize: 0,
    pageCount: 8,
    outlineItems,
    pages: pageTexts,
  });
  ok('导入教材（逐页文字 + 书签）→ 201', imported.status === 201, `实际 ${imported.status}`);
  textbookId = imported.data.book.id;

  const analyzed = await req('POST', `/api/textbooks/${textbookId}/analyze`, {});
  ok('整理教材框架 → 200', analyzed.status === 200, `实际 ${analyzed.status}`);
  ok('框架整理完成，状态为可阅读', analyzed.data.book.status === 'ready');
  ok('★ 章节来自 PDF 书签', analyzed.data.book.structureSource === 'bookmarks');
  ok('★ 全书导览的小节数与目录一致',
    String((analyzed.data.book.guide || {}).overview || '').includes('3 个可读小节'));

  const fullBook = (await req('GET', `/api/textbooks/${textbookId}`)).data.book;
  const sections = fullBook.chapters.flatMap((c) => c.sections || []);
  ok('目录整理成章 → 节', fullBook.chapters.length === 2 && sections.length === 3,
    `${fullBook.chapters.length} 章 / ${sections.length} 节`);
  const circuitSection = sections.find((s) => s.title.includes('欧姆定律'));
  const tcpSection = sections.find((s) => s.title.includes('TCP'));
  ok('★ 每章都生成了本章知识地图',
    fullBook.chapters.every((c) => {
      const map = (fullBook.chapterGuides || {})[c.id];
      return map && Array.isArray(map.nodes) && map.nodes.length === c.sections.length;
    }));
  ok('★ 知识地图的节点带原文要点',
    Object.values(fullBook.chapterGuides || {}).some((map) => (map.nodes || [])
      .some((node) => Array.isArray(node.points) && node.points.length > 0)));
  ok('★ 电路小节匹配到欧姆定律动画', Boolean(circuitSection && circuitSection.demos.includes('circuit-ohm')));
  ok('★ 网络小节匹配到三次握手动画', Boolean(tcpSection && tcpSection.demos.includes('tcp-handshake')));
  ok('★ 英文 packet 不会被误判成 ACK / TCP',
    !textbook.detectDemos('Packet Switching', 'Packets are forwarded independently by routers.').includes('tcp-handshake'));
  ok('★ 标题命中时，正文泛提不会多配动画',
    textbook.detectDemos('TCP 三次握手', '这一章也会提到分组交换和电路交换。').join(',') === 'tcp-handshake');
  ok('★ 泛泛介绍计算机网络时不会硬塞动画',
    textbook.detectDemos('计算机网络概述', '计算机网络把分布在不同地点的计算机连接起来，用来交换数据。').length === 0);
  ok('★ 正文只出现一两个关键词时不配动画',
    textbook.detectDemos('网络概述', '这一节先介绍分组交换的基本想法，细节留到后面。').length === 0);
  ok('★ 正文强相关时最多配一个动画',
    textbook.detectDemos('数据传输原理',
      '分组交换把报文拆成数据报，路由器采用存储转发，每条数据报独立选择路由。').join(',') === 'packet-switching');

  {
    // 旧教材曾把两个动画挂到同一章几乎每一节；重算后同一章只保留一处正文命中，
    // 而标题明确讲这个概念的多个小节仍然各保留一个。
    const oldBook = {
      guide: { demoNote: '旧说明：29 节都有动画' },
      chapters: [{
        title: '第1章 概述',
        sections: [
          { title: '一、填空题', pageStart: 1, pageEnd: 1, demos: ['packet-switching', 'tcp-handshake'] },
          { title: '二、单选题', pageStart: 2, pageEnd: 2, demos: ['packet-switching', 'tcp-handshake'] },
        ],
      }],
    };
    const demoPages = [
      { page: 1, text: '分组交换把报文拆成数据报，路由器采用存储转发，每条数据报独立选择路由。' },
      { page: 2, text: '分组交换把报文拆成数据报，路由器采用存储转发，每条数据报独立选择路由。' },
    ];
    const refreshed = textbook.refreshDemos(oldBook, demoPages);
    const [first, second] = oldBook.chapters[0].sections;
    ok('★ 旧教材的重复动画会按新规则重算',
      refreshed.changed && first.demos.join(',') === 'packet-switching' && second.demos.length === 0);
    ok('★ 导览里的动画说明同步更新，不再说每节都有', oldBook.guide.demoNote.includes('1 节'));
  }

  {
    const circuitBook = {
      chapters: [{
        title: '第1章 电路',
        sections: [
          { title: '1.1 欧姆定律', pageStart: 1, pageEnd: 1, demos: [] },
          { title: '1.2 串联与并联', pageStart: 2, pageEnd: 2, demos: [] },
        ],
      }],
    };
    textbook.refreshDemos(circuitBook, [
      { page: 1, text: '欧姆定律说明电流与电压、电阻的关系。' },
      { page: 2, text: '串联电路中电流处处相等，并联电路各支路电压相同。' },
    ]);
    ok('标题明确命中的动画不会被同章去重误删',
      circuitBook.chapters[0].sections.every((s) => s.demos.includes('circuit-ohm')));
  }
  ok('教材记录里没有混入 API Key', !JSON.stringify(fullBook).includes('sk-test-not-real'));
  ok('★ PDF 书签不会随教材详情发送到浏览器', !('outlineItems' in fullBook));

  {
    const goodText = '本章讨论直流电路的分析方法。电压、电流和电阻是三个基本量，要学会判断参考方向并正确使用欧姆定律。'.repeat(6);
    const badText = '§±×÷≠≤≥∞∫∑∏√∂αβγδεζηθικλμνξοπρστυφχψω'.repeat(8);
    ok('★ 正常中文文字不会被误判成乱码', ocr.isLikelyGarbled(goodText) === false);
    ok('★ 乱码文字会被识别出来', ocr.isLikelyGarbled(badText) === true);
    ok('★ 整本乱码会被判成 garbled', ocr.assessTextQuality([{ text: badText }, { text: badText }]).quality === 'garbled');
    ok('★ 正常文字层不会被要求 OCR', ocr.assessTextQuality([{ text: goodText }, { text: goodText }]).quality === 'ok');
    ok('★ 分析后会得到全书术语卡',
      Array.isArray(fullBook.terms)
      && fullBook.terms.some((t) => /欧姆定律|电压|TCP/.test(t.term))
      && fullBook.terms.every((t) => t.plain && t.example));

    const guarded = textbook.localLesson({
      bookTitle: '测试教材',
      chapterTitle: '第1章',
      section: { title: '坏页', pageStart: 1, pageEnd: 1 },
      text: badText,
      textInfo: { source: 'none', unreadablePages: [1] },
    });
    ok('★★ 乱码不会进入本地讲义', guarded.blocks.length === 0
      && guarded.keyPoints.length === 0
      && !JSON.stringify(guarded).includes('§±×÷'));
    const guardedChat = textbook.localChatAnswer({
      question: '这一节讲了什么？',
      section: { title: '坏页' },
      lesson: guarded,
      text: badText,
      textInfo: { source: 'none', unreadablePages: [1] },
    });
    ok('★★ 没有可靠原文时问答不引用乱码',
      !guardedChat.includes('§±×÷') && /OCR|乱码|可靠/.test(guardedChat));

    const validated = textbook.validateLesson({
      overview: '这一节讲极限。',
      terms: [{ term: '极限', plain: '无限靠近但可以不到达', example: '像走近一扇门但不跨进去' }],
    }, 'real', 'test-model');
    ok('模型讲义可以带生活化术语卡',
      Boolean(validated) && validated.terms.length === 1 && validated.terms[0].example.includes('门'));

    const tocPage = (page, lines) => ({
      page,
      width: 3000,
      height: 4000,
      passes: {
        'zh-Hans-CN': { lines },
        'en-US': { lines: [] },
        numbers: { lines: [] },
      },
    });
    const line = (text, x, y) => ({ text, x, y, w: 420, h: 40 });
    const realToc = tocPage(1, [
      line('目 录', 1200, 200),
      line('第 1 章 电路', 600, 500),
      line('1.1 电压与电流', 700, 700),
      line('20', 2400, 700),
      line('1.2 电阻与欧姆定律', 700, 840),
      line('26', 2400, 840),
      line('1.3 串联与并联', 700, 980),
      line('32', 2400, 980),
      line('第 2 章 网络', 600, 1160),
      line('2.1 分组交换', 700, 1360),
      line('50', 2400, 1360),
      line('2.2 TCP 三次握手', 700, 1500),
      line('56', 2400, 1500),
    ]);
    const exerciseToc = tocPage(2, [
      line('配套习题和解析', 1100, 180),
      line('第1章 概述', 600, 360),
      line('一、填空题', 600, 520),
      line('1', 420, 700),
      line('网络由若干节点和连接这些节点的（链路）组成，而互联网由若干网络组成', 700, 700),
      line('1', 420, 830),
      line('当今世界上最大的互联网是（因特网）协议族作为通信规则', 700, 830),
      line('1', 420, 960),
      line('时延是计算机网络的主要性能指标之一，包括发送时延、排队时延', 700, 960),
      line('1', 420, 1090),
      line('按网络的覆盖范围分类，计算机网络可分为广域网、城域网', 700, 1090),
    ]);
    const realParsed = ocrToc.parseToc([realToc], { pageCount: 100 });
    ok('★ 真实目录页能被 OCR 还原成章节', realParsed.ok === true
      && realParsed.chapters.length === 2
      && realParsed.chapters[0].sections.length === 3, JSON.stringify(realParsed.reason || ''));
    ok('★ 目录页码能换算成 PDF 页序',
      realParsed.ok === true && realParsed.chapters[0].sections[0].pageStart === 21);
    const exerciseParsed = ocrToc.parseToc([exerciseToc], { pageCount: 100 });
    ok('★★ 填空题页不会被当成目录', exerciseParsed.ok === false, exerciseParsed.reason);

    const furniture = [1, 2, 3, 4, 5].map((page) => ({
      page,
      text: `测试教材\n第 ${page} 页正文\n页脚`,
    }));
    const cleanedPages = textbook.stripRunningHeaders(furniture);
    ok('★ 重复页眉页脚不会带进讲义',
      cleanedPages.every((p) => !p.text.includes('测试教材') && !p.text.includes('页脚'))
      && cleanedPages.every((p) => p.text.includes('页正文')));
    ok('页数太少时不猜页眉', textbook.stripRunningHeaders(furniture.slice(0, 3))[0].text.includes('测试教材'));
  }

  const sectionPayload = await req('GET', `/api/textbooks/${textbookId}/sections/${circuitSection.id}`);
  ok('可以读到这一节的原文', sectionPayload.status === 200
    && sectionPayload.data.text.includes('欧姆定律'));
  ok('★ 原文载荷带文字来源信息',
    sectionPayload.data.textInfo.source === 'pdf' && sectionPayload.data.textInfo.usable === true);
  ok('★ 本节命中术语卡',
    (sectionPayload.data.terms || []).some((t) => t.term === '欧姆定律'));

  const explained = await req('POST', `/api/textbooks/${textbookId}/sections/${circuitSection.id}/explain`, {});
  ok('按需生成一节讲义 → 200', explained.status === 200, `实际 ${explained.status}`);
  ok('★ 本地讲义明确标注来源，不冒充模型',
    explained.data.lesson.provider === 'local');
  ok('★ 讲义记录了文字来源', explained.data.lesson.textSource === 'pdf');
  ok('讲义包含要点或正文小节',
    (explained.data.lesson.keyPoints || []).length > 0 || (explained.data.lesson.blocks || []).length > 0);
  ok('★ 讲义交代这一节在整章里的位置',
    String(explained.data.lesson.position || '').includes('串联与并联')
    && !String(explained.data.lesson.position || '').includes('undefined'));
  ok('★ 讲义按脉络分步，而不是并列清单',
    Array.isArray(explained.data.lesson.thread)
    && explained.data.lesson.thread.length >= 1
    && explained.data.lesson.thread.every((step) => step.title && step.body));
  ok('★ 本节载荷带上本章知识地图',
    Boolean(sectionPayload.data.chapterGuide && sectionPayload.data.chapterGuide.nodes.length));

  const diagram = await req('POST', `/api/textbooks/${textbookId}/sections/${circuitSection.id}/diagram`, {
    question: '欧姆定律的推导过程是怎样的？',
  });
  ok('教材概念图解 → 200', diagram.status === 200, `实际 ${diagram.status}`);
  ok('★ 图解把问题拆成步骤并标注来源',
    diagram.data.diagram.provider === 'local'
    && diagram.data.diagram.title.includes('欧姆定律')
    && diagram.data.diagram.steps.length >= 1
    && diagram.data.diagram.steps.every((step) => step.label));

  const explainedAgain = await req('POST', `/api/textbooks/${textbookId}/sections/${circuitSection.id}/explain`, {});
  ok('讲义已缓存时不会重复调用模型',
    explainedAgain.data.cached === true
    && explainedAgain.data.lesson.generatedAt === explained.data.lesson.generatedAt);

  const textbookChat = await req('POST', `/api/textbooks/${textbookId}/sections/${circuitSection.id}/chat`, {
    question: '欧姆定律里的电压和电流是什么关系？',
  });
  ok('教材内问答 → 201', textbookChat.status === 201, `实际 ${textbookChat.status}`);
  ok('问答返回了实质内容', String(textbookChat.data.answer.content || '').length > 10);
  ok('问答历史被保存', Array.isArray(textbookChat.data.chat) && textbookChat.data.chat.length === 2);

  const marked = await req('PATCH', `/api/textbooks/${textbookId}/sections/${circuitSection.id}`, { done: true });
  ok('可以把一节标记为已读',
    marked.status === 200 && marked.data.section.done === true && marked.data.book.progress.done === 1);

  // ---------------------------------------------------------------- 8.3 AI 对话
  console.log('\n【8.3 AI 对话】');
  const conv = (await req('POST', '/api/conversations', {})).data.conversation;
  ok('创建对话 → 201', Boolean(conv.id));

  const m1 = await req('POST', `/api/conversations/${conv.id}/messages`, {
    content: '我最近很焦虑考研，不知道怎么开始，学校还没选好。',
  });
  ok('可以自由输入自然语言（不需要先选情绪类型）', m1.status === 201, `实际 ${m1.status}`);
  const conv1 = m1.data.conversation;
  ok('对话里有用户与助手各一条', conv1.messages.length === 2);
  ok('助手回复明确标注来自模拟引擎', conv1.messages[1].provider === 'mock');
  ok('助手回复不是固定话术（有实质内容）', conv1.messages[1].content.length > 10);
  ok('给出了问题梳理卡', Boolean(conv1.messages[1].problemCard));
  ok('梳理卡只含实际内容（不是固定表单）',
    Boolean((conv1.messages[1].problemCard.unknowns || []).length
      || (conv1.messages[1].problemCard.expressed || []).length));
  ok('★ 信息不足时先问一个关键问题', /哪几科/.test(conv1.messages[1].content), conv1.messages[1].content);
  ok('★ 这一轮不擅自生成行动方案', conv1.proposals.length === 0, `proposals=${conv1.proposals.length}`);
  ok('对话标题取自首条消息', conv1.title.includes('考研'));

  const m2 = await req('POST', `/api/conversations/${conv.id}/messages`, {
    content: '我现在只准备数学一和英语一，专业课还没定。',
  });
  const conv2 = m2.data.conversation;
  ok('可以连续发送多轮消息', conv2.messages.length === 4);
  ok('★ 不重复问同一个问题', !/你现在主要准备哪几科/.test(conv2.messages[3].content), conv2.messages[3].content);

  const prop = conv2.proposals[0];
  ok('★ 信息明确后给出行动方案', Boolean(prop));
  ok('方案状态为待确认', prop.status === 'pending');
  ok('行动数量克制（3–6 条，不是整张打卡表）', prop.actions.length >= 3 && prop.actions.length <= 6, `${prop.actions.length} 条`);

  const actionTitles = prop.actions.map((a) => a.title).join(' ');
  ok('★★ 不擅自生成专业课任务（用户说还没定）', !/专业课/.test(actionTitles), actionTitles);
  ok('★★ 不擅自生成政治任务', !/政治/.test(actionTitles), actionTitles);
  ok('★ 专业课放进「待确认」', prop.pendingItems.join(' ').includes('专业课'), JSON.stringify(prop.pendingItems));
  ok('方案里每条行动都有稳定 id', prop.actions.every((a) => typeof a.id === 'string' && a.id));
  ok('方案里每条行动还没创建任务', prop.actions.every((a) => a.createdTaskId === null));

  console.log('\n【8.3 只想倾诉时】');
  const conv3 = (await req('POST', '/api/conversations', {})).data.conversation;
  const pour = await req('POST', `/api/conversations/${conv3.id}/messages`, {
    content: '我就是很难受，什么都不想做，不想听道理。',
  });
  ok('倾诉时正常回应', pour.status === 201);
  ok('★ 只想倾诉时不强制制定计划', pour.data.conversation.proposals.length === 0,
    `proposals=${pour.data.conversation.proposals.length}`);

  console.log('\n【8.3 用户可以纠正 AI】');
  const cardMsg = conv2.messages[3];
  const corrected = await req('PATCH', `/api/conversations/${conv.id}/messages/${cardMsg.id}`, {
    summary: '我自己改过的概括',
    expressed: ['我怕的是选错学校', '我怕白费一年'],
  });
  ok('可以修改梳理卡 → 200', corrected.status === 200, `实际 ${corrected.status}`);
  const fixedMsg = corrected.data.conversation.messages.find((m) => m.id === cardMsg.id);
  ok('改后的概括被保存', fixedMsg.problemCard.summary === '我自己改过的概括');
  ok('改后的条目被保存', fixedMsg.problemCard.expressed.length === 2);
  ok('标记了「用户改过」', fixedMsg.editedByUser === true);

  // ---------------------------------------------------------------- 8.4 方案 → 任务
  console.log('\n【8.4 行动方案 → 正式任务】');
  const beforeTaskCount = (await req('GET', '/api/tasks')).data.tasks.length;

  const tasksBeforeConfirm = (await req('GET', '/api/tasks')).data.tasks;
  ok('★ 未确认的建议不会进入正式待办',
    !tasksBeforeConfirm.some((t) => t.sourceProposalId === prop.id),
    '未确认就已经有任务了');

  const propEdit = await req('PATCH', `/api/conversations/${conv.id}/proposals/${prop.id}`, {
    actions: [
      { id: prop.actions[0].id, title: '我自己改过的第一条', detail: '按我的说法' },
      { id: prop.actions[1].id, scheduledDate: shift(0) },
    ],
  });
  ok('可以修改建议内容 → 200', propEdit.status === 200, `实际 ${propEdit.status}`);
  const ep = propEdit.data.conversation.proposals.find((p) => p.id === prop.id);
  ok('改后的标题生效', ep.actions[0].title === '我自己改过的第一条');

  const chosen = [ep.actions[0].id, ep.actions[1].id];
  const confirm1 = await req('POST', `/api/conversations/${conv.id}/proposals/${prop.id}/confirm`, {
    actionIds: chosen,
  });
  ok('确认方案 → 200', confirm1.status === 200, `实际 ${confirm1.status}`);
  ok('★ 只创建了选中的那几条', confirm1.data.created.length === 2, `created=${confirm1.data.created.length}`);
  ok('★ 未选中的行动没有生成任务',
    !confirm1.data.created.some((t) => t.title === ep.actions[2].title));

  const createdTasks = confirm1.data.created;
  ok('创建的任务 source 为 ai', createdTasks.every((t) => t.source === 'ai'));
  ok('创建的任务关联了来源方案', createdTasks.every((t) => t.sourceProposalId === prop.id));
  ok('★ 创建的任务能回溯到原对话', createdTasks.every((t) => t.sourceConversationId === conv.id));
  ok('方案状态变为已确认',
    confirm1.data.conversation.proposals.find((p) => p.id === prop.id).status === 'confirmed');

  const tasksAfter = (await req('GET', '/api/tasks')).data.tasks;
  ok('★ 确认后的任务出现在正式待办里',
    tasksAfter.filter((t) => t.sourceProposalId === prop.id).length === 2,
    `实际 ${tasksAfter.filter((t) => t.sourceProposalId === prop.id).length}`);
  ok('任务总数增加了 2', tasksAfter.length === beforeTaskCount + 2, `${beforeTaskCount} → ${tasksAfter.length}`);

  const confirm2 = await req('POST', `/api/conversations/${conv.id}/proposals/${prop.id}/confirm`, {
    actionIds: chosen,
  });
  ok('★ 重复确认不会重复创建任务', confirm2.data.created.length === 0, `created=${confirm2.data.created.length}`);
  ok('★ 第二次确认被如实标记为跳过', confirm2.data.skipped.length === 2, `skipped=${confirm2.data.skipped.length}`);
  const tasksAfter2 = (await req('GET', '/api/tasks')).data.tasks;
  ok('★ 任务总数没有再次增加', tasksAfter2.length === tasksAfter.length, `${tasksAfter.length} → ${tasksAfter2.length}`);

  console.log('\n【8.4 放弃方案】');
  const conv4 = (await req('POST', '/api/conversations', {})).data.conversation;
  await req('POST', `/api/conversations/${conv4.id}/messages`, {
    content: '帮我规划接下来的学习，我要准备作业，明天要交。',
  });
  const conv4b = (await req('GET', `/api/conversations/${conv4.id}`)).data.conversation;
  const prop4 = conv4b.proposals[0];
  ok('作业场景也能给出方案', Boolean(prop4));
  const countBeforeDismiss = (await req('GET', '/api/tasks')).data.tasks.length;
  const dismiss = await req('POST', `/api/conversations/${conv4.id}/proposals/${prop4.id}/dismiss`, {});
  ok('放弃方案 → 200', dismiss.status === 200);
  ok('方案状态变为已放弃',
    dismiss.data.conversation.proposals.find((p) => p.id === prop4.id).status === 'dismissed');
  const countAfterDismiss = (await req('GET', '/api/tasks')).data.tasks.length;
  ok('★ 放弃操作不产生任何正式任务', countAfterDismiss === countBeforeDismiss, `${countBeforeDismiss} → ${countAfterDismiss}`);

  // ---------------------------------------------------------------- 8.5 档案
  console.log('\n【8.5 个人档案】');
  const convMsgCountBefore = (await req('GET', `/api/conversations/${conv.id}`)).data.conversation.messages.length;

  const arc = await req('POST', '/api/archives', {
    title: '考研择校的一次整理',
    content: '这是我从对话里保存下来的摘要。',
    type: 'summary',
    sourceConversationId: conv.id,
  });
  ok('可以主动保存摘要 → 201', arc.status === 201, `实际 ${arc.status}`);
  const archive = arc.data.archive;
  ok('档案记录了来源对话', archive.sourceConversationId === conv.id);
  ok('档案记录了来源类型', archive.origin === 'manual');
  ok('档案有保存时间', Boolean(archive.createdAt));

  const arcEdit = await req('PATCH', `/api/archives/${archive.id}`, {
    title: '改过标题的摘要', content: '改过的内容',
  });
  ok('可以编辑档案标题与内容',
    arcEdit.data.archive.title === '改过标题的摘要' && arcEdit.data.archive.content === '改过的内容');

  const convAfterEdit = (await req('GET', `/api/conversations/${conv.id}`)).data.conversation;
  ok('★★ 修改摘要不影响原始对话', convAfterEdit.messages.length === convMsgCountBefore,
    `${convMsgCountBefore} → ${convAfterEdit.messages.length}`);

  ok('可以列出全部档案', (await req('GET', '/api/archives')).data.archives.some((a) => a.id === archive.id));
  ok('可以按类型筛选档案',
    (await req('GET', '/api/archives?type=thought')).data.archives.every((a) => a.type === 'thought'));

  ok('★ 删档案 → 200', (await req('DELETE', `/api/archives/${archive.id}`)).status === 200);
  ok('★ 删档案不会删掉来源对话', (await req('GET', `/api/conversations/${conv.id}`)).status === 200);

  const conv4msgs = (await req('GET', `/api/conversations/${conv4.id}`)).data.conversation.messages;
  ok('★★ 未经用户确认的对话内容不会自动进入档案',
    conv4msgs.length > 0
    && !(await req('GET', '/api/archives')).data.archives.some((a) => a.sourceConversationId === conv4.id));

  ok('档案能区分类型与来源', before.archives.every((a) =>
    ['thought', 'summary', 'plan'].includes(a.type) && ['manual', 'ai', 'legacy'].includes(a.origin)));

  // ---------------------------------------------------------------- 迁移
  console.log('\n【第一版数据迁移】');
  ok('★ 用户原有记录已迁移为思考档案', userArchives.length >= 1, `legacy 档案 ${userArchives.length} 份`);
  if (userArchives.length) {
    ok('★ 迁移档案标了原记录 id', Boolean(userArchives[0].legacyEntryId));
    ok('★ 迁移档案保留原始记录段', userArchives[0].content.includes('原始记录'));
  }

  // ---------------------------------------------------------------- 外刊阅读
  console.log('\n【外刊阅读】');
  {
    const articleSettingsFile = path.join(db.DATA_DIR, 'settings.json');
    const articleSettingsSnapshot = await fs.readFile(articleSettingsFile, 'utf8').catch(() => null);
    let articleId = null;
    let vocabId = null;
    try {
      // 释义与文章问答必须有真实模型；本地规则引擎应当明确拒绝，而不是编造词典内容
      await req('PATCH', '/api/settings', { aiProvider: 'mock' });

      const articleText = [
        '# The Quiet Power of Doing Less',
        '',
        'Modern life rewards motion. We fill every hour and call it progress.',
        '',
        '## A slower rhythm',
        '',
        'The case for doing less is not laziness. It is attention.',
        '',
        'When we stop rushing, we notice what the work is actually asking for.',
        '',
        'That shift is small, but it changes the day.',
        '',
        '> Less noise, more signal.',
        '',
        '- Protect one unhurried hour',
        '- Finish before adding',
      ].join('\n');

      const created = await req('POST', '/api/articles', {
        text: articleText,
        format: 'md',
        fileName: 'quiet-power.md',
        source: 'The Test Review',
      });
      ok('导入 Markdown 文章 → 201', created.status === 201, `实际 ${created.status}`);
      const article = created.data.article;
      articleId = article.id;
      ok('没有标题时用第一个 Markdown 标题', article.title === 'The Quiet Power of Doing Less', article.title);
      ok('Markdown 标题单独成段', article.paragraphCount >= 8, String(article.paragraphCount));
      ok('列表与引用也被解析成独立段落', article.excerpt.length > 0);

      const list = await req('GET', '/api/articles');
      const summary = list.data.articles.find((a) => a.id === article.id);
      ok('文章列表包含刚导入的文章', Boolean(summary));
      ok('★ 列表不返回正文段落', summary && summary.paragraphs === undefined);
      ok('★ 列表不返回高亮明细', summary && summary.highlights === undefined);
      ok('列表返回摘要、词数与阅读进度',
        Boolean(summary && summary.excerpt && summary.wordCount > 0 && summary.progress));

      const detail = await req('GET', `/api/articles/${article.id}`);
      ok('读取详情 → 200', detail.status === 200);
      ok('详情带正文段落且 id 稳定',
        detail.data.paragraphs[0].id === 'p-1' && detail.data.paragraphs[1].id === 'p-2');
      ok('HTML 标签会被剥掉', !detail.data.paragraphs.some((p) => /<[^>]+>/.test(p.text)));

      const patched = await req('PATCH', `/api/articles/${article.id}`, {
        title: 'Doing Less', tags: ['attention', 'essay'], reader: { fontSize: 99 },
      });
      ok('编辑标题与标签 → 200',
        patched.status === 200
        && patched.data.article.title === 'Doing Less'
        && patched.data.article.tags.includes('attention'));
      ok('字号被限制在 26 以内', patched.data.article.reader.fontSize === 26);
      ok('非法原文链接 → 400',
        (await req('PATCH', `/api/articles/${article.id}`, { url: 'ftp://nope' })).status === 400);

      const paragraphs = detail.data.paragraphs;
      const anchor = paragraphs[3];
      const progress = await req('PATCH', `/api/articles/${article.id}/progress`, {
        paragraphId: anchor.id, ratio: 0.5,
      });
      ok('保存阅读进度 → 200', progress.status === 200);
      ok('★ 阅读百分比由服务端计算',
        progress.data.progress.percent === Math.round(((3 + 0.5) / paragraphs.length) * 100),
        `${progress.data.progress.percent}`);
      ok('不存在的段落不能当阅读位置 → 400',
        (await req('PATCH', `/api/articles/${article.id}/progress`, {
          paragraphId: 'p-nope', ratio: 0.2,
        })).status === 400);

      const finished = await req('POST', `/api/articles/${article.id}/finish`);
      ok('标记整篇文章已读 → 200',
        finished.status === 200 && Boolean(finished.data.finishedAt), `实际 ${finished.status}`);
      const finishedDetail = await req('GET', `/api/articles/${article.id}`);
      ok('重新打开仍显示这篇已读完',
        finishedDetail.data.article.finishedAt === finished.data.finishedAt);
      const finishedList = await req('GET', '/api/articles');
      ok('书架列表带上读完时间',
        finishedList.data.articles.find((a) => a.id === article.id).finishedAt === finished.data.finishedAt);
      const unfinished = await req('DELETE', `/api/articles/${article.id}/finish`);
      ok('可以撤销已读',
        unfinished.status === 200 && unfinished.data.finishedAt === null, `实际 ${unfinished.status}`);

      const target = paragraphs.find((p) => p.kind === 'paragraph');
      const quote = target.text.slice(0, 12);
      const highlight = await req('POST', `/api/articles/${article.id}/highlights`, {
        paragraphId: target.id, start: 0, end: 12, note: '先记一下',
      });
      ok('添加高亮与批注 → 201', highlight.status === 201, `实际 ${highlight.status}`);
      ok('★ 高亮引用直接取自原文', highlight.data.highlight.quote === quote);
      ok('★ 没选颜色时默认黄色', highlight.data.highlight.color === 'yellow');
      ok('越界高亮被拒绝 → 400',
        (await req('POST', `/api/articles/${article.id}/highlights`, {
          paragraphId: target.id, start: 0, end: target.text.length + 10,
        })).status === 400);
      ok('★ 不在白名单里的颜色被拒绝 → 400',
        (await req('PATCH', `/api/articles/${article.id}/highlights/${highlight.data.highlight.id}`, {
          color: 'neon',
        })).status === 400);

      const editedHighlight = await req('PATCH', `/api/articles/${article.id}/highlights/${highlight.data.highlight.id}`, {
        paragraphId: target.id, start: 0, end: 12, note: '改过的批注',
      });
      ok('可以修改批注', editedHighlight.status === 200
        && editedHighlight.data.highlight.note === '改过的批注');

      const recolored = await req('PATCH', `/api/articles/${article.id}/highlights/${highlight.data.highlight.id}`, {
        color: 'blue',
      });
      ok('★ 只改颜色时批注与引用保持不变',
        recolored.status === 200
        && recolored.data.highlight.color === 'blue'
        && recolored.data.highlight.note === '改过的批注'
        && recolored.data.highlight.quote === quote,
        `实际 ${recolored.status}`);
      const recoloredDetail = await req('GET', `/api/articles/${article.id}`);
      ok('★ 重新打开后高亮颜色仍在',
        recoloredDetail.data.article.highlights.find((h) => h.id === highlight.data.highlight.id).color === 'blue');

      const quizSaved = await req('PATCH', `/api/articles/${article.id}/quiz`, {
        questions: [
          {
            stem: 'What is the main claim of the passage?',
            options: [
              { key: 'A', text: 'Rushing makes work better' },
              { key: 'B', text: 'Attention matters more than speed' },
              { key: 'C', text: 'Lists are the best tool' },
            ],
            answer: 'B',
            explanation: '全文把注意力放在速度之前。',
          },
          {
            stem: 'Which sentence is NOT mentioned?',
            options: [
              { key: 'A', text: 'Protect one unhurried hour' },
              { key: 'B', text: 'Finish before adding' },
              { key: 'C', text: 'Wake up before five' },
            ],
          },
        ],
      });
      ok('导入选择题 → 200', quizSaved.status === 200, `实际 ${quizSaved.status}`);
      ok('★ 选择题保存题干、选项、答案与解析',
        quizSaved.data.quiz.questions.length === 2
        && quizSaved.data.quiz.questions[0].options.length === 3
        && quizSaved.data.quiz.questions[0].answer === 'B'
        && quizSaved.data.quiz.questions[0].explanation.includes('注意力'));
      const firstQuestion = quizSaved.data.quiz.questions[0];
      ok('每道题都有稳定 id', /^qz-/.test(firstQuestion.id), firstQuestion.id);
      ok('没有答案的题目也能保存', quizSaved.data.quiz.questions[1].answer === '');

      const quizAnswered = await req('PATCH', `/api/articles/${article.id}/quiz`, {
        questionId: firstQuestion.id, selected: 'a',
      });
      ok('可以保存选择并统一成大写',
        quizAnswered.status === 200 && quizAnswered.data.quiz.questions[0].selected === 'A');
      ok('★ 重新打开文章保留选择',
        (await req('GET', `/api/articles/${article.id}`))
          .data.article.quiz.questions[0].selected === 'A');
      ok('不存在的题目 → 404',
        (await req('PATCH', `/api/articles/${article.id}/quiz`, {
          questionId: 'qz-nope', selected: 'A',
        })).status === 404);
      ok('不存在的选项 → 400',
        (await req('PATCH', `/api/articles/${article.id}/quiz`, {
          questionId: firstQuestion.id, selected: 'H',
        })).status === 400);
      ok('少于两个选项的题目会被拒绝 → 400',
        (await req('PATCH', `/api/articles/${article.id}/quiz`, {
          questions: [{ stem: 'Only one option', options: [{ key: 'A', text: 'one' }] }],
        })).status === 400);
      const quizCleared = await req('DELETE', `/api/articles/${article.id}/quiz`);
      ok('可以清空这组选择题',
        quizCleared.status === 200 && quizCleared.data.quiz === null);
      const quizAgain = await req('PATCH', `/api/articles/${article.id}/quiz`, {
        questions: [{
          stem: 'Kept before replacing the text',
          options: [{ key: 'A', text: 'one' }, { key: 'B', text: 'two' }],
          answer: 'A',
        }],
      });
      ok('清空后可以重新导入', quizAgain.status === 200 && quizAgain.data.quiz.questions.length === 1);

      const lookupMock = await req('POST', `/api/articles/${article.id}/lookup`, {
        selection: { paragraphId: target.id, start: 0, end: 4, mode: 'word' },
      });
      ok('★ 本地规则引擎查词明确拒绝（409）', lookupMock.status === 409, `实际 ${lookupMock.status}`);
      ok('★ 拒绝时说明没有释义能力', /没有.*释义|本地规则引擎/.test(lookupMock.data.error || ''));
      ok('拒绝结果里没有伪造释义',
        !lookupMock.data.entry && !lookupMock.data.definitionZh);

      const chatGet = await req('GET', `/api/articles/${article.id}/chat`);
      ok('新文章的文章问答是空的', chatGet.status === 200 && chatGet.data.messages.length === 0);
      const chatMock = await req('POST', `/api/articles/${article.id}/chat`, {
        content: '这段在说什么？',
        selection: { paragraphId: target.id, start: 0, end: 12, mode: 'phrase' },
      });
      ok('★ 本地规则引擎不伪装文章问答（409）', chatMock.status === 409, `实际 ${chatMock.status}`);
      const chatStillEmpty = await req('GET', `/api/articles/${article.id}/chat`);
      ok('★ 失败的问答不会写进历史', chatStillEmpty.data.messages.length === 0);

      const vocab = await req('POST', '/api/vocabulary', {
        articleId: article.id,
        term: 'mitigate',
        kind: 'word',
        selectionText: 'mitigate',
        contextText: 'We mitigate the noise by doing less.',
        entry: {
          term: 'mitigate', partOfSpeech: 'verb',
          definitionEn: 'make less severe', definitionZh: '减轻；缓和',
          collocations: ['mitigate risk'],
          derivatives: [{ word: 'mitigation', partOfSpeech: 'noun', meaningZh: '缓解；减轻' }],
          relatedWords: [{ word: 'mitigate risk', meaningZh: '降低风险' }],
          examples: [{ en: 'Steps were taken to mitigate the damage.', zh: '采取了措施减轻损害。' }],
          contextMeaning: '在这里指减少无关的干扰。',
          provider: 'mock',
        },
      });
      ok('加入生词本 → 201', vocab.status === 201, `实际 ${vocab.status}`);
      vocabId = vocab.data.entry.id;
      ok('生词记录来源文章与上下文',
        vocab.data.entry.articleId === article.id
        && vocab.data.entry.contextMeaning.includes('干扰'));
      ok('★ 生词记录保存派生词与衍生词',
        vocab.data.entry.derivatives.length === 1
        && vocab.data.entry.derivatives[0].word === 'mitigation'
        && vocab.data.entry.relatedWords[0].word === 'mitigate risk');
      const vocabAgain = await req('POST', '/api/vocabulary', {
        articleId: article.id,
        term: 'Mitigate',
        kind: 'word',
        selectionText: 'Mitigate',
        entry: { definitionZh: '另一个释义' },
      });
      ok('★ 同一个词再次加入会合并', vocabAgain.status === 200 && vocabAgain.data.merged === true);
      ok('合并后收录次数累加', vocabAgain.data.entry.seenCount === 2);
      ok('合并不会丢掉已有的派生词与衍生词',
        vocabAgain.data.entry.derivatives.length === 1
        && vocabAgain.data.entry.relatedWords.length === 1);
      const vocabNote = await req('PATCH', `/api/vocabulary/${vocabId}`, { note: '写作时常用' });
      ok('可以给生词写备注', vocabNote.status === 200 && vocabNote.data.entry.note === '写作时常用');
      ok('生词本能列出记录',
        (await req('GET', '/api/vocabulary')).data.vocabulary.some((v) => v.id === vocabId));

      await req('POST', `/api/articles/${article.id}/finish`);
      const replaced = await req('PUT', `/api/articles/${article.id}/content`, {
        text: '# A new draft\n\nOnly two paragraphs here.',
        format: 'md',
      });
      ok('替换正文 → 200', replaced.status === 200);
      ok('替换后统计更新',
        replaced.data.article.paragraphCount === 2 && replaced.data.article.title === 'Doing Less');
      ok('★ 替换正文会清空旧高亮、阅读位置、读完标记与选择题',
        replaced.data.article.highlights.length === 0
        && replaced.data.article.progress.percent === 0
        && replaced.data.article.finishedAt === null
        && replaced.data.article.quiz === null);

      const deleted = await req('DELETE', `/api/articles/${article.id}`);
      ok('删除文章 → 200', deleted.status === 200);
      ok('删除后详情 → 404', (await req('GET', `/api/articles/${article.id}`)).status === 404);
      ok('★ 删除文章会清理正文文件', (await db.readArticleContent(article.id)).length === 0);
      ok('★ 删除文章会清理文章对话', (await db.readArticleChat(article.id)).messages.length === 0);
      articleId = null;

      const vocabDeleted = await req('DELETE', `/api/vocabulary/${vocabId}`);
      ok('删除生词 → 200', vocabDeleted.status === 200);
      vocabId = null;
    } finally {
      if (articleId) await req('DELETE', `/api/articles/${articleId}`).catch(() => {});
      if (vocabId) await req('DELETE', `/api/vocabulary/${vocabId}`).catch(() => {});
      if (articleSettingsSnapshot !== null) await db.atomicWrite(articleSettingsFile, articleSettingsSnapshot);
      else await fs.rm(articleSettingsFile, { force: true });
      await req('GET', '/api/ai/status?refresh=1').catch(() => {});
    }
  }

  // ---------------------------------------------------------------- 设置与导出
  console.log('\n【设置与导出】');
  // 设置里可能存着用户真实的 Key。测试会临时写入假 Key，结束后必须原样恢复。
  const settingsFile = path.join(db.DATA_DIR, 'settings.json');
  const settingsSnapshot = await fs.readFile(settingsFile, 'utf8').catch(() => null);
  try {
    const s0 = await req('GET', '/api/settings');
    ok('读取设置 → 200', s0.status === 200);
    ok('能如实读到当前引擎配置',
      ['mock', 'ollama', 'real'].includes(s0.data.aiProvider), s0.data.aiProvider);
    ok('★ 设置里有供应商列表与模型下拉',
      Array.isArray(s0.data.modelProviders) && Array.isArray(s0.data.modelOptions));
    ok('★ 供应商列表也不回显 Key 明文',
      !JSON.stringify(s0.data.modelProviders).includes('apiKey'));

    const originalProviders = s0.data.modelProviders;
    const withProbe = [
      ...originalProviders.map((p) => ({ ...p })),
      {
        id: '', name: '自测供应商', type: 'openai',
        baseUrl: 'https://example.invalid/v1',
        models: [{ id: '', name: 'probe-a' }, { id: '', name: 'probe-b' }],
      },
    ];
    const s3 = await req('PATCH', '/api/settings', { modelProviders: withProbe });
    ok('★ 可以新增一家供应商并挂多个模型',
      s3.status === 200 && s3.data.modelProviders.length === originalProviders.length + 1);
    const probe = s3.data.modelProviders.find((p) => p.name === '自测供应商');
    ok('★ 新供应商的两个模型都进下拉',
      Boolean(probe) && probe.models.length === 2
      && s3.data.modelOptions.some((o) => o.ref === `${probe.id}/${probe.models[1].id}`));
    const tested = await req('POST', '/api/settings/test-model', {
      ref: `${probe.id}/${probe.models[0].id}`,
    });
    ok('★ 连不上的供应商返回原因而不是 500',
      tested.status === 200 && tested.data.ok === false && Boolean(tested.data.error));
    await req('PATCH', '/api/settings', {
      modelProviders: originalProviders, defaultModelRef: s0.data.defaultModelRef,
    });

    const s1 = await req('PATCH', '/api/settings', {
      aiProvider: 'real',
      apiKey: 'sk-test-not-real',
      model: 'test-model',
      oxfordAppId: 'test-oxford-id',
      oxfordAppKey: 'test-oxford-key',
    });
    ok('保存设置 → 200', s1.status === 200);
    ok('标记为已配置 Key', s1.data.hasApiKey === true);
    ok('★ 不回显 Key 明文', s1.data.apiKey === undefined);
    ok('★ 不回显牛津 App Key 明文',
      s1.data.oxfordAppKey === undefined && s1.data.hasOxfordKey === true);
    ok('牛津 App ID 可以回显', s1.data.oxfordAppId === 'test-oxford-id');

    const exportJson = await fetch(`${BASE}/api/export?format=json`);
    const jsonText = await exportJson.text();
    ok('导出 JSON → 200', exportJson.status === 200);
    ok('★ 导出文件里不含 API Key', !jsonText.includes('sk-test-not-real'));
    ok('导出内容可解析', (() => { try { JSON.parse(jsonText); return true; } catch { return false; } })());
    const exported = JSON.parse(jsonText);
    ok('★ JSON 导出包含学习项目',
      Array.isArray(exported.projects) && exported.projects.some((p) => p.id === project.id));
    ok('导出带下载文件名', /attachment/.test(exportJson.headers.get('content-disposition') || ''));

    const exportMd = await fetch(`${BASE}/api/export?format=markdown`);
    const md = await exportMd.text();
    ok('导出 Markdown → 200', exportMd.status === 200);
    ok('Markdown 含任务清单', md.includes('## 任务'));
    ok('Markdown 含档案', md.includes('## 我的档案'));
    ok('★ Markdown 含学习项目', md.includes('## 学习项目') && md.includes(project.title));
    ok('Markdown 标注了引擎来源', md.includes('本地模拟引擎'));
    ok('★ Markdown 里也没有 Key', !md.includes('sk-test-not-real'));

    await req('PATCH', '/api/settings', {
      aiProvider: 'mock', clearApiKey: true, clearOxfordKey: true, oxfordAppId: '',
    });
    const s2 = await req('GET', '/api/settings');
    ok('可以清掉 Key 并回到模拟引擎', s2.data.aiProvider === 'mock' && s2.data.hasApiKey === false);

    const mc = await req('POST', '/api/conversations', { title: '模型选择自测' });
    const cid = mc.data.conversation.id;
    const badPatch = await req('PATCH', `/api/conversations/${cid}`, { modelRef: 'mp-nope/mdl-nope' });
    ok('★ 对话不能保存不存在的模型', badPatch.status === 400);
    const goodPatch = await req('PATCH', `/api/conversations/${cid}`, { modelRef: 'mock' });
    ok('★ 对话可以单独选模型',
      goodPatch.status === 200 && goodPatch.data.conversation.modelRef === 'mock');
    const badMsg = await req('POST', `/api/conversations/${cid}/messages`, {
      content: '测试', modelRef: 'mp-nope/mdl-nope',
    });
    const afterBad = await req('GET', `/api/conversations/${cid}`);
    ok('★ 非法模型被拒时不留下孤零零的用户消息',
      badMsg.status === 400 && afterBad.data.conversation.messages.length === 0);
    const okMsg = await req('POST', `/api/conversations/${cid}/messages`, { content: '我今天有点乱' });
    ok('★ 回复记录这一轮用的模型',
      okMsg.status === 201 && okMsg.data.message.meta.modelRef === 'mock'
      && Boolean(okMsg.data.message.meta.model));
    await req('DELETE', `/api/conversations/${cid}`);
    ok('可以清掉牛津词典凭据', s2.data.hasOxfordKey === false && !s2.data.oxfordAppId);
  } finally {
    if (settingsSnapshot !== null) await db.atomicWrite(settingsFile, settingsSnapshot);
    else await fs.rm(settingsFile, { force: true });
    // 让服务端重新读取恢复后的设置，而不是继续用测试期间的缓存
    await req('GET', '/api/ai/status?refresh=1');
  }

  // ---------------------------------------------------------------- 打包地基
  console.log('\n【打包地基 · 桌面与手机各一份数据】');
  const contract = await req('GET', '/api/sync/contract');
  ok('★ 同步契约可读且明确关闭',
    contract.status === 200 && contract.data.enabled === false && Boolean(contract.data.instanceId));
  const envelopeRes = await fetch(`${BASE}/api/export?format=json`);
  const envelopeJson = JSON.parse(await envelopeRes.text());
  ok('★ 导出带实例信封，原有字段不丢',
    Boolean(envelopeJson.sync) && envelopeJson.sync.instanceId === contract.data.instanceId
    && Array.isArray(envelopeJson.tasks));
  for (const p of ['/manifest.webmanifest', '/sw.js', '/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png']) {
    const r = await fetch(`${BASE}${p}`);
    ok(`★ 手机壳资源 ${p} → 200`, r.status === 200);
  }
  const indexHtml = await (await fetch(`${BASE}/`)).text();
  ok('★ 首页挂了 manifest 与 SW 注册',
    indexHtml.includes('/manifest.webmanifest') && indexHtml.includes('/sw.js'));
  const swSrc = await fs.readFile(path.join(db.ROOT, 'public', 'sw.js'), 'utf8');
  ok('★ Service Worker 绝不缓存 API 与 SSE', swSrc.includes("startsWith('/api/')"));

  // ---------------------------------------------------------------- 错误处理
  console.log('\n【错误处理与稳定性】');
  ok('不存在的任务 → 404', (await req('GET', '/api/tasks/9999-nope')).status === 404);
  ok('不存在的对话 → 404', (await req('GET', '/api/conversations/9999-nope')).status === 404);
  ok('不存在的接口 → 404', (await req('GET', '/api/nothing')).status === 404);
  ok('非法 id 不崩溃', [400, 404].includes((await req('GET', '/api/tasks/..%2F..%2Fsecret')).status));
  ok('坏 JSON → 400', (await fetch(`${BASE}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad',
  })).status === 400);
  ok('空消息被拒绝', (await req('POST', `/api/conversations/${conv.id}/messages`, { content: '  ' })).status === 400);
  ok('已确认的方案不能再改',
    (await req('PATCH', `/api/conversations/${conv.id}/proposals/${prop.id}`, { title: 'x' })).status === 400);

  for (const p of [
    '/', '/css/style.css', '/css/workbench.css', '/css/study.css',
    '/js/app.js', '/js/views/dashboard.js', '/js/views/chat.js',
    '/js/views/focus.js', '/js/views/textbook.js', '/js/demos/index.js',
    '/float.html', '/css/float.css', '/js/float.js', '/js/float-launch.js',
    '/vendor/pdfjs/pdf.min.mjs',
  ]) {
    const r = await fetch(BASE + p);
    ok(`静态资源 ${p} → 200`, r.status === 200, `实际 ${r.status}`);
  }
  ok('目录穿越被拦下', [403, 404].includes((await fetch(`${BASE}/../../server/db.js`)).status));

  // ---------------------------------------------------------------- 远程模型通道
  console.log('\n【远程模型通道】');
  {
    const seen = [];
    const seenOxford = [];
    const stub = http.createServer((request, response) => {
      if (request.url.startsWith('/oxford/')) {
        seenOxford.push({
          url: request.url,
          appId: request.headers.app_id,
          appKey: request.headers.app_key,
        });
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          results: [{
            lexicalEntries: [{
              lexicalCategory: { text: 'Noun' },
              entries: [{
                senses: [{
                  definitions: ['the act of paying attention'],
                  examples: [{ text: 'He gave the problem his full attention.' }],
                }],
              }],
            }],
          }],
        }));
        return;
      }
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* 保持空对象 */ }
        seen.push(body);
        if (body.model === 'stall-model') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.write('{"choices":[{"message":{"content":"');
          return;
        }
        if (body.model === 'fallback-model' && body.reasoning_effort) {
          response.writeHead(400, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'Unsupported parameter: reasoning_effort is unknown' } }));
          return;
        }
        if (body.model === 'lookup-model') {
          const content = JSON.stringify({
            term: 'attention',
            kind: 'word',
            definitionZh: '注意力',
            contextMeaning: '这里指注意力是有限的。',
            examples: [
              { en: 'Attention is a finite resource.', zh: '注意力是有限的资源。' },
              { en: 'Attention is a finite resource that runs out.', zh: '注意力是有限的，会用完。' },
              { en: 'Paying attention in a noisy café takes practice.', zh: '在嘈杂的咖啡馆里集中注意力需要练习。' },
            ],
          });
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ model: body.model, choices: [{ message: { content } }] }));
          return;
        }

        if (body.model === 'gap-model') {
          const system = String((body.messages && body.messages[0] && body.messages[0].content) || '');
          const content = JSON.stringify(system.includes('补全') ? {
            derivatives: [{ word: 'attentiveness', partOfSpeech: 'noun', meaningZh: '专注' }],
            examples: [
              { en: 'Good sleep improves your attention the next day.', zh: '睡得好能提高第二天的注意力。' },
              { en: 'The noise made it hard to keep my attention on the page.', zh: '噪音让我很难把注意力放在书上。' },
            ],
          } : {
            term: 'attention',
            kind: 'word',
            definitionZh: '注意力',
            contextMeaning: '这里指注意力是有限的。',
            examples: [],
          });
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ model: body.model, choices: [{ message: { content } }] }));
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'OK' } }] }));
      });
    });
    await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${stub.address().port}/v1`;
    const baseSettings = { aiProvider: 'real', baseUrl, apiKey: 'stub-key', model: 'plain-model' };

    try {
      const out = await llm.complete({
        settings: baseSettings, system: 's', user: 'u', disableReasoning: true, timeoutMs: 5000,
      });
      ok('远程模型返回内容可以解析', out.text === 'OK');
      ok('★ 查词请求会带上关闭思考的参数', Boolean(seen[0]) && seen[0].reasoning_effort === 'none');

      const fallback = await llm.complete({
        settings: { ...baseSettings, model: 'fallback-model' },
        system: 's', user: 'u', disableReasoning: true, timeoutMs: 5000,
      });
      ok('★ 接口不认识关闭思考参数时会自动重试', fallback.text === 'OK' && seen.length === 3, `请求 ${seen.length} 次`);
      ok('重试请求不再带被拒绝的参数', Boolean(seen[2]) && seen[2].reasoning_effort === undefined);

      const started = Date.now();
      let stallMessage = '';
      try {
        await llm.complete({
          settings: { ...baseSettings, model: 'stall-model' }, system: 's', user: 'u', timeoutMs: 1000,
        });
      } catch (err) {
        stallMessage = err.message;
      }
      const waited = Date.now() - started;
      ok('★ 响应体卡住也会按超时中止', /超过 1 秒/.test(stallMessage) && waited < 4000,
        `${waited}ms · ${stallMessage || '没有抛错'}`);

      const contextText = 'Attention is a finite resource. It runs out when you switch tasks.';
      const looked = await articleAI.lookup({
        settings: { ...baseSettings, model: 'lookup-model' },
        article: {},
        selection: { text: 'attention', mode: 'word' },
        contextText,
      });
      ok('★ 例句里照抄原文的句子会被过滤',
        looked.entry.examples.length === 1, `实际 ${looked.entry.examples.length} 条`);
      ok('保留的是另写的常见用法例句',
        Boolean(looked.entry.examples[0]) && looked.entry.examples[0].en.includes('noisy café'));
      ok('★ 没有配置牛津凭据时不会请求词典接口', seenOxford.length === 0, `实际 ${seenOxford.length} 次`);

      const gapFilled = await articleAI.lookup({
        settings: { ...baseSettings, model: 'gap-model' },
        article: {},
        selection: { text: 'attention', mode: 'word' },
        contextText,
      });
      ok('★ 首次缺例句和派生词时会再补一次',
        gapFilled.entry.examples.length === 2 && gapFilled.entry.derivatives.length === 1,
        `例句 ${gapFilled.entry.examples.length} 条 · 派生词 ${gapFilled.entry.derivatives.length} 个`);
      ok('补全内容确实来自第二次请求',
        gapFilled.entry.derivatives[0].word === 'attentiveness'
        && gapFilled.entry.examples.some((ex) => ex.en.includes('Good sleep')));

      const oxfordLooked = await articleAI.lookup({
        settings: {
          ...baseSettings,
          model: 'lookup-model',
          oxfordAppId: 'test-app-id',
          oxfordAppKey: 'test-app-key',
          oxfordBaseUrl: `http://127.0.0.1:${stub.address().port}/oxford`,
        },
        article: {},
        selection: { text: 'attention', mode: 'word' },
        contextText,
      });
      ok('★ 配置牛津词典后英文释义采用牛津数据',
        oxfordLooked.entry.dictionarySource === 'oxford'
        && oxfordLooked.entry.definitionEn === 'the act of paying attention');
      ok('★ 牛津官方例句单独保留并标注来源',
        oxfordLooked.entry.oxford.examples.length === 1
        && oxfordLooked.entry.oxford.examples[0].en.includes('full attention'));
      ok('牛津凭据只出现在服务端请求头里',
        seenOxford.length === 1
        && seenOxford[0].appId === 'test-app-id'
        && seenOxford[0].appKey === 'test-app-key'
        && !JSON.stringify(oxfordLooked.entry).includes('test-app-key'));
    } finally {
      stub.closeAllConnections();
      await new Promise((resolve) => stub.close(resolve));
    }
  }

  // ---------------------------------------------------------------- 清理
  console.log('\n【清理本次测试数据】');
  if (canTestActive) {
    const stillActive = (await req('GET', '/api/focus/active')).data.active;
    if (stillActive && activeTokens.has(stillActive.token)) {
      await req('POST', '/api/focus/active/cancel', {});
    }
    if (activeFocusSnapshot !== null) await db.atomicWrite(activeFocusFile, activeFocusSnapshot);
    else await fs.rm(activeFocusFile, { force: true });
  }
  if (aliasesSnapshot !== null) await db.atomicWrite(aliasesFile, aliasesSnapshot);
  else await fs.rm(aliasesFile, { force: true });

  const after = (await req('GET', '/api/bootstrap')).data;
  let removed = 0;
  for (const t of after.tasks) if (!beforeTaskIds.has(t.id)) { await req('DELETE', `/api/tasks/${t.id}`); removed += 1; }
  for (const p of after.plans) if (!beforePlanIds.has(p.id)) { await req('DELETE', `/api/plans/${p.id}`); removed += 1; }
  for (const p of after.projects || []) if (!beforeProjectIds.has(p.id)) { await req('DELETE', `/api/projects/${p.id}`); removed += 1; }
  for (const a of after.archives) if (!beforeArchiveIds.has(a.id)) { await req('DELETE', `/api/archives/${a.id}`); removed += 1; }
  for (const c of after.conversations) if (!beforeConvIds.has(c.id)) { await req('DELETE', `/api/conversations/${c.id}`); removed += 1; }
  for (const id of [focusSessionId, yesterdayFocusSessionId, ...extraFocusSessionIds]) {
    if (!id) continue;
    await db.remove('focusSessions', id);
    removed += 1;
  }
  if (textbookId) {
    await req('DELETE', `/api/textbooks/${textbookId}`);
    removed += 1;
  }
  ok(`清理了 ${removed} 项测试数据`, removed > 0);

  const finalState = (await req('GET', '/api/bootstrap')).data;
  ok('★ 没有留下测试任务', finalState.tasks.length === beforeTaskIds.size,
    `${beforeTaskIds.size} → ${finalState.tasks.length}`);
  ok('★ 用户原有档案一份不少',
    finalState.archives.filter((a) => a.origin === 'legacy').length === userArchives.length,
    `${userArchives.length} → ${finalState.archives.filter((a) => a.origin === 'legacy').length}`);
  ok('★ 没有留下测试学习项目', finalState.projects.length === beforeProjectIds.size,
    `${beforeProjectIds.size} → ${finalState.projects.length}`);

  // ---------------------------------------------------------------- 结果
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log('  失败项：');
    for (const f of failures) console.log(`    · ${f}`);
  }
  console.log(`${'─'.repeat(56)}\n`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error('\n自测本身出错了：', err);
  process.exit(1);
});
