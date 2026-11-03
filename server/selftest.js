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
const path = require('path');
const db = require('./db');
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
  const yFocus = await req('POST', '/api/focus/sessions', {
    clientToken: `selftest-focus-yesterday-${Date.now()}`,
    mode: 'focus',
    title: '昨天背的单词',
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
  const yContent = withYesterday.stats.byContent.find((c) => c.title === '昨天背的单词');
  ok('★ 昨天专注的内容进入累计列表',
    Boolean(yContent && yContent.seconds >= 900 && yContent.sessions >= 1));

  const fUndo = await req('POST', `/api/focus/sessions/${focusSession.id}/undo`, {});
  ok('★ 撤销后待办回到原来的状态',
    fUndo.data.task.status === 'todo' && fUndo.data.task.completedAt === null);
  const focusAfterUndo = (await req('GET', '/api/focus')).data;
  ok('★ 撤销掉的一轮不再计入统计',
    focusAfterUndo.stats.todaySessions === focusList.stats.todaySessions - 1);
  ok('★ 撤销后也不再出现在按内容累计里',
    !focusAfterUndo.stats.byContent.some((c) => c.title === '背 50 个单词'));
  const fUndo2 = await req('POST', `/api/focus/sessions/${focusSession.id}/undo`, {});
  ok('重复撤销是安全的', fUndo2.data.alreadyUndone === true);

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
    ok('★ 到点后任何窗口来问，都会自动结掉这一轮',
      natural.data.active === null && Boolean(natural.data.justFinished));
    ok('★ 自然结束同样勾选待办',
      natural.data.justFinished.task && natural.data.justFinished.task.status === 'done');
    extraFocusSessionIds.push(natural.data.justFinished.session.id);
    const naturalUndo = await req('POST', `/api/focus/sessions/${natural.data.justFinished.session.id}/undo`, {});
    ok('自然结束也可以撤销勾选', naturalUndo.data.task.status === 'todo');

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

    const s1 = await req('PATCH', '/api/settings', { aiProvider: 'real', apiKey: 'sk-test-not-real', model: 'test-model' });
    ok('保存设置 → 200', s1.status === 200);
    ok('标记为已配置 Key', s1.data.hasApiKey === true);
    ok('★ 不回显 Key 明文', s1.data.apiKey === undefined);

    const exportJson = await fetch(`${BASE}/api/export?format=json`);
    const jsonText = await exportJson.text();
    ok('导出 JSON → 200', exportJson.status === 200);
    ok('★ 导出文件里不含 API Key', !jsonText.includes('sk-test-not-real'));
    ok('导出内容可解析', (() => { try { JSON.parse(jsonText); return true; } catch { return false; } })());
    ok('导出带下载文件名', /attachment/.test(exportJson.headers.get('content-disposition') || ''));

    const exportMd = await fetch(`${BASE}/api/export?format=markdown`);
    const md = await exportMd.text();
    ok('导出 Markdown → 200', exportMd.status === 200);
    ok('Markdown 含任务清单', md.includes('## 任务'));
    ok('Markdown 含档案', md.includes('## 我的档案'));
    ok('Markdown 标注了引擎来源', md.includes('本地模拟引擎'));
    ok('★ Markdown 里也没有 Key', !md.includes('sk-test-not-real'));

    await req('PATCH', '/api/settings', { aiProvider: 'mock', clearApiKey: true });
    const s2 = await req('GET', '/api/settings');
    ok('可以清掉 Key 并回到模拟引擎', s2.data.aiProvider === 'mock' && s2.data.hasApiKey === false);
  } finally {
    if (settingsSnapshot !== null) await db.atomicWrite(settingsFile, settingsSnapshot);
    else await fs.rm(settingsFile, { force: true });
    // 让服务端重新读取恢复后的设置，而不是继续用测试期间的缓存
    await req('GET', '/api/ai/status?refresh=1');
  }

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

  const after = (await req('GET', '/api/bootstrap')).data;
  let removed = 0;
  for (const t of after.tasks) if (!beforeTaskIds.has(t.id)) { await req('DELETE', `/api/tasks/${t.id}`); removed += 1; }
  for (const p of after.plans) if (!beforePlanIds.has(p.id)) { await req('DELETE', `/api/plans/${p.id}`); removed += 1; }
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
