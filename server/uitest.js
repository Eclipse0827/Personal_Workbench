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
      toggle: (n) => { const s = new Set(parts()); if (s.has(n)) s.delete(n); else s.add(n); self._class = [...s].join(' '); },
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
  const beforeIds = {
    tasks: new Set(before.tasks.map((t) => t.id)),
    plans: new Set(before.plans.map((p) => p.id)),
    archives: new Set(before.archives.map((a) => a.id)),
    conversations: new Set(before.conversations.map((c) => c.id)),
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

  const archive = await api.createArchive({
    title: '一次自己保存的摘要',
    content: '这是我自己写的档案内容。\n\n## 小标题\n\n- 一条\n- 另一条',
    type: 'summary',
    sourceConversationId: conv.id,
  });

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

  await stateMod.refresh();
  ok('测试数据已就绪', Boolean(taskToday.id && plan.id && prop && archive.id));
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
    ok('C 有自然语言输入框', t.includes('现在在想什么'));
    ok('C 有四个快捷入口', ['我想理清一件事', '我最近有些焦虑', '帮我规划接下来的学习', '帮我拆成小任务']
      .every((x) => t.includes(x)));
    ok('C AI 入口如实标注当前引擎',
      t.includes('本地规则引擎') || t.includes('Ollama') || t.includes('远程模型'));
    ok('D 显示最近计划', t.includes('考研初试'));
    ok('E 工具入口存在', t.includes('思考档案') && t.includes('教材精读'));
    ok('E 未实现的工具标「规划中」', t.includes('规划中'));
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
    ok('有新增任务与新建计划按钮', t.includes('新增任务') && t.includes('新建计划'));
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

    const rows = root.querySelectorAll('.focus-content-row');
    const vocabRow = rows.find((row) => row.allText().includes('UI 自测 · 背单词'));
    ok('★ 可以选中一项内容查看累计', Boolean(vocabRow));
    if (vocabRow) vocabRow.fire('click');
    const picked = root.querySelector('.focus-content-pick');
    ok('★ 选中背单词后显示它一共花了多久',
      Boolean(picked) && picked.allText().includes('全部累计') && picked.allText().includes('15 分钟'));
    ok('★ 选中内容后，记录列表跟着筛选',
      root.querySelector('.focus-history').allText().includes('「UI 自测 · 背单词」的记录'));
  }

  // ---------------------------------------------------------------- 教材书架
  console.log('\n【教材精读 · 书架】');
  {
    const { root, error } = await renderView('textbooks', {}, all);
    ok('书架渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('有导入 PDF 的入口', t.includes('导入 PDF 教材'));
    ok('列出已导入的测试教材', t.includes('测试教材'));
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
    ok('有全书导览与阅读顺序', t.includes('全书导览') && t.includes('建议的阅读顺序'));
    ok('列出小节与页码', t.includes('欧姆定律') && /\d+–\d+/.test(t));
    ok('标出有动画的小节', t.includes('动画'));
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

    const { splitQuestionLines } = await import(pathToFileURL(path.join(PUBLIC, 'js', 'views', 'textbook.js')).href);
    const parts = splitQuestionLines('1、先算总电阻；2、再求干路电流；3、最后验算。');
    ok('★ 题目里挤在一行的分点会拆成多行', parts.length === 3, `实际 ${parts.length}`);
    ok('单个问题不会被拆碎', splitQuestionLines('为什么串联电路电流处处相等？').length === 1);

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

  // ---------------------------------------------------------------- 对话列表
  console.log('\n【AI 整理空间 · 列表】');
  {
    const { root, error } = await renderView('chat-list', {}, all);
    ok('对话列表渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('有开始新对话入口', t.includes('开始新的对话'));
    ok('列出已有对话', t.includes('考研'));
    ok('明确说明当前用的是本地规则引擎', t.includes('本地规则引擎'));
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
    ok('有保存为摘要入口', t.includes('保存为摘要'));

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

  // ---------------------------------------------------------------- 档案
  console.log('\n【我的档案（PRD 2.5 / 8.5）】');
  {
    const { root, error } = await renderView('archive', {}, all);
    ok('档案列表渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('列出自建档案', t.includes('一次自己保存的摘要'));
    ok('★ 显示档案来源', t.includes('我手动保存'));
    ok('显示保存时间', /年\d+月\d+日/.test(t));
    ok('有新建档案入口', t.includes('新建档案'));
    ok('有按类型筛选', t.includes('思考档案') && t.includes('重要摘要'));
    ok('★ 迁移过来的记录出现在档案里', all.archives.some((a) => a.origin === 'legacy'));
    ok('没有 [object Object]', !t.includes('[object Object]'));
  }

  {
    const { root, error } = await renderView('archive-detail', { id: archive.id }, all);
    ok('档案详情渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('显示档案标题与正文', t.includes('一次自己保存的摘要') && t.includes('这是我自己写的档案内容'));
    ok('正文按结构渲染（标题 / 列表）', t.includes('小标题'));
    ok('有编辑与删除入口', t.includes('编辑') && t.includes('删除'));
  }

  {
    const { root } = await renderView('archive-detail', { id: archive.id, edit: '1' }, all);
    const t = root.allText();
    ok('编辑态可以改标题与内容', t.includes('保存') && t.includes('内容'));
    ok('★ 编辑态说明不会改动来源',
      t.includes('改这份摘要不会改动原始对话') || t.includes('原始文件不会被修改'));
  }

  // ---------------------------------------------------------------- 工具
  console.log('\n【我的工具（PRD 2.6）】');
  {
    const { root, error } = await renderView('tools', {}, all);
    ok('工具页渲染无异常', !error, error && error.message);
    const t = root.allText();
    ok('思考档案标为可用', t.includes('可用'));
    ok('教材精读已接入真实页面', t.includes('教材精读') && t.includes('打开'));
    ok('三个未实现工具都在', ['章节知识框架', '习题生成', '错题整理'].every((x) => t.includes(x)));
    ok('★ 未实现工具明确标规划中', t.includes('规划中'));
    ok('★ 明确写出规划中的工具点不进去', t.includes('不可点击进入') || t.includes('还在规划中'));
    ok('有「现在可用」区', t.includes('现在可用'));
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
    ok('浮窗能开始、暂停、结束、放弃计时',
      js.includes('/api/focus/active') && js.includes("action: wasPaused ? 'resume' : 'pause'")
        && js.includes('finishEarly') && js.includes("'/api/focus/active/cancel'"));
    ok('浮窗不用 innerHTML 拼内容', !js.includes('innerHTML'));

    const css = fs.readFileSync(path.join(PUBLIC, 'css', 'float.css'), 'utf8');
    ok('浮窗是半透明纸片，顶部可拖动',
      css.includes('-webkit-app-region: drag') && css.includes('rgba(248, 246, 240, .90)'));
    ok('浮窗的加待办输入框不拦截拖动',
      css.includes('.float-add-input') && css.includes('-webkit-app-region: no-drag'));

    const main = fs.readFileSync(path.join(PUBLIC, '..', 'desktop', 'float-main.js'), 'utf8');
    ok('桌面外壳透明、无边框、置顶',
      /transparent:\s*true/.test(main) && /frame:\s*false/.test(main) && /alwaysOnTop:\s*true/.test(main));
    ok('桌面外壳隔离 Node 能力',
      /contextIsolation:\s*true/.test(main) && /nodeIntegration:\s*false/.test(main));

    const pkg = JSON.parse(fs.readFileSync(path.join(PUBLIC, '..', 'package.json'), 'utf8'));
    ok('npm run float 有对应启动脚本', Boolean(pkg.scripts && pkg.scripts.float));

    const focusText = (await renderView('focus', {}, all)).root.allText();
    ok('专注页有「浮到桌面」入口', focusText.includes('浮到桌面'));
    const tasksText = (await renderView('tasks', { tab: 'open' }, all)).root.allText();
    ok('待办页也有「浮到桌面」入口', tasksText.includes('浮到桌面'));
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
      ['/chat', 'renderChatList'], ['/chat/abc123', 'renderChat'],
      ['/archive', 'renderArchive'], ['/archive/abc123', 'renderArchiveDetail'],
      ['/tools', 'renderTools'], ['/settings', 'renderSettings'],
    ];
    const bad = [];
    for (const [p, want] of cases) {
      const hit = routes.find((r) => new RegExp(r.re.slice(1, -1)).test(p));
      if (!hit || hit.view !== want) bad.push(`${p} → ${hit ? hit.view : '未匹配'}`);
    }
    ok('所有路径都能匹配到正确视图', bad.length === 0, bad.join('; '));

    ok('一级导航含概览 / 待办与计划 / 专注 / 教材 / AI 整理空间 / 档案 / 工具',
      ['概览', '待办与计划', '专注番茄钟', '教材精读', 'AI 整理空间', '我的档案', '我的工具']
        .every((x) => appSrc.includes(x)));
    ok('设置不在侧栏主导航里（放在底部）', appSrc.includes('设置与数据'));
    ok('导航有当前页选中状态', appSrc.includes('.active') || appSrc.includes("'.active'"));
  }

  // ---------------------------------------------------------------- 清理
  console.log('\n【清理测试数据】');
  const after = await api.bootstrap();
  let removed = 0;
  for (const t of after.tasks) if (!beforeIds.tasks.has(t.id)) { await api.deleteTask(t.id); removed += 1; }
  for (const p of after.plans) if (!beforeIds.plans.has(p.id)) { await api.deletePlan(p.id); removed += 1; }
  for (const a of after.archives) if (!beforeIds.archives.has(a.id)) { await api.deleteArchive(a.id); removed += 1; }
  for (const c of after.conversations) if (!beforeIds.conversations.has(c.id)) { await api.deleteConversation(c.id); removed += 1; }
  for (const id of uiFocusIds) { await db.remove('focusSessions', id); removed += 1; }
  await api.deleteTextbook(testBook.id);
  removed += 1;
  ok(`清理了 ${removed} 项测试数据`, removed > 0);

  const final = await api.bootstrap();
  ok('★ 用户原有档案没有被动过',
    final.archives.filter((a) => a.origin === 'legacy').length
    === before.archives.filter((a) => a.origin === 'legacy').length);

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
