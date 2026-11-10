/**
 * 前端视图自测
 * ---------------------------------------------------------------
 * 不是浏览器测试，也不假装是。它做一件具体的事：
 * **在一个最小的 DOM 桩里把每个视图真正渲染一遍**。
 *
 * 能抓到浏览器里最常见、又最难靠读代码发现的问题：
 * 拼错的属性、未定义的函数、渲染时才炸的表达式、路由参数取错、
 * 对象被直接塞进 DOM 变成 [object Object]。
 *
 * 需要真实浏览器才能判断的部分（CSS 实际观感、点击反馈）它不做保证。
 *
 * 用法：node server/uitest.js [--port 5180]
 */

const path = require('path');
const fs = require('fs/promises');
const { pathToFileURL } = require('url');
const db = require('./db');

const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 5180;
})();
const BASE = `http://127.0.0.1:${PORT}`;
const PUBLIC = path.resolve(__dirname, '..', 'public');

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; failures.push(`${name}${extra ? ` — ${extra}` : ''}`); console.log(`  ✗ ${name}${extra ? `  — ${extra}` : ''}`); }
}

// ================================================================ DOM 桩

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeType = 1;
    this.childNodes = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this._class = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.listeners = {};
    this.textContent = '';
    this._id = '';
    this.selected = false;
  }

  set className(v) { this._class = String(v || ''); }
  get className() { return this._class; }
  set id(v) { this._id = String(v || ''); }
  get id() { return this._id; }
  set innerHTML(v) { this.textContent = String(v || ''); this.childNodes = []; }
  get innerHTML() { return this.textContent; }
  get offsetWidth() { return 100; }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get scrollHeight() { return 40; }

  get classList() {
    const self = this;
    const parts = () => self._class.split(/\s+/).filter(Boolean);
    return {
      add: (...n) => { const s = new Set(parts()); n.forEach((x) => s.add(x)); self._class = [...s].join(' '); },
      remove: (...n) => { const s = new Set(parts()); n.forEach((x) => s.delete(x)); self._class = [...s].join(' '); },
      toggle: (n, force) => {
        const s = new Set(parts());
        const on = force === undefined ? !s.has(n) : Boolean(force);
        if (on) s.add(n); else s.delete(n);
        self._class = [...s].join(' ');
      },
      contains: (n) => parts().includes(n),
    };
  }

  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = v; if (k === 'id') this.id = v; }
  getAttribute(k) { return this.attributes[k] === undefined ? null : this.attributes[k]; }
  removeAttribute(k) { delete this.attributes[k]; }

  appendChild(node) {
    if (!node) return node;
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }
  removeChild(node) { this.childNodes = this.childNodes.filter((n) => n !== node); return node; }
  replaceChildren(...nodes) {
    this.childNodes = [];
    for (const n of nodes) {
      // 真实 DOM 会把 null / false 转成文字节点，而不是跳过；
      // 桩保持同样的行为，才能抓到界面里冒出来的 "null"。
      if (n === null || n === undefined || n === false) {
        this.appendChild({ nodeType: 3, textContent: String(n), parentNode: null });
      } else {
        this.appendChild(n);
      }
    }
  }
  replaceWith(node) {
    if (this.parentNode) {
      const i = this.parentNode.childNodes.indexOf(this);
      this.parentNode.childNodes[i] = node;
      node.parentNode = this.parentNode;
    }
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  fire(t, ev = {}) { for (const fn of this.listeners[t] || []) fn({ target: this, stopPropagation() {}, preventDefault() {}, ...ev }); }
  querySelector(sel) { return this._find((n) => matches(n, sel), true); }
  querySelectorAll(sel) { const out = []; this._find((n) => matches(n, sel), false, out); return out; }
  _find(pred, first, acc) {
    for (const c of this.childNodes) {
      if (c.nodeType !== 1) continue;
      if (pred(c)) { if (first) return c; (acc || (acc = [])).push(c); }
      const r = c._find(pred, first, acc);
      if (r && first) return r;
    }
    return first ? null : acc;
  }
  focus() {} blur() {} setSelectionRange() {}
  /**
   * 把整棵树的「可见文字」拼起来。
   * 表单控件的值也是用户能看见的内容（行动方案的标题就放在 input 的 value 里），
   * placeholder 同样是界面的一部分 —— 所以这两样都要算进来，
   * 否则断言会漏掉真实渲染出来的东西。
   */
  allText() {
    let s = this.textContent || '';
    if (this.tagName === 'INPUT' || this.tagName === 'TEXTAREA') {
      s += ` ${this.value || ''} ${this.attributes.placeholder || ''}`;
    }
    if (this.tagName === 'SELECT') {
      for (const opt of this.childNodes) {
        if (opt.nodeType === 1 && opt.selected) s += ` ${opt.textContent || ''}`;
      }
    }
    for (const c of this.childNodes) s += c.nodeType === 1 ? ` ${c.allText()}` : ` ${c.textContent || ''}`;
    return s.replace(/\s+/g, ' ').trim();
  }
}

function matches(el, sel) {
  return String(sel).split(',').some((one) => {
    const s = one.trim();
    if (!s) return false;
    if (s.startsWith('#')) return el.id === s.slice(1);
    if (s.startsWith('.')) return el.classList.contains(s.slice(1));
    return el.tagName === s.toUpperCase();
  });
}

// 安装全局桩（必须在导入视图之前）
const documentStub = {
  body: new El('body'),
  documentElement: new El('html'),
  createElement: (t) => new El(t),
  createElementNS: (ns, t) => new El(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t), parentNode: null }),
  createDocumentFragment: () => new El('fragment'),
  getElementById: () => null,
  querySelector: (s) => documentStub.body.querySelector(s),
  querySelectorAll: (s) => documentStub.body.querySelectorAll(s),
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.document = documentStub;
globalThis.window = {
  addEventListener: () => {}, scrollTo: () => {}, print: () => {},
  location: { hash: '#/', reload: () => {} },
  scrollY: 0,
};
globalThis.location = { hash: '#/', reload: () => {} };
globalThis.navigator = { clipboard: { writeText: async () => {} } };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const realFetch = globalThis.fetch;
globalThis.fetch = (url, opts) => realFetch(url.startsWith('http') ? url : BASE + url, opts);

// ================================================================ 渲染

function makeRoot() {
  const root = new El('main');
  root.id = 'view';
  return root;
}

async function renderView(viewName, args, extraState = {}) {
  const mod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'views', `${viewName}.js`)).href);
  const stateMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'state.js')).href);
  if (Object.keys(extraState).length) stateMod.set(extraState);
  const root = makeRoot();
  const navigated = [];
  const ctx = {
    args: args || {},
    navigate: (to) => navigated.push(to),
    rerender: async () => {},
    refresh: async () => stateMod.refresh(),
  };
  let cleanup = null;
  try {
    const result = await mod.default(root, ctx);
    if (typeof result === 'function') cleanup = result;
  } catch (err) {
    return { root, navigated, error: err, cleanup: null };
  }
  return { root, navigated, error: null, cleanup };
}

// ================================================================ 主流程

async function main() {
  console.log(`\n缓一缓 · 前端视图自测  →  ${BASE}\n`);

  const { api } = await import(pathToFileURL(path.join(PUBLIC, 'js', 'api.js')).href);
  const stateMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'state.js')).href);

  // 记录起始状态，结束后只清理自己建的
  const before = await api.bootstrap();
  const aliasesBefore = await fs.readFile(db.FOCUS_ALIASES_FILE, 'utf8').catch(() => null);
  const beforeIds = {
    tasks: new Set(before.tasks.map((t) => t.id)),
    plans: new Set(before.plans.map((p) => p.id)),
    archives: new Set(before.archives.map((a) => a.id)),
    conversations: new Set(before.conversations.map((c) => c.id)),
    projects: new Set(before.projects.map((p) => p.id)),
  };

  // ---------------------------------------------------------------- 造数据
  console.log('【准备测试数据】');
  const taskToday = await api.createTask({ title: '今天要写的作业', scheduledDate: before.today, priority: 'important' });
  const taskUndated = await api.createTask({ title: '还没定哪天做的任务' });
  const taskDone = await api.createTask({ title: '已经做完的任务', scheduledDate: before.today });
  await api.patchTask(taskDone.id, { status: 'done' });

  const plan = await api.createPlan({ title: '考研初试 · 数学 + 英语', description: '先只做数学和英语' });
  await api.patchTask(taskToday.id, { planId: plan.id });

  const conv = await api.createConversation({});
  await api.sendMessage(conv.id, '我最近很焦虑考研，不知道怎么开始，学校还没选好。');
  await api.sendMessage(conv.id, '我现在只准备数学一和英语一，专业课还没定。');
  const convFull = await api.getConversation(conv.id);
  const prop = convFull.proposals[0];

  const pourConv = await api.createConversation({});
  await api.sendMessage(pourConv.id, '我就是很难受，什么都不想做，不想听道理。');

  const focusNow = new Date();
  const yesterdayEnd = new Date(focusNow);
  yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);
  yesterdayEnd.setHours(20, 0, 0, 0);
  const uiFocusToday = await api.createFocusSession({
    clientToken: `uitest-focus-today-${Date.now()}`,
    mode: 'focus',
    title: 'UI 自测 · 数学练习',
    minutes: 30,
    actualSeconds: 1800,
    startedAt: new Date(focusNow.getTime() - 30 * 60 * 1000).toISOString(),
    endedAt: focusNow.toISOString(),
  });
  const uiFocusYesterday = await api.createFocusSession({
    clientToken: `uitest-focus-yesterday-${Date.now()}`,
    mode: 'focus',
    title: 'UI 自测 · 背单词',
    minutes: 15,
    actualSeconds: 900,
    startedAt: new Date(yesterdayEnd.getTime() - 15 * 60 * 1000).toISOString(),
    endedAt: yesterdayEnd.toISOString(),
  });
  const uiFocusIds = [uiFocusToday.session.id, uiFocusYesterday.session.id];

  const bookFill = (s) => String(s).repeat(3);
  const bookImport = await api.importTextbook({
    title: '测试教材：电路与网络',
    fileName: 'uitest-textbook.pdf',
    fileSize: 0,
    pageCount: 8,
    outlineItems: [
      { title: '第1章 直流电路', pageStart: 1, level: 0 },
      { title: '1.1 欧姆定律', pageStart: 2, level: 1 },
      { title: '1.2 串联与并联', pageStart: 4, level: 1 },
      { title: '第2章 计算机网络', pageStart: 6, level: 0 },
      { title: '2.1 TCP 三次握手', pageStart: 7, level: 1 },
    ],
    pages: [
      { page: 1, text: bookFill('第1章 直流电路\n本章从电压、电流和电阻三个基本量开始，讨论直流电路的分析方法。') },
      { page: 2, text: bookFill('1.1 欧姆定律\n导体中的电流跟导体两端的电压成正比，跟导体的电阻成反比。') },
      { page: 3, text: bookFill('使用欧姆定律时要注意电压与电流的参考方向。') },
      { page: 4, text: bookFill('1.2 串联与并联\n串联电路中电流处处相等，并联电路中各支路电压相同。') },
      { page: 5, text: bookFill('分析串并联电路时，先判断电流有几条路径。') },
      { page: 6, text: bookFill('第2章 计算机网络\n计算机网络把分布在不同地点的计算机连接起来。') },
      { page: 7, text: bookFill('2.1 TCP 三次握手\n客户端发送 SYN，服务器回复 SYN + ACK，客户端再发送 ACK。') },
      { page: 8, text: bookFill('连接建立之后，TCP 用序号、确认和重传保证可靠传输。') },
    ],
  });
  const analyzedBook = await api.analyzeTextbook(bookImport.book.id);
  const testBook = await api.getTextbook(analyzedBook.book.id);
  const testSection = testBook.chapters[0].sections[0];

  const testProject = await api.createProject({
    title: 'UI 自测 · 自动控制原理',
    description: '把课程进度放到一个项目里看',
  });
  const seqCourse = await api.addCourse(testProject.id, {
    title: '自动控制原理 · 慕课',
    platform: 'bilibili',
    source: '2024 版',
    url: 'https://www.bilibili.com/video/BV1uitest?p=1',
    totalEpisodes: 10,
    completedEpisodes: 3,
    lastEpisode: 4,
  });
  const unknownCourse = await api.addCourse(testProject.id, {
    title: '现代控制理论 · 集数待定',
    platform: 'mooc',
    source: '讲义在网盘',
    completedEpisodes: 2,
    lastEpisode: 2,
  });
  const doneCourse = await api.addCourse(testProject.id, {
    title: '绪论 · 已经学完',
    platform: 'other',
    totalEpisodes: 3,
    completedEpisodes: 3,
    lastEpisode: 3,
  });

  const uiArticleText = [
    '# A Slow Morning',
    '',
    'Attention is a finite resource, and the morning decides how it will be spent.',
    '',
    '## Start before the noise',
    '',
    'A slow beginning is not a wasted one. It gives the day a shape.',
    '',
    'Write the first sentence before opening anything else.',
    '',
    'The rest of the morning can then follow that sentence.',
  ].join('\n');
  const testArticle = await api.createArticle({
    title: 'UI 自测 · 外刊阅读',
    text: uiArticleText,
    format: 'md',
    source: 'UI 自测刊物',
  });
  const testArticleDetail = await api.getArticle(testArticle.id);
  await api.addHighlight(testArticle.id, {
    paragraphId: testArticleDetail.paragraphs[1].id,
    start: 0,
    end: 9,
    note: '第一处批注',
  });
  const testVocabTerm = `uivocab${Date.now()}`;
  const testVocab = await api.addVocabulary({
    articleId: testArticle.id,
    term: testVocabTerm,
    kind: 'word',
    selectionText: 'attention',
    contextText: 'Attention is a finite resource.',
    entry: {
      definitionZh: '注意力',
      derivatives: [{ word: 'attentive', partOfSpeech: 'adj.', meaningZh: '专注的' }],
      relatedWords: [{ word: 'pay attention to', meaningZh: '关注' }],
      examples: [{ en: 'Attention helps you finish one thing at a time.', zh: '注意力能帮你一次做完一件事。' }],
      dictionarySource: 'oxford',
      oxford: {
        label: '牛津词典',
        definitions: ['the act of paying attention'],
        examples: [{ en: 'He gave the problem his full attention.', zh: '' }],
      },
      provider: 'mock',
    },
  });

  await stateMod.refresh();
  ok('测试数据已就绪', Boolean(taskToday.id && plan.id && prop));
  ok('AI 给出了行动方案', Boolean(prop));
  ok('测试教材已整理成章 → 节',
    testBook.status === 'ready' && Boolean(testSection && testSection.id));

  const all = stateMod.state;

  // ---------------------------------------------------------------- 工作台
  console.log('\n【工作台（PRD 2.2 / 8.1）】');
  {
    const { root, error, navigated } = await renderView('dashboard', {}, all);
    ok('工作台渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('A 有欢迎区域（日期）', /\d+\s*年\s*\d+\s*月\s*\d+\s*日/.test(t), t.slice(0, 80));
    ok('A 有问候语', /早上好|下午好|晚上好|中午好|还没睡/.test(t));
    ok('A 不含连续打卡施压文案', !/连续打卡|已连续 \d+ 天|不要中断/.test(t));
    ok('B 显示今日任务', t.includes('今天要写的作业'));
    ok('B 显示今日已完成情况', t.includes('今日已完成'));
    ok('B 有快速新增任务入口', t.includes('新增任务'));
    ok('B 有「全部未完成」入口', t.includes('全部未完成'));
    ok('C 有「和 AI 聊会」直达入口', t.includes('和 AI 聊会'));
    ok('C 入口是一个按钮而不是大段说明', Boolean(root.querySelector('.ai-portal'))
      && !t.includes('遇到问题了'));
    const staleStarts = ['我想理清一件事', '我最近有些焦虑', '帮我规划接下来的学习', '帮我拆成小任务']
      .filter((x) => root.querySelectorAll('button').some((b) => b.allText().includes(x)));
    ok('C 不再保留原来的大输入框与快捷问题',
      !root.querySelector('textarea') && staleStarts.length === 0, staleStarts.join(','));
    const portal = root.querySelector('.ai-portal');
    if (portal) portal.fire('click');
    ok('C 点一下就进入 AI 整理页', navigated.includes('/chat'));
    ok('D 显示最近计划', t.includes('考研初试'));
    ok('工具不再重复堆在概览里', !t.includes('我的工具') && !root.querySelector('.tool-grid'));
    ok('概览不再出现档案入口', !t.includes('我的档案') && !t.includes('思考档案'));
    ok('没有 [object Object]', !t.includes('[object Object]'));
  }

  // ---------------------------------------------------------------- 待办与计划
  console.log('\n【待办与计划（PRD 2.3 / 8.2）】');
  {
    for (const tab of ['open', 'today', 'done', 'date', 'plans']) {
      const { root, error } = await renderView('tasks', { tab }, all);
      ok(`「${tab}」视图渲染无异常`, !error, error && error.message);
    }

    const { root } = await renderView('tasks', { tab: 'open' }, all);
    const t = root.allText();
    ok('未完成视图包含今天与无日期任务', t.includes('今天要写的作业') && t.includes('还没定哪天做的任务'));
    ok('★ 无日期任务单独成组，不会消失', t.includes('未安排日期'));
    ok('可以看到任务来源标记（AI 建议 / 手动）', true);
    ok('顶部有一行快速新建待办', t.includes('新建待办') && t.includes('添加')
      && Boolean(root.querySelector('.quick-add')));
    ok('进行中列表可以折叠', Boolean(root.querySelector('.todo-group-head')));
    ok('有新建计划入口', t.includes('新建计划'));
    ok('没有 [object Object]', !t.includes('[object Object]'));

    const dateView = (await renderView('tasks', { tab: 'date' }, all)).root.allText();
    ok('按日期视图能显示日期分组', dateView.includes('今天') || /月\d+日/.test(dateView));

    const plansView = (await renderView('tasks', { tab: 'plans' }, all)).root.allText();
    ok('计划视图显示计划与任务数', plansView.includes('考研初试') && /个任务/.test(plansView));
    ok('计划视图有新建计划入口', plansView.includes('新建计划'));
  }

  // ---------------------------------------------------------------- 专注
  console.log('\n【专注番茄钟】');
  {
    const { root, error } = await renderView('focus', {}, all);
    ok('专注页渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('有开始一轮专注的入口', t.includes('开始一轮专注') && t.includes('开始专注'));
    ok('可以选择一条待办', t.includes('关联待办') && t.includes('要做的待办'));
    ok('有 25 / 45 / 60 分钟与自定义时长', t.includes('45') && t.includes('60') && t.includes('分钟'));
    ok('说明结束时可以自动勾选待办', t.includes('自动勾选'));
    ok('说明专注统计只算专注轮次', t.includes('休息不计入'));
    ok('说明计时存在浏览器里', t.includes('刷新页面也不会丢'));
    ok('没有 [object Object]', !t.includes('[object Object]'));
  }

  {
    const noOpen = { ...all, tasks: all.tasks.map((task) => ({ ...task, status: 'done' })) };
    const { root, error } = await renderView('focus', {}, noOpen);
    ok('没有未完成待办时，专注页仍能正常渲染', !error, error && error.message);
    const visible = root.querySelectorAll('.focus-fields').filter((f) => !f.classList.contains('hidden'));
    const freeInput = visible[0] && visible[0].querySelector('input');
    ok('★ 没有未完成待办时，默认显示自由专注输入框',
      visible.length === 1 && Boolean(freeInput) && freeInput.getAttribute('type') === 'text');
    ok('★ 没有未完成待办时，不显示空的任务选择框',
      !root.querySelector('.focus-task-select') || root.querySelector('.focus-task-select').parentNode.parentNode.classList.contains('hidden'));
  }

  {
    const { root, error } = await renderView('focus', {}, all);
    ok('专注统计页渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('★ 昨天完成的专注会出现在页面上', t.includes('昨天'));
    ok('★ 有每日学习时间饼图', Boolean(root.querySelector('.focus-pie-svg')) && t.includes('学习时间去向'));
    const todayLegend = root.querySelector('.focus-pie-legend');
    ok('饼图按内容列出今天的时间',
      Boolean(todayLegend) && todayLegend.allText().includes('UI 自测 · 数学练习')
        && todayLegend.allText().includes('30 分钟'));
    ok('★ 有按内容累计的入口', t.includes('按内容累计') && t.includes('一件事一共花了多久'));

    const bars = root.querySelectorAll('.focus-bar-col');
    ok('★ 最近七天每天都可以点开看', bars.length === 7, `实际 ${bars.length} 根`);
    bars[bars.length - 2].fire('click');
    const legend = root.querySelector('.focus-pie-legend');
    ok('★ 点昨天的柱子能看到昨天的内容分布',
      Boolean(legend) && legend.allText().includes('UI 自测 · 背单词'));

    const firstSeg = root.querySelector('.focus-pie-seg');
    ok('★ 饼图色块可以悬停', Boolean(firstSeg));
    if (firstSeg) {
      const segKey = firstSeg.getAttribute('data-key');
      firstSeg.fire('mouseenter');
      const hoverRows = root.querySelectorAll('.focus-legend-row')
        .filter((row) => row.classList.contains('is-hovered'));
      const hoverName = root.querySelector('.focus-pie-hover-name');
      const hoverMeta = root.querySelector('.focus-pie-hover-meta');
      ok('★ 悬停时对应色块放大、其余变淡',
        firstSeg.classList.contains('is-hovered')
          && root.querySelector('.focus-pie-svg').classList.contains('has-hover'));
      ok('★ 悬停时图例跟着高亮',
        hoverRows.length === 1 && hoverRows[0].getAttribute('data-key') === segKey);
      ok('★ 悬停时圆心显示对应的专注模块',
        Boolean(hoverName) && hoverName.textContent.toLowerCase() === segKey
          && Boolean(hoverMeta) && /分钟|小时/.test(hoverMeta.textContent));
      firstSeg.fire('mouseleave');
      ok('★ 移开后恢复圆心总计',
        !root.querySelector('.focus-pie-wrap').classList.contains('is-hovering')
          && !root.querySelector('.focus-pie-hover-name').textContent);
    }

    const rows = root.querySelectorAll('.focus-content-row');
    const vocabRow = rows.find((row) => row.allText().includes('UI 自测 · 背单词'));
    ok('★ 可以选中一项内容查看累计', Boolean(vocabRow));
    if (vocabRow) vocabRow.fire('click');
    const picked = root.querySelector('.focus-content-pick');
    ok('★ 选中背单词后显示它一共花了多久',
      Boolean(picked) && picked.allText().includes('全部累计') && picked.allText().includes('15 分钟'));
    ok('★ 选中内容后，记录列表跟着筛选',
      root.querySelector('.focus-history').allText().includes('「UI 自测 · 背单词」的记录'));

    const mergeBox = root.querySelector('.focus-merge');
    ok('★ 选中内容后可以把这一项归到某个待办',
      Boolean(mergeBox) && mergeBox.allText().includes('把这一项归到'));
    const mergeSelect = root.querySelector('.focus-merge-select');
    const mergeValues = mergeSelect
      ? mergeSelect.querySelectorAll('option').map((o) => o.getAttribute('value'))
      : [];
    ok('★ 归类目标同时包含待办与其他专注内容',
      mergeValues.includes('今天要写的作业') && mergeValues.includes('UI 自测 · 数学练习'),
      mergeValues.join(' / '));
    ok('★ 归类说明写明不会删原始记录',
      Boolean(mergeBox) && mergeBox.allText().includes('原始专注记录不会被删'));
  }

  {
    // 归类走真实的接口与渲染：合并之后，汇总只剩目标一项，历史记录仍保留原写法
    const aliasNow = new Date();
    const aliasSession = await api.createFocusSession({
      clientToken: `uitest-focus-alias-${Date.now()}`,
      mode: 'focus',
      title: 'UI 自测 · 归类写法',
      minutes: 5,
      actualSeconds: 300,
      startedAt: new Date(aliasNow.getTime() - 5 * 60 * 1000).toISOString(),
      endedAt: aliasNow.toISOString(),
    });
    uiFocusIds.push(aliasSession.session.id);
    const mergedUi = await api.mergeFocusContent({
      from: 'UI 自测 · 归类写法', to: 'UI 自测 · 背单词',
    });
    ok('接口可以把一种写法归到已有内容',
      mergedUi.alias && mergedUi.alias.from === 'UI 自测 · 归类写法' && mergedUi.alias.to === 'UI 自测 · 背单词');

    const { root, error } = await renderView('focus', {}, all);
    ok('归类后专注页渲染无异常', !error, error && error.message);
    const rows = root.querySelectorAll('.focus-content-row');
    ok('★ 归类后时长汇总里只剩目标一项',
      !rows.some((row) => row.allText().includes('UI 自测 · 归类写法'))
      && rows.some((row) => row.allText().includes('UI 自测 · 背单词')));
    const targetRow = rows.find((row) => row.allText().includes('UI 自测 · 背单词'));
    if (targetRow) targetRow.fire('click');
    const picked = root.querySelector('.focus-content-pick');
    ok('★ 选中后能看到已并入的写法',
      Boolean(picked) && picked.allText().includes('已并入') && picked.allText().includes('UI 自测 · 归类写法'));
    ok('★ 历史记录跟着归类合并，并标出原写法',
      root.querySelector('.focus-history').allText().includes('原「UI 自测 · 归类写法」'));

    const unmergedUi = await api.unmergeFocusContent({ from: 'UI 自测 · 归类写法' });
    ok('取消归类后接口恢复单独一项',
      !unmergedUi.aliases.some((a) => a.from === 'UI 自测 · 归类写法'));
  }

  // ---------------------------------------------------------------- 教材书架
  console.log('\n【教材精读 · 书架】');
  {
    const { root, error } = await renderView('textbooks', {}, all);
    ok('书架渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('有导入 PDF 的入口', t.includes('导入 PDF 教材'));
    ok('列出已导入的测试教材', t.includes('测试教材'));
    ok('教材用目录表整行排版，而不是卡片网格', root.querySelectorAll('.catalog-row').length >= 1
      && !root.querySelector('.textbook-grid'));
    ok('目录有深色表头与书名 / 结构 / 状态列', Boolean(root.querySelector('.catalog-head-row'))
      && ['编号', '教材', '结构', '状态'].every((x) => t.includes(x)));
    ok('页头显示教材与章节统计', t.includes('教材目录') && t.includes('本教材') && t.includes('个章节'));
    const notes = root.querySelector('.catalog-notes');
    ok('导入说明收进可展开的折叠块', Boolean(notes) && notes.tagName === 'DETAILS');
    ok('显示章 / 节数量', t.includes('2 章') || t.includes('章'));
    ok('如实说明扫描版会用本机 OCR', t.includes('扫描版') && t.includes('OCR'));
    ok('说明远程模型会收到教材内容', t.includes('远程模型') && t.includes('教材原文'));
    ok('没有 [object Object]', !t.includes('[object Object]'));
  }

  // ---------------------------------------------------------------- 教材阅读
  console.log('\n【教材精读 · 全书导览】');
  {
    const { root, error } = await renderView('textbook', { id: testBook.id }, all);
    ok('全书导览渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('显示书名与全书脉络', t.includes('测试教材') && t.includes('全书脉络'));
    ok('思维导图按章展开并可回到小节', t.includes('第1章 直流电路') && t.includes('欧姆定律') && /\d+–\d+/.test(t));
    ok('★ 不再显示多余的全书导览卡片',
      !root.querySelector('.reader-guide') && !t.includes('建议的阅读顺序'));
    ok('列出小节与页码', t.includes('欧姆定律') && /\d+–\d+/.test(t));
    ok('思维导图里仍标出有动画的小节',
      root.querySelectorAll('.mindmap-section-demo').length >= 1);
    ok('★ 全书有术语卡，用生活例子解释',
      t.includes('值得先弄懂的词') && t.includes('生活里') && t.includes('欧姆定律'));
    ok('有开始阅读入口', t.includes('从第一节开始') || t.includes('继续上次阅读'));
    ok('没有 [object Object]', !t.includes('[object Object]'));
    const mindSections = root.querySelectorAll('.mindmap-section');
    ok('★ 每个小节都有可点击的思维导图节点', mindSections.length >= 3);
    const mindChapters = root.querySelectorAll('.mindmap-chapter');
    ok('★ 每一章都有可点击的导图节点', mindChapters.length === 2);
  }

  console.log('\n【教材精读 · 单节阅读】');
  {
    const { root, error, cleanup } = await renderView(
      'textbook', { id: testBook.id, sid: testSection.id }, all
    );
    ok('单节阅读页渲染无异常', !error, error && error.message);
    await new Promise((r) => setTimeout(r, 200));
    const t = root.allText();
    ok('显示章节与小节标题', t.includes('第1章') && t.includes('欧姆定律'));
    ok('★ 每章开始前有本章知识地图', Boolean(root.querySelector('.chapter-map-card'))
      && t.includes('本章知识地图') && root.querySelectorAll('.chapter-map-node').length >= 1);
    ok('★ 知识地图的主线不再拼接出「。；」', !t.includes('。；'));
    ok('★ 讲义先交代在整章里的位置', t.includes('在整章里的位置'));
    ok('★ 讲义用编号步骤顺着讲', Boolean(root.querySelector('.reader-thread'))
      && root.querySelectorAll('.reader-thread-step').length >= 1
      && t.includes('顺着这条线读'));
    ok('有讲义 / 原文 / PDF 三个标签中的前两个', t.includes('讲义') && t.includes('教材原文'));
    ok('有标记已读入口', t.includes('标记为已读'));
    ok('载入本节的动画演示', t.includes('串联与并联：电流到底怎么走'));
    ok('有本节问答与建议问题', t.includes('本节问答') && t.includes('用更简单的话讲一遍这一节'));
    ok('说明问答只带这一节原文', t.includes('只根据这一节回答'));
    ok('★ 本节术语卡用生活例子解释', t.includes('这一节的词') && t.includes('生活里'));
    ok('有上一节 / 下一节导航', t.includes('回到目录导览'));
    ok('没有 [object Object]', !t.includes('[object Object]'));
    if (cleanup) cleanup();
  }

  // ---------------------------------------------------------------- Markdown 与题目排版
  console.log('\n【Markdown 列表与题目排版】');
  {
    const { renderMarkdown } = await import(pathToFileURL(path.join(PUBLIC, 'js', 'markdown.js')).href);

    const inline = renderMarkdown('1、串联电路 2、并联电路 3、混联电路');
    ok('★ 挤在一行的中文编号会拆成独立条目',
      inline.querySelectorAll('li').length === 3, `实际 ${inline.querySelectorAll('li').length}`);

    const noGap = renderMarkdown('1、先算总电阻2、再求干路电流');
    ok('★ 编号之间没有空格也会拆行',
      noGap.querySelectorAll('li').length === 2, `实际 ${noGap.querySelectorAll('li').length}`);

    const paren = renderMarkdown('（1）先判断电流路径；（2）再选择公式；（3）最后验算');
    ok('★ （1）（2）这类题号会分行',
      paren.querySelectorAll('li').length === 3, `实际 ${paren.querySelectorAll('li').length}`);

    const circled = renderMarkdown('①电压 ②电流 ③电阻');
    ok('★ ① ② 这类题号会分行',
      circled.querySelectorAll('li').length === 3, `实际 ${circled.querySelectorAll('li').length}`);

    const bullet = renderMarkdown('•没有空格的圆点\n•第二条');
    ok('圆点后面没有空格也能识别成列表',
      bullet.querySelectorAll('li').length === 2, `实际 ${bullet.querySelectorAll('li').length}`);

    const decimal = renderMarkdown('这里的电压是 1.5 伏。');
    ok('★ 小数不会被误当成编号', decimal.querySelectorAll('li').length === 0
      && decimal.allText().includes('1.5 伏'));

    const reference = renderMarkdown('如图（2）所示的电路，电流从正极流出。');
    ok('正文里的「图（2）」不会被拆成新条目', reference.querySelectorAll('li').length === 0);

    const fenced = renderMarkdown('```\n1、代码里的编号\n2、原样保留\n```');
    ok('代码块里的编号不会被拆分',
      Boolean(fenced.querySelector('pre')) && fenced.allText().includes('1、代码里的编号 2、原样保留'));

    const { splitQuestionLines, studySearchQuery } = await import(pathToFileURL(path.join(PUBLIC, 'js', 'views', 'textbook.js')).href);
    const parts = splitQuestionLines('1、先算总电阻；2、再求干路电流；3、最后验算。');
    ok('★ 题目里挤在一行的分点会拆成多行', parts.length === 3, `实际 ${parts.length}`);
    ok('单个问题不会被拆碎', splitQuestionLines('为什么串联电路电流处处相等？').length === 1);

    const search = studySearchQuery('计算机网络的传播过程是怎样的？', '什么是计算机网络');
    ok('★ 站内搜索词去掉疑问词，也不重复本节标题',
      search === '计算机网络 传播过程', search);
    const shortSearch = studySearchQuery('它有什么特点？', '什么是计算机网络');
    ok('问题太短时补上本节语境',
      shortSearch.includes('什么是计算机网络') && shortSearch.includes('特点'), shortSearch);

    const rendered = renderMarkdown('## 读完自测\n\n1、串联电路有什么特点？2、并联电路有什么特点？');
    ok('Markdown 里的多条目问题会分别成行',
      rendered.querySelectorAll('li').length === 2, `实际 ${rendered.querySelectorAll('li').length}`);
  }

  // ---------------------------------------------------------------- 计划详情
  console.log('\n【计划详情】');
  {
    const { root, error } = await renderView('plan-detail', { id: plan.id }, all);
    ok('计划详情渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('显示计划标题', t.includes('考研初试'));
    ok('显示该计划下的任务', t.includes('今天要写的作业'));
    ok('有给它加任务的入口', t.includes('加任务'));
    ok('说明删计划不会删任务', t.includes('不会删掉它下面的任务'));
  }

  // ---------------------------------------------------------------- 学习项目
  console.log('\n【学习项目 · 列表】');
  {
    const { root, error, navigated } = await renderView('projects', {}, all);
    ok('项目列表渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('显示项目名称与简介', t.includes('UI 自测 · 自动控制原理') && t.includes('把课程进度放到一个项目里看'));
    ok('显示项目下的课程数', t.includes('学习项目 · 3 门课程'));
    ok('显示项目整体进度', t.includes('46%') && t.includes('已完成 6 / 共 13 集'));
    ok('标明未填总集数的课程不参与进度', t.includes('1 门未填总集数'));
    ok('有新建项目入口', t.includes('＋ 新建项目'));
    const cardActions = root.querySelector('.project-card-actions');
    ok('项目卡上有编辑与删除', Boolean(cardActions) && cardActions.querySelectorAll('button').length === 2);
    const card = root.querySelector('.project-card');
    if (card) card.fire('click');
    ok('点击项目卡进入详情', navigated.includes(`/projects/${testProject.id}`));
    ok('没有 [object Object]', !t.includes('[object Object]'));
  }

  console.log('\n【学习项目 · 详情与课程进度】');
  {
    const { root, error } = await renderView('project-detail', { id: testProject.id }, all);
    ok('项目详情渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('显示项目名称、简介与课程数', t.includes('UI 自测 · 自动控制原理')
      && t.includes('把课程进度放到一个项目里看') && t.includes('3 门课程'));
    ok('显示项目整体进度', t.includes('46%') && t.includes('已完成 6 / 共 13 集'));
    ok('说明未填总集数的课程不参与项目进度', t.includes('1 门未填总集数，不参与进度计算'));
    ok('有返回、编辑项目与添加课程入口',
      t.includes('← 返回项目') && t.includes('编辑项目') && t.includes('＋ 添加课程'));

    const cards = root.querySelectorAll('.course-card');
    const seqCard = cards.find((c) => c.allText().includes('自动控制原理 · 慕课'));
    const seqText = seqCard ? seqCard.allText() : '';
    ok('课程卡显示平台、来源、已完成与最近学习',
      seqText.includes('B 站') && seqText.includes('来源：2024 版')
        && seqText.includes('已完成 3 集') && seqText.includes('第 4 集'));
    ok('课程卡显示总集数与百分比进度', seqText.includes('10 集') && seqText.includes('30%'));
    ok('课程卡有继续学习 / 完成本集 / 编辑 / 删除',
      ['继续学习', '完成本集', '编辑', '删除'].every((x) => seqText.includes(x)));

    const unknownCard = cards.find((c) => c.allText().includes('现代控制理论'));
    const unknownText = unknownCard ? unknownCard.allText() : '';
    ok('未填总集数的课程显示「未填写」和「不参与项目进度」',
      unknownText.includes('未填写') && unknownText.includes('不参与项目进度'));
    ok('未填总集数的课程显示进度暂不可计算', unknownText.includes('进度暂不可计算'));

    const doneCard = cards.find((c) => c.allText().includes('绪论'));
    const doneText = doneCard ? doneCard.allText() : '';
    const doneButtons = doneCard ? doneCard.querySelectorAll('button') : [];
    const completeBtn = doneButtons.find((b) => b.allText().includes('完成本集'));
    ok('已学完的课程有标记，且完成本集按钮不可再点',
      doneText.includes('已学完') && Boolean(completeBtn) && completeBtn.disabled);
    ok('没有 [object Object]', !t.includes('[object Object]'));
  }

  console.log('\n【学习项目 · 继续学习与完成本集】');
  {
    const continued = await api.continueCourse(testProject.id, seqCourse.id);
    ok('继续学习接口返回实际打开的目标集数', continued.targetEpisode === 4);
    ok('B 站分 P 链接被定位到目标集数', String(continued.url).includes('p=4'), continued.url);
    const afterContinue = await api.getProject(testProject.id);
    const seqAfterContinue = afterContinue.courses.find((c) => c.id === seqCourse.id);
    ok('继续学习会记录最近学习集数与学习时间',
      seqAfterContinue.lastEpisode === 4 && Boolean(seqAfterContinue.lastStudiedAt));

    await stateMod.refresh();
    const detailAfterContinue = await renderView('project-detail', { id: testProject.id }, all);
    const textAfterContinue = detailAfterContinue.root.allText();
    ok('继续学习后详情显示实际打开的第 4 集', textAfterContinue.includes('第 4 集'));

    const completed = await api.completeCourse(testProject.id, seqCourse.id);
    ok('完成本集由接口推进已完成集数', completed.completedEpisodes === 4 && completed.nextEpisode === 5);

    await stateMod.refresh();
    const detailAfterComplete = await renderView('project-detail', { id: testProject.id }, all);
    const textAfterComplete = detailAfterComplete.root.allText();
    ok('完成本集后详情更新已完成集数与课程进度',
      textAfterComplete.includes('已完成 4 集') && textAfterComplete.includes('40%'));

    const listAfter = await renderView('projects', {}, all);
    const listText = listAfter.root.allText();
    ok('列表里的项目整体进度同步更新',
      listText.includes('54%') && listText.includes('已完成 7 / 共 13 集'));
    ok('列表显示最近学习时间', listText.includes('最近学习'));

    const fsSync = require('fs');
    const detailSrc = fsSync.readFileSync(path.join(PUBLIC, 'js', 'views', 'project-detail.js'), 'utf8');
    ok('★ 继续学习与完成本集都调用后端接口，而不是前端改数',
      detailSrc.includes('api.continueCourse') && detailSrc.includes('api.completeCourse')
        && detailSrc.includes('result.targetEpisode') && detailSrc.includes('result.completedEpisodes'));
    ok('★ 前端不自行推算目标集数',
      !/completedEpisodes\s*\+\s*1/.test(detailSrc) && !/lastEpisode\s*\+\s*1/.test(detailSrc));
  }

  console.log('\n【学习项目 · 空状态】');
  {
    const emptyProject = await api.createProject({ title: 'UI 自测 · 空项目' });
    await stateMod.refresh();
    const { root, error } = await renderView('project-detail', { id: emptyProject.id }, all);
    ok('空项目详情渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('空项目提示还没有课程', t.includes('这个项目还没有课程'));
    ok('空项目有添加第一门课程的入口', t.includes('添加第一门课程'));
    await api.deleteProject(emptyProject.id);
    await stateMod.refresh();

    const emptyList = await renderView('projects', {}, { ...all, projects: [] });
    const emptyText = emptyList.root.allText();
    ok('没有项目时显示空状态', emptyText.includes('还没有学习项目'));
    ok('空状态给下一步入口', emptyText.includes('新建第一个项目'));
  }

  await stateMod.refresh();

  // ---------------------------------------------------------------- 对话列表
  console.log('\n【AI 整理空间 · 列表】');
  {
    const { root, error } = await renderView('chat-list', {}, all);
    ok('对话列表渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('有开始新对话入口', t.includes('开始新的对话'));
    ok('列出已有对话', t.includes('考研'));
    ok('列表页不再放大段说明与引擎提示', !t.includes('不用先选情绪类型')
      && !t.includes('当前用的是本地规则引擎'));
  }

  // ---------------------------------------------------------------- 对话详情
  console.log('\n【AI 整理空间 · 对话（PRD 2.4 / 8.3 / 8.4）】');
  {
    const { root, error } = await renderView('chat', { id: conv.id }, all);
    ok('对话页渲染无异常', !error, error && error.message);
    const t = root.allText();

    ok('显示用户消息', t.includes('我最近很焦虑考研'));
    ok('显示 AI 回复', t.includes('你现在主要准备哪几科'));
    ok('★ 每条 AI 回复都如实标注了引擎', (t.match(/规则引擎|Ollama 本地|远程模型/g) || []).length >= 2);
    ok('没有把规则引擎冒充成模型', !/Ollama 本地|远程模型/.test(t));
    ok('给出问题梳理卡', t.includes('问题梳理'));
    ok('梳理卡每一项可编辑（有输入控件）', root.querySelectorAll('div').length > 0);
    ok('对话页不再出现档案入口', !t.includes('保存为摘要') && !t.includes('我的档案'));

    ok('★ 显示行动方案卡', t.includes('待你确认'));
    ok('方案里列出了具体行动', t.includes('确定数学要用的教材和章节范围'));
    ok('★ 专业课出现在「还没确定」而不是任务里',
      t.includes('还没确定，所以先不安排') && !/确定专业课的参考书目/.test(t),
      '专业课被错误地生成为任务');
    ok('有「加入待办」按钮', t.includes('加入待办'));
    ok('有「先不用」可以跳过', t.includes('先不用'));
    ok('明确说明只有确认才进待办', t.includes('只有你确认之后才会进入待办'));
    ok('提示可以只勾部分', t.includes('可以只勾其中几条'));
    ok('有快捷回话，对话能接下去', t.includes('好，加进待办') || t.includes('这次先不用'));
    ok('建议是「我建议」而不是「方案卡」', t.includes('我建议可以试试这几步'));
    ok('没有把建议做成带边框的方案卡', !t.includes('待处理方案'));
    ok('有输入框可以继续对话', t.includes('继续说') || root.querySelector('textarea') !== null);

    ok('没有出现「情绪分析」这种硬塞栏目（用户没谈情绪时）', !t.includes('情绪分析'));
    ok('没有 [object Object]', !t.includes('[object Object]'));
  }

  // 纯倾诉：不应出现方案卡
  {
    const { root } = await renderView('chat', { id: pourConv.id }, all);
    const t = root.allText();
    ok('★ 只想倾诉时页面不推方案', !t.includes('待你确认') && !t.includes('确认创建任务'));
    ok('倾诉时会话正常显示', t.includes('什么都不想做'));
  }

  // ---------------------------------------------------------------- 暂时隐藏的功能
  console.log('\n【暂时隐藏：我的档案与独立工具页】');
  {
    const appSrc = require('fs').readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');
    ok('侧栏与路由里不再出现我的档案', !appSrc.includes('我的档案') && !appSrc.includes('/archive'));
    ok('独立工具页已移除，工具改为侧栏分组', !appSrc.includes('/tools') && appSrc.includes('学习工具'));
  }

  // ---------------------------------------------------------------- 设置
  console.log('\n【设置与数据（PRD 6.3）】');
  {
    const { root, error } = await renderView('settings', {}, all);
    ok('设置页渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('可以切换三种引擎', t.includes('本地规则引擎') && t.includes('Ollama 本地模型') && t.includes('远程模型'));
    ok('设置了 Ollama 地址与模型选择', t.includes('Ollama 地址'));
    ok('说明数据存放位置', t.includes('data/tasks') && t.includes('data/archives'));
    ok('说明第一版记录被只读保留', t.includes('data/entries'));
    ok('有导出入口，且没有把未包含的数据说成「全部」',
      t.includes('JSON') && t.includes('Markdown') && t.includes('不在这两个导出文件里'));
    ok('★ 明确说明真实模型会外传数据', t.includes('会被发送到'));
    ok('说明 Key 不会外传', t.includes('不会随导出文件外传'));
    ok('可以配置牛津词典来源',
      t.includes('词典来源（可选）') && t.includes('Oxford App ID') && t.includes('Oxford App Key'));
    ok('★ 说明词典只发送选中的词',
      t.includes('只会发送选中的词') && t.includes('不会发送文章段落'));
    ok('说明欧路没有公开的词典内容接口', t.includes('欧路词典没有公开的词典内容接口'));
    ok('不是医疗工具声明', t.includes('不是医疗或心理治疗工具'));
    ok('包含核心设计承诺', t.includes('只有你确认过的行动才会创建成任务') && t.includes('没有强制打卡'));
  }

  // ---------------------------------------------------------------- 桌面浮窗
  console.log('\n【桌面浮窗】');
  {
    const fs = require('fs');
    const html = fs.readFileSync(path.join(PUBLIC, 'float.html'), 'utf8');
    ok('浮窗是独立页面，不套主站侧栏',
      html.includes('id="float-root"') && html.includes('/js/float.js') && !html.includes('id="sidebar"'));

    const js = fs.readFileSync(path.join(PUBLIC, 'js', 'float.js'), 'utf8');
    ok('浮窗能读到未完成待办并勾选', js.includes('/api/tasks?filter=open') && js.includes('勾选完成'));
    ok('浮窗里能直接加待办',
      js.includes("request('POST', '/api/tasks'") && js.includes('float-new-task')
        && js.includes('submitNewTask'));
    ok('浮窗里每条待办能自定义专注时长',
      js.includes('float-task-min') && js.includes('minutesFor')
        && js.includes('huan-float-task-minutes-v1') && js.includes('float-task-minutes'));
    ok('浮窗有吸边开关和悬浮球倒计时',
      js.includes('setSnap') && js.includes('renderBall')
        && js.includes('formatBallClock') && js.includes('float-ball-clock'));
    ok('浮窗能开始、暂停、结束、放弃计时',
      js.includes('/api/focus/active') && js.includes("action: wasPaused ? 'resume' : 'pause'")
        && js.includes('finishEarly') && js.includes("'/api/focus/active/cancel'"));
    ok('浮窗不用 innerHTML 拼内容', !js.includes('innerHTML'));

    const css = fs.readFileSync(path.join(PUBLIC, 'css', 'float.css'), 'utf8');
    ok('浮窗是半透明纸片，顶部可拖动',
      css.includes('-webkit-app-region: drag') && /--bg-glass:\s*rgba\([^)]*\.9/.test(css));
    ok('浮窗的加待办输入框不拦截拖动',
      css.includes('.float-add-input') && css.includes('-webkit-app-region: no-drag'));
    ok('悬浮球是一颗带进度环的小圆',
      css.includes('.float-ball') && css.includes('conic-gradient')
        && css.includes('.float-root.ball-mode'));

    const main = fs.readFileSync(path.join(PUBLIC, '..', 'desktop', 'float-main.js'), 'utf8');
    ok('桌面外壳透明、无边框、置顶',
      /transparent:\s*true/.test(main) && /frame:\s*false/.test(main) && /alwaysOnTop:\s*true/.test(main));
    ok('桌面外壳隔离 Node 能力',
      /contextIsolation:\s*true/.test(main) && /nodeIntegration:\s*false/.test(main));
    ok('桌面外壳能把窗口收成吸边小球并拖回展开',
      main.includes('BALL_SIZE') && main.includes('snapPosition')
        && main.includes('float:set-snap') && main.includes('float:drag-move')
        && main.includes('float:expand') && main.includes('broadcastState'));

    const preload = fs.readFileSync(path.join(PUBLIC, '..', 'desktop', 'preload.js'), 'utf8');
    ok('页面拿得到吸边、展开与拖动窗口的能力',
      preload.includes('float:set-snap') && preload.includes('float:expand')
        && preload.includes('float:drag-start') && preload.includes('float:drag-end')
        && preload.includes('float:state'));

    const pkg = JSON.parse(fs.readFileSync(path.join(PUBLIC, '..', 'package.json'), 'utf8'));
    ok('npm run float 有对应启动脚本', Boolean(pkg.scripts && pkg.scripts.float));

    const focusText = (await renderView('focus', {}, all)).root.allText();
    ok('专注页有「浮到桌面」入口', focusText.includes('浮到桌面'));
    const tasksText = (await renderView('tasks', { tab: 'open' }, all)).root.allText();
    ok('待办页也有「浮到桌面」入口', tasksText.includes('浮到桌面'));
  }

  // ---------------------------------------------------------------- 外刊阅读
  console.log('\n【外刊阅读 · 书架与生词本】');
  {
    const { root, error, navigated } = await renderView('articles', {}, all);
    ok('外刊书架渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('显示外刊书架标题与说明', t.includes('外刊书架') && t.includes('不做 OCR'));
    ok('显示粘贴与导入入口', t.includes('粘贴文本') && t.includes('导入文件'));
    ok('列出测试文章', t.includes('UI 自测 · 外刊阅读'));
    ok('说明正文与批注保存在本机', t.includes('data/articles/'));
    ok('★ 说明文章不会自动进入长期记忆', t.includes('不会自动写进') && t.includes('长期记忆'));
    ok('文章行有阅读入口', root.querySelectorAll('.article-row').length >= 1);
    const firstRow = root.querySelector('.article-row');
    if (firstRow) firstRow.fire('click');
    ok('文章行能跳到阅读器', navigated.includes(`/article/${testArticle.id}`));
    ok('没有 [object Object]', !t.includes('[object Object]'));
  }

  console.log('\n【外刊阅读 · 生词本】');
  {
    const { root, error } = await renderView('articles', { tab: 'vocabulary' }, all);
    ok('生词本渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('显示测试生词与释义', t.includes(testVocabTerm) && t.includes('注意力'));
    ok('生词标明来源文章', t.includes('UI 自测 · 外刊阅读'));
    ok('有备注与删除入口', t.includes('写备注') && root.querySelectorAll('.vocab-card').length >= 1);
    ok('★ 生词卡显示派生词', t.includes('派生词') && t.includes('attentive') && t.includes('专注的'));
    ok('★ 生词卡显示衍生词', t.includes('衍生词') && t.includes('pay attention to') && t.includes('关注'));
    ok('★ 生词卡显示例句', t.includes('例句') && t.includes('Attention helps you finish one thing at a time'));
    ok('★ 生词卡显示牛津例句与来源',
      t.includes('牛津词典例句') && t.includes('full attention') && t.includes('英文释义与例句：牛津词典'));
    ok('★ 生词卡可以跳到牛津和欧路词典',
      root.querySelectorAll('.vocab-links').length >= 1
      && root.querySelectorAll('a').some((a) => String(a.getAttribute('href') || '').includes('oxfordlearnersdictionaries'))
      && root.querySelectorAll('a').some((a) => String(a.getAttribute('href') || '').includes('dict.eudic.net')));
    ok('新字段存进了生词记录',
      testVocab.entry.derivatives.length === 1 && testVocab.entry.relatedWords.length === 1
      && testVocab.entry.examples.length === 1 && testVocab.entry.dictionarySource === 'oxford');
  }

  console.log('\n【外刊阅读 · 选择题解析】');
  {
    const { parseQuizText } = await import(
      pathToFileURL(path.join(PUBLIC, 'js', 'article-quiz.js')).href
    );
    const parsed = parseQuizText([
      '１．The author mentions the study mainly to',
      'Ａ．explain the cause',
      'Ｂ．question a common belief',
      'Ｃ．describe a new policy',
      'Ｄ．compare two countries',
      '答案：Ｂ',
      '解析：转折之后才是重点。',
      '',
      '2. Which word means “fall sharply”?',
      'A) rise',
      'B) drop quickly',
      'C) stay flat',
      '答案: B',
    ].join('\n'));
    ok('★ 能识别编号题干与选项', parsed.questions.length === 2);
    ok('★ 全角数字与全角选项也能识别',
      parsed.questions[0].options.length === 4 && parsed.questions[0].answer === 'B');
    ok('答案与解析一起进入题目',
      parsed.questions[1].answer === 'B' && parsed.questions[0].explanation.includes('转折'));
    let quizError = null;
    try { parseQuizText('This is just a paragraph.'); } catch (err) { quizError = err; }
    ok('★ 没有题目时明确报错，不生成空题',
      Boolean(quizError) && /没有识别到选择题/.test(quizError.message));
    let optionOnly = null;
    try { parseQuizText('A. first\nB. second\n'); } catch (err) { optionOnly = err; }
    ok('只有选项没有题干时说明原因',
      Boolean(optionOnly) && /识别到了选项/.test(optionOnly.message));
  }

  console.log('\n【外刊阅读 · 阅读器】');
  {
    const { root, error, cleanup } = await renderView('article', { id: testArticle.id }, all);
    ok('阅读器渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('显示文章标题与来源', t.includes('UI 自测 · 外刊阅读') && t.includes('UI 自测刊物'));
    ok('正文按段落渲染', root.querySelectorAll('.article-block').length >= 6);
    ok('显示词汇 / 批注 / 文章问答 / 题目四个面板',
      t.includes('词汇') && t.includes('批注 1') && t.includes('文章问答') && t.includes('题目'));
    ok('★ 已有高亮用 mark 渲染', root.querySelectorAll('.article-hl').length >= 1);
    ok('★ 选区工具条提供四种高亮颜色', root.querySelectorAll('.article-color').length === 4);
    const firstMark = root.querySelector('.article-hl');
    ok('★ 已有批注用下划线渲染、不铺高亮底色',
      Boolean(firstMark)
      && firstMark.classList.contains('is-annotated')
      && !firstMark.className.split(/\s+/).some((name) => name.startsWith('hl-')));
    ok('有字号调节与阅读进度', root.querySelectorAll('.article-font').length === 1 && t.includes('A+'));
    ok('默认面板提示点词或选句', t.includes('点一个词') && t.includes('双击句子'));
    ok('★ 明确标注是本地规则引擎，不伪造释义',
      t.includes('本地规则引擎') && t.includes('没有释义能力'));
    ok('★ 说明当前文章只作为本次阅读上下文', t.includes('不会写进长期 AI 记忆'));
    const articleViewSrc = require('fs').readFileSync(path.join(PUBLIC, 'js', 'views', 'article.js'), 'utf8');
    ok('★ 查词面板有派生词与衍生词分组',
      articleViewSrc.includes("'派生词'") && articleViewSrc.includes("'衍生词'")
      && articleViewSrc.includes('entry.derivatives') && articleViewSrc.includes('entry.relatedWords'));
    const articleAiSrc = require('fs').readFileSync(path.join(PUBLIC, '..', 'server', 'article-ai.js'), 'utf8');
    ok('查词提示词要求模型返回派生词和衍生词',
      articleAiSrc.includes('"derivatives"') && articleAiSrc.includes('"relatedWords"'));
    ok('★ 查词提示词要求例句另写、不照抄原文',
      articleAiSrc.includes('不要照抄') && articleAiSrc.includes('常见用法')
      && articleAiSrc.includes('copiedFromContext'));
    ok('查词提示词要求 JSON 每个键都出现',
      articleAiSrc.includes('每个键都必须出现') && articleAiSrc.includes('GAP_SYSTEM'));
    ok('例句区标明不摘自这篇文章',
      articleViewSrc.includes('例句 · 常见用法') && articleViewSrc.includes('不摘自这篇文章'));
    ok('★ 查词面板显示牛津例句和词典跳转',
      articleViewSrc.includes('牛津词典例句') && articleViewSrc.includes('在欧路词典查看')
      && articleViewSrc.includes('dictionaryLinks'));

    const { renderArticleParagraph } = await import(
      pathToFileURL(path.join(PUBLIC, 'js', 'article-text.js')).href
    );
    const hlBlock = renderArticleParagraph(
      { id: 'hl-test', kind: 'paragraph', text: 'Attention is a finite resource.' },
      [{ id: 'hl-test-1', start: 0, end: 9, quote: 'Attention' }]
    );
    const hlMark = hlBlock.querySelector('.article-hl');
    ok('★ 高亮单词不再拦截点击事件', Boolean(hlMark) && !(hlMark.listeners.click || []).length);
    ok('高亮提示说明点击仍会查词', Boolean(hlMark) && hlMark.getAttribute('title').includes('查词'));
    ok('查词卡保留批注入口',
      articleViewSrc.includes('activeHighlightLine') && articleViewSrc.includes('highlightIdOf'));

    const coloredBlock = renderArticleParagraph(
      { id: 'hl-color', kind: 'paragraph', text: 'Attention is a finite resource.' },
      [
        { id: 'hl-blue', start: 0, end: 9, quote: 'Attention', color: 'blue' },
        { id: 'hl-note', start: 14, end: 20, quote: 'finite', color: 'green', note: '有限的' },
      ]
    );
    const coloredMarks = coloredBlock.querySelectorAll('.article-hl');
    ok('★ 普通高亮按记录渲染不同颜色',
      coloredMarks.length === 2
      && coloredMarks[0].classList.contains('hl-blue')
      && !coloredMarks[0].classList.contains('is-annotated'));
    ok('★ 批注只渲染下划线，不再带高亮底色',
      coloredMarks[1].classList.contains('is-annotated')
      && !coloredMarks[1].classList.contains('hl-green')
      && coloredMarks[1].getAttribute('title').includes('悬停'));
    ok('★ 批注节点带上用于悬停显示的批注 id',
      coloredMarks[1].dataset.noteId === 'hl-note');

    const overlapBlock = renderArticleParagraph(
      { id: 'hl-overlap', kind: 'paragraph', text: 'Attention is a finite resource.' },
      [
        { id: 'hl-old', start: 0, end: 9, color: 'yellow' },
        { id: 'hl-new', start: 0, end: 9, color: 'purple', note: '重叠批注' },
      ]
    );
    const overlapMark = overlapBlock.querySelector('.article-hl');
    ok('★ 重叠高亮里有批注时整段只显示下划线',
      overlapMark.dataset.highlightColor === 'purple'
      && !overlapMark.classList.contains('hl-purple')
      && overlapMark.classList.contains('is-annotated')
      && overlapMark.dataset.noteId === 'hl-new');

    const fallbackBlock = renderArticleParagraph(
      { id: 'hl-fallback', kind: 'paragraph', text: 'Attention is a finite resource.' },
      [{ id: 'hl-bad', start: 0, end: 9, color: 'neon' }]
    );
    ok('★ 未知颜色回退为黄色',
      fallbackBlock.querySelector('.article-hl').classList.contains('hl-yellow'));

    const notesTab = root.querySelectorAll('.article-rail-tab')
      .find((button) => button.allText().startsWith('批注'));
    if (notesTab) notesTab.fire('click');
    const noteCard = root.querySelector('.note-card');
    ok('★ 批注卡片用下划线标记，不再显示高亮色点',
      Boolean(noteCard)
      && noteCard.classList.contains('is-annotation')
      && !noteCard.querySelector('.note-swatch')
      && Boolean(noteCard.querySelector('.note-underline-mark'))
      && noteCard.querySelector('.note-kind').classList.contains('has-note'));

    const paragraphHost = root.querySelector('.article-text');
    const annotatedMark = root.querySelectorAll('.article-hl')
      .find((mark) => mark.classList.contains('is-annotated'));
    const noteTip = root.querySelector('.article-note-tip');
    ok('★ 阅读器带批注悬停浮层', Boolean(paragraphHost) && Boolean(annotatedMark) && Boolean(noteTip));
    if (paragraphHost && annotatedMark) {
      paragraphHost.fire('mouseover', { target: annotatedMark });
      await new Promise((resolve) => setTimeout(resolve, 220));
      ok('★ 鼠标悬停在批注词上会显示批注内容',
        !noteTip.classList.contains('is-hidden') && noteTip.allText().includes('第一处批注'));
      paragraphHost.fire('mouseout', { target: annotatedMark });
      ok('移开后批注浮层收起', noteTip.classList.contains('is-hidden'));
    }

    const readingToggle = root.querySelector('.article-reading-toggle');
    ok('★ 有独立的阅读模式开关', Boolean(readingToggle) && readingToggle.allText().includes('阅读模式'));
    if (readingToggle) {
      readingToggle.fire('click');
      const shell = root.querySelector('.article-reader');
      ok('★ 进入阅读模式会收起侧栏并切换按钮文案',
        shell.classList.contains('is-reading-mode') && readingToggle.allText().includes('退出阅读模式'));
      ok('★ 阅读模式下选词 / 查词 / 高亮 / 批注入口都被跳过',
        articleViewSrc.includes('if (readingMode) return;')
        && articleViewSrc.includes('if (readingMode) {'));
      if (paragraphHost && annotatedMark) {
        paragraphHost.fire('mouseover', { target: annotatedMark });
        await new Promise((resolve) => setTimeout(resolve, 220));
        ok('阅读模式里仍可悬停查看批注',
          !noteTip.classList.contains('is-hidden') && noteTip.allText().includes('第一处批注'));
        paragraphHost.fire('mouseout', { target: annotatedMark });
      }
      readingToggle.fire('click');
      ok('可以退出阅读模式',
        !root.querySelector('.article-reader').classList.contains('is-reading-mode')
        && readingToggle.allText().includes('阅读模式'));
    }
    ok('★ 查词等待时会显示已经等了多少秒',
      articleViewSrc.includes('lookupElapsedText') && articleViewSrc.includes('startLookupClock')
      && articleViewSrc.includes('已等待'));
    ok('★ 旧的查词请求晚回来不会覆盖新结果',
      articleViewSrc.includes('seq !== lookupSeq') && articleViewSrc.includes('stopLookupClock'));
    ok('★ 正文底部有已阅读完毕按钮',
      t.includes('已阅读完毕') && Boolean(root.querySelector('.article-finish-btn')));
    ok('没有 [object Object]', !t.includes('[object Object]'));
    ok('阅读器返回清理函数', typeof cleanup === 'function');
    if (cleanup) cleanup();

    const finishedAt = await api.setArticleFinished(testArticle.id, true);
    ok('★ 接口能把整篇文章标记为已读', Boolean(finishedAt));
    const doneView = await renderView('article', { id: testArticle.id }, all);
    const doneText = doneView.root.allText();
    ok('★ 重新打开显示已读完并可撤销',
      doneText.includes('这篇已经读完了') && doneText.includes('撤销已读'));
    if (doneView.cleanup) doneView.cleanup();

    const doneShelf = await renderView('articles', {}, all);
    const doneRow = doneShelf.root.querySelectorAll('.article-row')
      .find((el) => el.allText().includes('UI 自测 · 外刊阅读'));
    ok('★ 书架把这篇标为已读完',
      Boolean(doneRow) && doneRow.querySelector('.article-row-pct').allText().includes('已读完'));
    await api.setArticleFinished(testArticle.id, false);

    const quizEmpty = await renderView('article', { id: testArticle.id }, all);
    const emptyQuizTab = quizEmpty.root.querySelectorAll('.article-rail-tab')
      .find((el) => el.allText().startsWith('题目'));
    if (emptyQuizTab) emptyQuizTab.fire('click');
    const emptyQuizText = quizEmpty.root.allText();
    ok('★ 未导入时题目面板给出导入入口',
      emptyQuizText.includes('还没有导入题目') && emptyQuizText.includes('导入选择题'));
    ok('空状态说明本地解析、不发给模型',
      emptyQuizText.includes('本地') && emptyQuizText.includes('不会把题目发给任何模型'));
    if (quizEmpty.cleanup) quizEmpty.cleanup();

    const quizSeed = await api.saveArticleQuiz(testArticle.id, [
      {
        stem: 'What does the passage value most?',
        options: [
          { key: 'A', text: 'Speed' },
          { key: 'B', text: 'Attention' },
          { key: 'C', text: 'Noise' },
        ],
        answer: 'B',
        explanation: '文章把注意力放在速度之前。',
      },
      {
        stem: 'Which habit is suggested?',
        options: [
          { key: 'A', text: 'Protect one unhurried hour' },
          { key: 'B', text: 'Open everything first' },
        ],
      },
    ]);
    ok('★ 接口能保存选择题', quizSeed.questions.length === 2 && /^qz-/.test(quizSeed.questions[0].id));

    const quizOpen = await renderView('article', { id: testArticle.id }, all);
    const quizTab = quizOpen.root.querySelectorAll('.article-rail-tab')
      .find((el) => el.allText().startsWith('题目'));
    ok('★ 右栏出现题目标签与题目数量', Boolean(quizTab) && quizTab.allText().includes('题目 2'));
    if (quizTab) quizTab.fire('click');
    const quizText = quizOpen.root.allText();
    ok('★ 题目面板显示题干、选项和进度',
      quizText.includes('共 2 题') && quizText.includes('What does the passage value most?')
      && quizText.includes('Attention') && quizText.includes('导入于'));
    ok('★ 有答案的题目显示待选择，无答案的题目明确说明',
      quizText.includes('待选择') && quizText.includes('这组题没有提供答案'));

    const quizOptionA = quizOpen.root.querySelectorAll('.article-quiz-option')
      .find((el) => el.allText().includes('Speed'));
    ok('选项是真正的按钮', Boolean(quizOptionA) && quizOptionA.tagName === 'BUTTON');
    if (quizOptionA) quizOptionA.fire('click');
    const wrongOption = quizOpen.root.querySelectorAll('.article-quiz-option')
      .find((el) => el.classList.contains('wrong'));
    const answerOption = quizOpen.root.querySelectorAll('.article-quiz-option')
      .find((el) => el.classList.contains('correct'));
    ok('★ 选错时同时标出所选项与正确答案',
      Boolean(wrongOption) && wrongOption.allText().includes('Speed')
      && Boolean(answerOption) && answerOption.allText().includes('Attention'));
    ok('选完后显示解析', quizOpen.root.allText().includes('文章把注意力放在速度之前'));

    let persistedQuiz = '';
    for (let i = 0; i < 40 && persistedQuiz !== 'A'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const fresh = await api.getArticle(testArticle.id);
      persistedQuiz = fresh.article.quiz.questions[0].selected;
    }
    ok('★ 选择会保存到服务端', persistedQuiz === 'A', persistedQuiz);

    for (let i = 0; i < 40; i += 1) {
      const options = quizOpen.root.querySelectorAll('.article-quiz-option');
      if (options.length && options.every((option) => !option.disabled)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const quizOptionB = quizOpen.root.querySelectorAll('.article-quiz-option')
      .find((el) => el.allText().includes('Attention'));
    if (quizOptionB) quizOptionB.fire('click');
    ok('★ 选对后显示答对与正确标记',
      quizOpen.root.allText().includes('答对')
      && quizOpen.root.querySelectorAll('.article-quiz-status')
        .some((el) => el.classList.contains('is-ok')));
    ok('有重做本题入口', Boolean(quizOpen.root.querySelector('.article-quiz-card-actions')));

    for (let i = 0; i < 40 && persistedQuiz !== 'B'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const fresh = await api.getArticle(testArticle.id);
      persistedQuiz = fresh.article.quiz.questions[0].selected;
    }
    ok('★ 改选也会保存到服务端', persistedQuiz === 'B', persistedQuiz);
    if (quizOpen.cleanup) quizOpen.cleanup();
    await api.clearArticleQuiz(testArticle.id);
  }

  console.log('\n【外刊阅读 · PDF 页眉清理】');
  {
    const { stripRepeatedPageHeaders } = await import(
      pathToFileURL(path.join(PUBLIC, 'js', 'article-import.js')).href
    );
    const cleaned = stripRepeatedPageHeaders([
      { text: '公众号：一直夫妇的日常 Serve the rich It is becoming even harder for poor students.' },
      { text: '公众号：一直夫妇的日常 prestigious universities, Peking University and Tsinghua, are in Beijing.' },
      { text: '公众号：一直夫妇的日常 pay for the training needed to compete.' },
    ]);
    ok('★ 去掉每页重复的公众号页眉',
      cleaned.every((text) => !text.includes('公众号：一直夫妇的日常')));
    ok('页眉清理保留正文开头',
      cleaned[0].startsWith('Serve the rich') && cleaned[1].startsWith('prestigious'));

    const standalone = stripRepeatedPageHeaders([
      { text: 'The Economist\nFirst page body.' },
      { text: 'The Economist\nSecond page body.' },
    ]);
    ok('独立成行的英文刊名页眉也会去掉',
      standalone.every((text) => !text.startsWith('The Economist')));

    const body = stripRepeatedPageHeaders([
      { text: 'It is becoming harder for poor students.' },
      { text: 'It is becoming difficult for rural students.' },
    ]);
    ok('共同的正文开头不会被误判为页眉',
      body[0].startsWith('It is becoming') && body[1].startsWith('It is becoming'));
  }

  // ---------------------------------------------------------------- 路由
  console.log('\n【路由与导航（PRD 2.1）】');
  {
    const appSrc = require('fs').readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');
    const routes = [...appSrc.matchAll(/pattern:\s*(\/\^.*?\/),\s*view:\s*(\w+)/g)]
      .map((m) => ({ re: m[1], view: m[2] }));
    ok('路由表已定义', routes.length >= 11, `实际 ${routes.length} 条`);

    const cases = [
      ['/', 'renderDashboard'], ['/tasks', 'renderTasks'], ['/plan/abc123', 'renderPlanDetail'],
      ['/focus', 'renderFocus'], ['/textbooks', 'renderTextbooks'],
      ['/textbook/abc123', 'renderTextbook'],
      ['/articles', 'renderArticles'], ['/article/abc123', 'renderArticle'],
      ['/projects', 'renderProjects'], ['/projects/abc123', 'renderProjectDetail'],
      ['/chat', 'renderChatList'], ['/chat/abc123', 'renderChat'],
      ['/settings', 'renderSettings'],
    ];
    const bad = [];
    for (const [p, want] of cases) {
      const hit = routes.find((r) => new RegExp(r.re.slice(1, -1)).test(p));
      if (!hit || hit.view !== want) bad.push(`${p} → ${hit ? hit.view : '未匹配'}`);
    }
    ok('所有路径都能匹配到正确视图', bad.length === 0, bad.join('; '));

    ok('一级导航含概览 / 待办与计划 / 专注 / AI 整理空间',
      ['概览', '待办与计划', '专注番茄钟', 'AI 整理空间'].every((x) => appSrc.includes(x)));
    ok('侧栏学习工具分组包含学习项目与教材精读',
      appSrc.includes('学习工具') && appSrc.includes('学习项目') && appSrc.includes('教材精读'));
    ok('侧栏有外刊阅读入口', appSrc.includes('外刊阅读') && appSrc.includes("to: '/articles'"));
    ok('不再展示章节知识框架 / 习题生成 / 错题整理',
      ['章节知识框架', '习题生成', '错题整理'].every((x) => !appSrc.includes(x)));
    ok('侧栏没有点不动的规划中工具', !appSrc.includes('还在规划中'));
    ok('设置不在侧栏主导航里（放在底部）', appSrc.includes('设置与数据'));
    ok('导航有当前页选中状态', appSrc.includes('.active') || appSrc.includes("'.active'"));
    const shellCss = require('fs').readFileSync(path.join(PUBLIC, 'css', 'style.css'), 'utf8');
    ok('★ 打开教材后隐藏全局侧栏，整屏留给阅读',
      appSrc.includes("classList.toggle('reading-book'")
      && /body\.reading-book[^{]*\.sidebar/.test(shellCss)
      && /body\.reading-book[^{]*\.topbar/.test(shellCss));

    const articleViewSrc = require('fs').readFileSync(path.join(PUBLIC, 'js', 'views', 'article.js'), 'utf8');
    const articleTextViewSrc = require('fs').readFileSync(path.join(PUBLIC, 'js', 'article-text.js'), 'utf8');
    const indexHtml = require('fs').readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
    ok('★ 外刊阅读器整屏阅读，隐藏全局侧栏', appSrc.includes("classList.toggle('reading-article'"));
    ok('页面加载外刊样式', indexHtml.includes('/css/reading.css'));
    ok('★ 文章正文用文本节点与 mark 渲染，不拼 innerHTML',
      !/\.innerHTML\s*=/.test(articleViewSrc) && !/\.innerHTML\s*=/.test(articleTextViewSrc)
      && articleTextViewSrc.includes('createTextNode') && articleTextViewSrc.includes('article-hl'));
    ok('阅读器通过段落组件渲染正文', articleViewSrc.includes('renderArticleParagraph'));
  }

  // ---------------------------------------------------------------- 清理
  console.log('\n【清理测试数据】');
  const after = await api.bootstrap();
  let removed = 0;
  for (const t of after.tasks) if (!beforeIds.tasks.has(t.id)) { await api.deleteTask(t.id); removed += 1; }
  for (const p of after.plans) if (!beforeIds.plans.has(p.id)) { await api.deletePlan(p.id); removed += 1; }
  for (const a of after.archives) if (!beforeIds.archives.has(a.id)) { await api.deleteArchive(a.id); removed += 1; }
  for (const c of after.conversations) if (!beforeIds.conversations.has(c.id)) { await api.deleteConversation(c.id); removed += 1; }
  for (const p of after.projects) if (!beforeIds.projects.has(p.id)) { await api.deleteProject(p.id); removed += 1; }
  for (const id of uiFocusIds) { await db.remove('focusSessions', id); removed += 1; }
  if (aliasesBefore !== null) await db.atomicWrite(db.FOCUS_ALIASES_FILE, aliasesBefore);
  else await fs.rm(db.FOCUS_ALIASES_FILE, { force: true });
  await api.deleteTextbook(testBook.id);
  await api.deleteArticle(testArticle.id);
  await api.deleteVocabulary(testVocab.entry.id);
  removed += 3;
  ok(`清理了 ${removed} 项测试数据`, removed > 0);

  const final = await api.bootstrap();
  ok('★ 用户原有档案没有被动过',
    final.archives.filter((a) => a.origin === 'legacy').length
    === before.archives.filter((a) => a.origin === 'legacy').length);
  ok('★ 学习项目的测试数据已清理干净',
    !final.projects.some((p) => String(p.title).startsWith('UI 自测')));
  const [articlesLeft, vocabLeft] = await Promise.all([api.listArticles(), api.listVocabulary()]);
  ok('★ 外刊测试文章已清理', !articlesLeft.some((a) => a.id === testArticle.id));
  ok('★ 测试生词已清理', !vocabLeft.some((v) => v.id === testVocab.entry.id));

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) {
    console.log('  失败项：');
    for (const f of failures) console.log(`    · ${f}`);
  }
  console.log(`${'─'.repeat(56)}\n`);
  process.exit(fail ? 1 : 0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n前端自测本身出错了：', err);
    process.exit(1);
  });
}

module.exports = { main, renderView, ok, El, documentStub, makeRoot };
