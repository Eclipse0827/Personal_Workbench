'use strict';

/**
 * AI 服务模块（PRD 2.4 / 4.x / 6.3）
 * ---------------------------------------------------------------
 * 一个统一的、可替换的接口：
 *
 *     respond({ conversation, userText, settings }) -> {
 *       reply, problemCard, proposal, provider, warning
 *     }
 *
 * 两条实现：
 *   · mock —— 本地模拟引擎，**明确标识**为模拟，绝不冒充真实模型
 *   · real —— OpenAI 兼容接口，失败时回退 mock 并如实告知
 *
 * 模拟引擎遵守 PRD 的对话规则：
 *   · 用户不必先选情绪类型，也不填固定问卷
 *   · 追问数量由上下文决定；同一问题不会重复问第二遍
 *   · 只想倾诉时不强行制定计划
 *   · 明确要求计划时尽量直接给初步方案；只在「不确定会改变行动方向」时问一个关键问题
 *   · 只针对用户提到的科目/范围规划，不擅自扩展（例如不擅自生成专业课任务）
 *   · 不确定的科目/事项放进「待确认」，不塞进今日待办
 *
 * 这里复用第一版就写好的 analyzer：分句、事实/猜测/担忧/未知的拆分、
 * 思考模式识别。它是「模拟引擎」真正的分析内核，不是一堆固定话术。
 */

const { dissect, detectPatterns } = require('./analyzer');
const { newProposal, todayStr, dateOnly } = require('./models');
const tools = require('./tools');
const llm = require('./llm');
const profile = require('./profile');
const { detectCrisis, crisisReply } = require('./safety');

// 本地 Ollama 的整轮超时。以前这里直接用了一个从未定义的常量，
// 结果每次走到 Ollama 改写都会抛 ReferenceError，然后被当成「连不上」回退。
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 20000;

/**
 * 危机输入的回复。形状和 mockRespond 的返回保持一致，
 * 但内容全部由代码给出：不给方案、不引用学习数据、不调用模型。
 */
function crisisResult() {
  return {
    reply: crisisReply(),
    problemCard: null,
    proposal: null,
    provider: 'mock',
    intent: 'pour',
    asked: [],
    pendingIntent: null,
    contextUsed: false,
    contextFactText: '',
    contextFactLines: [],
    meta: { safety: true },
  };
}

// ================================================================ 意图与领域

const INTENT_RULES = [
  {
    id: 'plan',
    // 明确要求「帮我规划/安排/制定计划」
    re: /(帮我|给我|能不能|可以)(规划|安排|制定|排一下|做个计划|列个计划|拆成|拆一下)|(怎么|如何)(开始|安排|规划|下手|备考)|规划一下|制定.{0,4}计划|不知道从哪(里)?开始|无从下手|帮我拆/,
  },
  {
    id: 'execute',
    // 已经知道要做什么，只需要拆细
    re: /(已经|都)(知道|清楚|想好)(要|该)?(做什么|干什么)|帮我拆成(小)?(任务|步骤)|下一步(做|该)|具体要做什么/,
  },
  {
    id: 'analyze',
    re: /(帮我)?(理清|梳理|分析|搞清楚|想明白)|为什么我|搞不清|纠结|不知道该怎么想|帮我看看/,
  },
  {
    id: 'pour',
    re: /(只想|想)(倾诉|说说|说出来|吐槽|发泄)|就是(很难受|很累|烦|难受)|撑不住|想哭|不想(分析|听道理|被教育)/,
  },
];

/**
 * 判断这句话里有没有「具体要做的事」的线索。
 * 有的话就不该当成纯倾诉 —— 用户明明说了一件有截止日期的事。
 */
const TASK_SIGNAL_RE = /(要交|还没写|没写完|没准备|截止|deadline|ddl|明早|明天要|后天|下周|答辩|PPT|ppt|汇报|论文|作业|考试|面试|报名|复习|背单词|刷题|做不完|来不及)/;

/** 明确的「我不想被分析/我只想说」信号 */
const EXPLICIT_POUR_RE = /(只想|想)(倾诉|说说|说出来|吐槽|发泄)|不想听道理|别劝我|不想(被)?分析|只是想有个人听/;

function detectIntent(text, history = []) {
  const t = String(text || '');
  for (const rule of INTENT_RULES) {
    if (rule.re.test(t)) return rule.id;
  }
  // 明确说只想说说话，就一定是倾诉
  if (EXPLICIT_POUR_RE.test(t)) return 'pour';

  const emotional = (t.match(/焦虑|难受|害怕|担心|烦|累|压力|崩溃|睡不着|心慌|慌|委屈/g) || []).length;
  const asksQuestion = /[？?]|怎么办|如何|要不要|该不该|能不能/.test(t);
  const hasTask = TASK_SIGNAL_RE.test(t);

  // 有具体的事要办：即使带着情绪，也是「需要理清」而不是「只想倾诉」。
  // 之前这里会因为出现「焦虑」两个字就判成倾诉，导致明明有作业要交却什么都不给。
  if (hasTask) return asksQuestion ? 'analyze' : 'analyze';
  if (emotional >= 2 && !asksQuestion) return 'pour';
  if (asksQuestion) return 'analyze';
  return emotional > 0 ? 'pour' : 'analyze';
}

const DOMAINS = [
  { id: 'kaoyan', label: '考研', re: /考研|初试|复试|上岸|专业课|数学一|数学二|英语一|英语二|政治|真题|择校|招生/ },
  { id: 'study', label: '课业', re: /作业|期末|考试|论文|课程|复习|预习|实验|报告|答辩|学分/ },
  { id: 'job', label: '求职', re: /找工作|求职|简历|面试|投递|实习|offer|招聘/ },
  { id: 'project', label: '项目交付', re: /项目|交付|上线|汇报|需求|开发|bug|迭代|发布/ },
  { id: 'self', label: '自我整理', re: /焦虑|情绪|状态|迷茫|没动力|拖延|刷手机|专注/ },
];

function detectDomain(text) {
  const t = String(text || '');
  for (const d of DOMAINS) if (d.re.test(t)) return d;
  return { id: 'general', label: '这件事', re: /./ };
}

/** 提取已知信息：只认用户真的写出来的，不猜 */
const MODULE_DEFS = [
  { key: 'math', label: '数学', re: /数学一|数学二|数学三|数学|高数|高等数学|线代|线性代数|概率论|微积分/ },
  { key: 'english', label: '英语', re: /英语一|英语二|英语|单词|词汇|阅读|作文|长难句|听力|翻译/ },
  { key: 'politics', label: '政治', re: /政治|马原|毛中特|史纲|思修/ },
  { key: 'major', label: '专业课', re: /专业课|专业综合|408|数据结构|操作系统|计算机网络|计算机组成/ },
];

/**
 * 提取已知信息：只认用户真的写出来的，不猜。
 *
 * 关键细节（PRD 4.2「不把不确定的考试科目当作已经确定」）：
 * 「专业课还没定」里提到了专业课，但它**不是**已确定的科目。
 * 所以这里要按分句判断否定语境，把「已确定」和「还没定」分开。
 */
const NEGATION_RE = /(还没|没|未|不)(定|确定|选好|开始|想好)|不确定|待定|没想好|还没想|暂时不|先不考/;

function moduleStatus(text) {
  const confirmed = new Set();
  const undecided = new Set();
  // 按分句切：一个分句里的否定只影响这个分句里提到的科目
  const clauses = String(text || '').split(/[，,。！？；;、\n]/).map((s) => s.trim()).filter(Boolean);
  for (const clause of clauses) {
    for (const m of MODULE_DEFS) {
      if (!m.re.test(clause)) continue;
      if (NEGATION_RE.test(clause)) undecided.add(m.key);
      else confirmed.add(m.key);
    }
  }
  // 同一科目如果一处说确定、一处说没定，按「还没定」处理更稳妥
  for (const k of undecided) confirmed.delete(k);
  return { confirmed: [...confirmed], undecided: [...undecided] };
}

function extractSlots(text) {
  const t = String(text || '');
  const { confirmed, undecided } = moduleStatus(t);
  const timeHint = /(每天|每日).{0,6}(小时|钟头)/.test(t) ? t.match(/(每天|每日).{0,6}(小时|钟头)/)[0]
    : /(晚上|下班后|周末|早上|睡前)/.test(t) ? t.match(/(晚上|下班后|周末|早上|睡前)/)[0]
      : null;
  const deadline = t.match(/(\d{1,2})\s*月/)?.[0] || t.match(/(还有|剩)\s*(\d{1,3})\s*天/)?.[0] || null;
  const schoolUndecided = /(学校|院校|目标)(还)?(没|未)(选好|定|确定)|还没选(好|定)|不知道选哪个学校/.test(t);
  const levelUnknown = /(基础|底子)(不|比较|很)?(好|差|一般|薄弱)|零基础|刚开始|从零/.test(t);
  return {
    /** 已经确定的科目——只有这些才允许生成任务 */
    modules: confirmed,
    /** 提到过但还没定的科目——只放进「待确认」，不生成任务 */
    undecided,
    timeHint,
    deadline,
    schoolUndecided,
    levelUnknown,
  };
}

// ================================================================ 学习上下文

/**
 * 阶段 2A 的分工：
 *   · Context Builder 只读地汇总真实记录
 *   · 规则引擎把和当前问题相关的记录写进草稿
 *   · Ollama 只改写表达；数字、日期、进度必须和草稿一致
 *   · 用户只是在表达情绪时，不主动把数据塞进回复
 */

const LEARNING_DATA_ASK_RE = /(学了多久|学习时长|专注了?多久|专注记录|学习记录|学了多长时间|花了多少时间|进度|完成了多少|做了多少|待办|任务|课程|学到哪|复习到哪|这周|上周|最近\s*\d+\s*天|系统记录|我的数据|学得怎么样|学习怎么样|学习情况|学习状态)/;

const EMOTION_HINT_RE = /(焦虑|担心|害怕|紧张|难受|很累|好累|累死|烦|崩溃|压力|睡不着|失眠|心慌|想哭|委屈|撑不住|不想做)/g;

function wantsLearningData(text) {
  return LEARNING_DATA_ASK_RE.test(String(text || ''));
}

function emotionHintCount(text) {
  return (String(text || '').match(EMOTION_HINT_RE) || []).length;
}

function formatDuration(seconds) {
  const minutes = Math.round((Number(seconds) || 0) / 60);
  if (minutes <= 0) return '不到 1 分钟';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

function contextTopics(text) {
  const t = String(text || '');
  return {
    focus: /(学了多久|学习时长|专注了?多久|专注记录|学习记录|学了多长时间|花了多少时间|时间花)/.test(t),
    project: /(进度|课程|集数|学到哪|项目)/.test(t),
    tasks: /(待办|任务|完成|做了多少|勾掉)/.test(t),
    overall: /(学得怎么样|学习怎么样|学习情况|学习状态|最近怎么样|数据|记录|总结)/.test(t),
  };
}

/**
 * 只把和这一轮问题有关的事实写进草稿，而不是把整份摘要倒出来。
 * 「没有记录」一律写成「系统里没有记录」，绝不写成「没有学习」。
 */
function buildContextNote(context, { userText = '', intent = 'analyze' } = {}) {
  if (!context || !context.selected) return '';
  const facts = context.facts || {};
  const topics = contextTopics(userText);
  const planWanted = intent === 'plan' || intent === 'execute';
  const askedAnything = topics.focus || topics.project || topics.tasks || topics.overall;
  if (!askedAnything && !planWanted) return '';

  const project = facts.project;
  const focus = facts.focus;
  const tasks = facts.tasks;
  const projectNamed = project && String(userText).includes(project.title);
  const lines = [];

  if (topics.project || topics.overall || projectNamed || (planWanted && project)) {
    if (!project) {
      if (topics.project) lines.push('你没有选择学习项目，系统无法回答课程进度。');
    } else if (!project.courses.length) {
      lines.push(`系统里「${project.title}」还没有课程记录。`);
    } else if (!project.progress.calculable) {
      lines.push(`系统里「${project.title}」有 ${project.courses.length} 门课程，但没有填总集数，算不出整体进度。`);
    } else {
      lines.push(`系统里「${project.title}」共 ${project.progress.totalEpisodes} 集，已完成 ${project.progress.completedEpisodes} 集（${project.progress.percent}%）。`);
      if (project.progress.coursesWithoutTotal > 0) {
        lines.push(`另有 ${project.progress.coursesWithoutTotal} 门课程未填总集数，不参与这个进度。`);
      }
    }
  }

  if (topics.focus || topics.overall || (planWanted && !project)) {
    if (!focus) {
      if (topics.focus) lines.push('你没有选择专注记录，系统无法回答学习时长。');
    } else if (focus.sessionCount === 0) {
      lines.push(`最近 ${focus.windowDays} 天系统里没有专注记录——这只是没有记录，不能说明你没有学习。`);
    } else {
      lines.push(`最近 ${focus.windowDays} 天系统里有 ${focus.sessionCount} 次专注记录，共 ${formatDuration(focus.totalSeconds)}。`);
      if (project && focus.linkedToProject) {
        if (focus.linkedToProject.sessions === 0) {
          lines.push(`这些专注记录都没有关联到「${project.title}」，不能据此判断这个项目的学习时长。`);
        } else if (focus.unlinked && focus.unlinked.sessions > 0) {
          lines.push(`其中 ${focus.linkedToProject.sessions} 次能关联到「${project.title}」（${focus.linkedToProject.minutes} 分钟），另外 ${focus.unlinked.sessions} 次没有关联、未计入。`);
        } else {
          lines.push(`其中 ${focus.linkedToProject.sessions} 次能关联到「${project.title}」，共 ${focus.linkedToProject.minutes} 分钟。`);
        }
      }
    }
  }

  if (topics.tasks) {
    if (!tasks) {
      lines.push('你没有选择待办数据，系统无法回答任务完成情况。');
    } else if (tasks.today.total === 0 && tasks.overdue.total === 0
      && (!tasks.windowDone || tasks.windowDone.count === 0)) {
      lines.push('待办里系统没有今天或所选范围内的记录——这只是没有记录，不能说明你没有做事。');
    } else {
      lines.push(`待办今天 ${tasks.today.total} 项：完成 ${tasks.today.done} 项，未完成 ${tasks.today.open} 项；逾期 ${tasks.overdue.total} 项。`);
      if (tasks.windowDone && tasks.windowDone.count > 0) {
        lines.push(`最近 ${tasks.windowDone.days} 天完成 ${tasks.windowDone.count} 项。`);
      }
    }
  }

  if (topics.overall && !lines.length) {
    lines.push('系统没有知识点、错题和复习进度的记录，这部分无法判断。');
  }

  if (!lines.length) return '';
  return lines.map((line) => `· ${line}`).join('\n');
}

/**
 * 这一轮该不该引用数据。
 * 只有用户在问记录、或者明确要计划时才用；纯情绪表达和倾诉不强行引用。
 */
function shouldUseContext(context, userText, intent) {
  if (!context || !context.selected) return false;
  const dataRequested = wantsLearningData(userText);
  if (intent === 'pour') return dataRequested;
  if (intent === 'analyze' && !dataRequested && emotionHintCount(userText) > 0) return false;
  return true;
}

// ================================================================ 事实一致性

const CN_DIGITS = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

/** 小模型可能把数字写成中文，统一成阿拉伯数字再比较 */
function cnToNumber(raw) {
  const s = String(raw || '').trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (!/^[零〇一二两三四五六七八九十百]+$/.test(s)) return null;
  if (s.includes('百')) {
    const [head, tail] = s.split('百');
    const hundreds = head ? (CN_DIGITS[head] ?? 0) : 1;
    if (!tail) return hundreds * 100;
    if (tail.includes('十')) {
      const [tensPart, onesPart] = tail.split('十');
      const tens = tensPart ? (CN_DIGITS[tensPart] ?? 0) : 1;
      return hundreds * 100 + tens * 10 + (onesPart ? (CN_DIGITS[onesPart] ?? 0) : 0);
    }
    return hundreds * 100 + (CN_DIGITS[tail] ?? 0);
  }
  if (s.includes('十')) {
    const [tensPart, onesPart] = s.split('十');
    const tens = tensPart ? (CN_DIGITS[tensPart] ?? 0) : 1;
    return tens * 10 + (onesPart ? (CN_DIGITS[onesPart] ?? 0) : 0);
  }
  return CN_DIGITS[s] ?? null;
}

const FACT_NUMBER = '(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百]+)';
const FACT_DATE_RE = new RegExp('(\\d{4})\\s*[-/年]\\s*(\\d{1,2})\\s*[-/月]\\s*(\\d{1,2})\\s*日?', 'g');
const FACT_MD_RE = new RegExp('(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日', 'g');
const FACT_MONTH_RE = new RegExp('(\\d{1,2})\\s*月', 'g');
const FACT_COURSE_RE = new RegExp(`${FACT_NUMBER}\\s*门\\s*课程`, 'g');
const FACT_COUNT_RE = new RegExp(`${FACT_NUMBER}\\s*个\\s*(任务|待办|项目|课程|小时|分钟)`, 'g');
const FACT_UNIT_RE = new RegExp(`${FACT_NUMBER}\\s*(分钟|个小时|小时|钟头|天|项|条|集|节|%)`, 'g');

function normalizeFactUnit(unit) {
  return unit === '个小时' || unit === '钟头' ? '小时' : unit;
}

/**
 * 只抽取「学习事实」相关的数字：时长、集数、任务数量、进度、日期。
 * 普通语言里的数字（「分成 2 步」「深呼吸 3 次」）不参与一致性检查。
 */
function extractFactTokens(text) {
  let rest = String(text || '');
  const tokens = new Set();
  const take = (re, build) => {
    rest = rest.replace(re, (...args) => {
      const token = build(args);
      if (token) tokens.add(token);
      return ' ';
    });
  };

  take(FACT_DATE_RE, (m) => {
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `date:${Number(m[1])}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  });
  take(FACT_MD_RE, (m) => {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `date:*${month}-${day}`;
  });
  take(FACT_MONTH_RE, (m) => {
    const month = Number(m[1]);
    return month >= 1 && month <= 12 ? `month:${month}` : null;
  });
  take(FACT_COURSE_RE, (m) => {
    const n = cnToNumber(m[1]);
    return n === null ? null : `${n}门课程`;
  });
  take(FACT_COUNT_RE, (m) => {
    const n = cnToNumber(m[1]);
    return n === null ? null : `${n}个${m[2]}`;
  });
  take(FACT_UNIT_RE, (m) => {
    const n = cnToNumber(m[1]);
    return n === null ? null : `${n}${normalizeFactUnit(m[2])}`;
  });
  return [...tokens];
}

function collectAllowedFacts({ context, draft, userText }) {
  const allowed = new Set();
  const add = (value) => {
    for (const token of extractFactTokens(value)) allowed.add(token);
  };
  add(userText);
  if (context) add(context.text);
  if (draft) {
    add(draft.reply);
    add(draft.contextFactText);
    add(draft.problemCard ? JSON.stringify(draft.problemCard) : '');
    for (const action of (draft.proposal && draft.proposal.actions) || []) {
      add(`${action.title || ''} ${action.detail || ''} ${action.doneStandard || ''}`);
      if (action.estimateMinutes) allowed.add(`${Number(action.estimateMinutes)}分钟`);
      if (action.scheduledDate) allowed.add(`date:${action.scheduledDate}`);
      if (action.dueDate) allowed.add(`date:${action.dueDate}`);
    }
  }
  return allowed;
}

/**
 * 校验模型改写里没有出现「没有依据的学习数字」。
 * 只比较学习事实，不因为普通数字误判。
 */
function checkFactConsistency(text, { context = null, draft = null, userText = '' } = {}) {
  const allowed = collectAllowedFacts({ context, draft, userText });
  const used = extractFactTokens(text);
  const unknown = used.filter((token) => !allowed.has(token));
  if (unknown.length) {
    return {
      ok: false,
      reason: `出现了没有依据的数字：${unknown.slice(0, 3).join('、')}`,
      unknown,
    };
  }
  return { ok: true, reason: '', used };
}

/** 改写不能把草稿里的事实漏掉 */
function checkFactCoverage(text, factText) {
  const required = extractFactTokens(factText);
  const present = new Set(extractFactTokens(text));
  const missing = required.filter((token) => !present.has(token));
  return { ok: missing.length === 0, missing };
}

// ================================================================ 行动模板

/**
 * 行动建议库。
 * 原则（PRD 4.1 / 4.2）：
 *   · 只给少量近期行动，不做完整每日打卡表
 *   · 只针对用户提到的模块，不擅自扩展到没确定的科目
 *   · 每条都能真正做掉，带时长或完成标准
 */
const ACTION_TEMPLATES = {
  math: [
    { title: '确定数学要用的教材和章节范围', detail: '把要考的章节列出来，今天只做这一件事。范围不清时做题都是白做。', estimateMinutes: 20, doneStandard: '手上有一份章节清单' },
    { title: '做一组基础题（20–30 题）', detail: '只做当前章节，不跳着做。做完立刻对答案。', estimateMinutes: 45, doneStandard: '对完答案，知道错了几道' },
    { title: '把今天的错题记下来，只写错因', detail: '不用抄整道题，写「这题错在把定义域算漏了」就够了。', estimateMinutes: 10, doneStandard: '错题本上有今天的 1–2 条' },
  ],
  english: [
    { title: '背一组核心词汇（50 个）', detail: '只过一遍不算背。当天早晚各看一次。', estimateMinutes: 25, doneStandard: '能认出今天这 50 个词' },
    { title: '精读一篇真题阅读', detail: '不追求速度。先做题，再逐句翻译，标出不认识的词。', estimateMinutes: 50, doneStandard: '全文能通顺说出意思' },
    { title: '分析 3 个长难句', detail: '每个句子写出主谓宾，再看修饰成分挂在哪里。', estimateMinutes: 20, doneStandard: '3 个句子能自己拆开' },
  ],
  politics: [
    { title: '过一遍一个章节的知识框架', detail: '先搭骨架再看细节，否则背了就忘。', estimateMinutes: 30, doneStandard: '能不看书画出这一章的框架' },
    { title: '做对应章节的选择题', detail: '错的题回到书上找原文，标记出来。', estimateMinutes: 25, doneStandard: '错题都找到对应原文' },
  ],
  major: [
    { title: '确认专业课的参考书目和考纲', detail: '专业课每个学校都不一样，这一步没做之前，别急着买资料。', estimateMinutes: 30, doneStandard: '有一份确定的书目清单' },
    { title: '整理这一章的核心概念', detail: '只写概念和它解决的问题，不抄书。', estimateMinutes: 40, doneStandard: '能用自己的话说清 5 个概念' },
  ],
  study: [
    { title: '把这次作业拆成三块，只做第一块', detail: '先做最小的一块，让自己从「完全没动」变成「动了一点」。', estimateMinutes: 20, doneStandard: '第一块写完，哪怕很粗糙' },
    { title: '先写一版最丑的初稿', detail: '目标是「有东西在纸上」，不是「写得好」。允许它糟糕。', estimateMinutes: 30, doneStandard: '有一版可以改的东西' },
    { title: '定一个 25 分钟计时，只碰这一个文件', detail: '手机放远一点。时间到了就停，不用有负罪感。', estimateMinutes: 25, doneStandard: '专注了 25 分钟' },
  ],
  job: [
    { title: '把简历改成这一版：只针对一个岗位', detail: '一份简历投所有岗位，等于没有简历。', estimateMinutes: 40, doneStandard: '有一份针对具体岗位的简历' },
    { title: '列出 5 个要投的岗位', detail: '写下来，不要只在脑子里想。', estimateMinutes: 20, doneStandard: '纸上有 5 个具体岗位' },
  ],
  project: [
    { title: '把当前这一步写成一句话', detail: '「这一步做完，什么就成立了？」写出来。', estimateMinutes: 10, doneStandard: '有一句话的目标' },
    { title: '只推进最小可交付的那一块', detail: '先让它能跑起来，再管好不好看。', estimateMinutes: 45, doneStandard: '有一个能演示的版本' },
  ],
  self: [
    { title: '把手机关到另一个房间，做 15 分钟', detail: '不是靠意志力，是靠物理隔离。15 分钟就够。', estimateMinutes: 15, doneStandard: '有 15 分钟没有碰手机' },
    { title: '写下你现在真正在躲的那件事', detail: '往往不是任务本身，是「做不好」的感觉。写出来会轻一点。', estimateMinutes: 10, doneStandard: '纸上有一句话' },
  ],
  general: [
    { title: '用一句话写下这件事到底是什么', detail: '写不清楚往往就是卡住的原因。', estimateMinutes: 10, doneStandard: '有一句话' },
    { title: '找一个 15 分钟就能做完的最小动作', detail: '不求解决整件事，只求让局面动一点。', estimateMinutes: 15, doneStandard: '这件事动了一下' },
  ],
};

/**
 * 按领域和已知模块挑行动。这是「不擅自扩展」的落点：
 * 用户只说数学和英语，就只给数学和英语的任务。
 */
function pickActions(domain, slots, { max = 4 } = {}) {
  const out = [];
  const push = (group, count) => {
    const pool = ACTION_TEMPLATES[group] || [];
    for (const t of pool.slice(0, count)) {
      if (!out.some((x) => x.title === t.title)) out.push({ ...t, group });
    }
  };

  if (domain.id === 'kaoyan') {
    // 只给用户明确提到的模块。一个都没提到时，退回到「先确认范围」这类通用起步
    const known = slots.modules.filter((m) => m !== 'major');
    if (known.length === 0) {
      push('general', 2);
      out.push({
        title: '先确认这次到底考哪几科',
        detail: '科目没定下来之前，任何详细的复习安排都可能是白做。',
        estimateMinutes: 15,
        doneStandard: '写下确定的科目清单',
        group: 'general',
      });
    } else {
      for (const m of known) push(m, m === 'math' ? 2 : 1);
    }
    // 专业课只有用户自己提到时才给
    if (slots.modules.includes('major')) push('major', 1);
  } else if (domain.id === 'study') {
    push('study', 3);
  } else if (domain.id === 'job') {
    push('job', 2);
  } else if (domain.id === 'project') {
    push('project', 2);
  } else if (domain.id === 'self') {
    push('self', 2);
    push('general', 1);
  } else {
    push('general', 2);
    push('study', 1);
  }

  return out.slice(0, max).map((a, i) => ({
    id: `act-${i + 1}`,
    title: a.title,
    detail: a.detail || '',
    scheduledDate: i < 2 ? todayStr() : todayStr(1),
    dueDate: null,
    planId: null,
    estimateMinutes: a.estimateMinutes || null,
    doneStandard: a.doneStandard || '',
    createdTaskId: null,
  }));
}

// ================================================================ 问题梳理卡

/**
 * 问题梳理卡（PRD 2.4）
 * 关键：**只呈现当前问题真正需要的内容**。
 * 用户没谈情绪，就不给「情绪分析」栏；没有不确定项，就不给「尚未确定」栏。
 */
function buildProblemCard(text, intent) {
  const d = dissect(text);
  const patterns = detectPatterns(text, d);

  const card = {
    summary: '',
    expressed: [],   // 用户已经表达的困难
    unknowns: [],    // 尚未确定的信息
    directions: [],  // 值得考虑的方向
    nextSteps: [],   // 可采取的下一步
    /** 只有在用户确实谈到情绪时才出现这一栏 */
    emotion: null,
  };

  const worries = d.worries.map((w) => w.text);
  const guesses = d.guesses.map((g) => g.text);
  const unknowns = d.unknowns.map((u) => u.text);
  const needs = d.needs.map((n) => n.text);

  // 「已经表达的困难」= 担忧 + 猜测
  const difficulties = [...new Set([...worries, ...guesses])].filter(Boolean).slice(0, 5);
  // 拆句可能把「不知道怎么开始」这类归到「未知」，但它同时也是明确的困难，
  // 所以单独认一遍，别让梳理卡看起来空着。
  const stuckHits = [...new Set(
    (text.match(/(不知道怎么[^。！？，,]{1,12}|不知道从哪[^。！？，,]{0,8}|无从下手|不知道该怎么办|卡在[^。！？，,]{1,10})/g) || [])
      .map((s) => s.trim())
  )];
  card.expressed = [...new Set([...difficulties, ...stuckHits])].slice(0, 5);
  card.unknowns = [...new Set(unknowns)].filter(Boolean).slice(0, 4);

  // 概括：不要只是把用户的原句抄一遍
  if (worries.length) {
    card.summary = `你现在主要卡在：${worries[0].replace(/[。！？]$/, '')}。`;
  } else if (stuckHits.length) {
    card.summary = `你知道要面对这件事，但还没找到从哪里开始——这一步本身就是最难的。`;
  } else if (unknowns.length) {
    card.summary = `还有几件事没有确定，先把它们列清楚，再决定先动哪一件。`;
  } else {
    card.summary = '你写下了一些还不算具体的东西，这没关系，先放着。';
  }

  if (patterns.length) {
    card.directions = patterns.filter((p) => p.hint).slice(0, 2).map((p) => p.hint);
  }
  if (needs.length) card.directions.push(`你真正在意的可能是：${needs[0]}`);

  // 情绪栏：只有用户自己提到情绪或身体反应时才给。
  // 注意这里必须直接扫原文——「很焦虑」可能被归进「未知」而不是「担忧」，
  // 只看担忧列表会漏掉它。
  const bodyHit = patterns.find((p) => p.id === 'physical');
  const emotionRe = /(焦虑|担心|害怕|紧张|难受|很累|好累|烦|崩溃|压得|压力|睡不着|失眠|心慌|喘不上|没胃口|想哭)/;
  const emotionHits = [...new Set([...worries, ...guesses, ...unknowns, ...stuckHits])].filter((w) => emotionRe.test(w));
  const textHasEmotion = emotionRe.test(text);
  if (bodyHit || textHasEmotion || emotionHits.length) {
    card.emotion = {
      notice: bodyHit
        ? '你的话里出现了身体反应。先照顾这个，再处理事情——睡不好时判断会更容易偏向坏结果。'
        : '你提到了一些情绪。它不需要被马上解决，但它值得被看见。',
      items: bodyHit ? [...bodyHit.evidence] : (emotionHits.length ? emotionHits.slice(0, 3) : [text.trim().slice(0, 60)]),
    };
  }

  if (intent !== 'pour' && intent !== 'analyze') card.nextSteps = [];
  return card;
}

// ================================================================ 回复文案

/**
 * 对话文案的三条原则（来自实际使用反馈：像在填表、不像在聊天）：
 *   1. 先接住情绪，再谈事情。哪怕只一句。
 *   2. 不要「宣布我要做什么」（「我们直接看怎么安排」这种），
 *      而是「我建议你可以……」，像人在给建议。
 *   3. 结尾留一个邀请，让对话能继续，而不是给完一句就结束。
 *
 * 每一段会被前端拆成一条独立的对话气泡，所以段落要短。
 */
const EMPATHY = {
  pour: [
    '嗯，我在。',
    '我听到了。',
    '先别急着把它讲清楚。',
    '这种时候还要撑着，挺累的。',
  ],
  analyze: [
    '嗯，这种一直悬着的感觉最消耗人。',
    '你已经在心里翻来覆去想很多遍了。',
    '这件事听起来不难，难的是它一直没落地。',
    '能把它写下来，已经比在脑子里转圈好一点了。',
  ],
  plan: [
    '好，我们慢慢来。',
    '那我们把它落到地上。',
    '行，先把范围收小一点。',
  ],
  execute: [
    '好，那我陪你把它拆开。',
    '行，一件一件来。',
  ],
};

/** 承接情绪的一句，尽量用用户自己说过的内容 */
function empathyFor(intent, card, seed) {
  const base = pick(EMPATHY[intent] || EMPATHY.analyze, seed);
  const first = card && card.expressed && card.expressed[0];
  if (!first) return base;
  const trimmed = String(first).replace(/[。！？，,]$/, '').slice(0, 40);
  return `${base}\n\n你说「${trimmed}」——这句我记下了。`;
}

function pick(list, seed) {
  return list[Math.abs(seed) % list.length];
}

/**
 * 组织一次回复。返回段落数组，前端会一段一个气泡。
 *
 * 关键变化（对应「不要给指令才生成」的反馈）：
 * 方案不再需要用户先说「帮我拆成小任务」。只要这轮的话题能落地，
 * 就在对话里直接说「我建议你可以先……」，然后邀请用户确认。
 */
function buildMockReply({
  userText, intent, domain, slots, userSlots, needsKeyQuestion, keyQuestion, proposal, card, turnIndex,
  contextBlock = '', dataRequested = false,
}) {
  const seed = (userText || '').length + turnIndex * 7;
  const labels = (keys) => keys.map((k) => MODULE_DEFS.find((x) => x.key === k).label).join('、');
  const parts = [];

  // 1) 先接住
  // 用户直接问记录时，不要把他自己的问题再复述一遍；先说明看的是系统记录。
  if (dataRequested) {
    parts.push(emotionHintCount(userText) ? '嗯，我在。我看了下系统里现有的记录。' : '好，我看了下系统里现有的记录。');
  } else {
    parts.push(empathyFor(intent, card, seed));
  }

  // 2) 只想倾诉：不推计划，留一个口子
  if (intent === 'pour') {
    // 只引用「这一轮」提到的科目，避免把上一轮的话题翻出来
    const nowModules = (userSlots && userSlots.modules) || [];
    if (nowModules.length) parts.push(`你提到在准备${labels(nowModules)}，我先记着。`);
    if (contextBlock) parts.push(contextBlock);
    const unknown = card && card.unknowns && card.unknowns[0];
    if (unknown) parts.push(`不过有件事还没定下来：${String(unknown).slice(0, 50)}。这块不着急，等你有力气再说。`);
    parts.push('想多说一点的话我就在这儿听。不想说了也没关系，先去做点别的也行。');
    return parts.join('\n\n');
  }

  // 3) 需要问一个关键问题：先接住，再问，只问一个
  if (needsKeyQuestion) {
    parts.push(keyQuestion);
    parts.push('不用想得很完整，想到哪说到哪就行。');
    return parts.join('\n\n');
  }

  // 4) 聊清楚一点：说出我看到的东西，然后给建议
  const unknown = card && card.unknowns && card.unknowns[0];

  if (intent === 'plan' || intent === 'execute') {
    if (domain.id === 'kaoyan' && slots.modules.length) {
      parts.push(`这次我只按你已经确定的${labels(slots.modules)}来看。${
        slots.undecided.length
          ? `${labels(slots.undecided)}你说还没定，那就不给它排任务，等定了再说。`
          : ''
      }`.trim());
    } else if (unknown) {
      parts.push(`有一件事还没落地：${String(unknown).slice(0, 50)}。这个不影响先动起来。`);
    }
  } else if (unknown) {
    parts.push(`我注意到还有件事悬着：${String(unknown).slice(0, 50)}。它可能不是现在就要解决的。`);
  }

  // 系统记录单独成段，并明确它只是记录，不是对用户状态的推断
  if (contextBlock) parts.push(contextBlock);

  // 5) 建议：说成「我建议你可以……」而不是「下面这 3 件事」
  if (proposal && proposal.actions.length) {
    const a0 = proposal.actions[0];
    const a1 = proposal.actions[1];
    const suggest = a1
      ? `我建议你可以先从很小的一步开始：${a0.title}。要是还有力气，再顺手把「${a1.title}」也做掉。`
      : `我建议你可以先试试：${a0.title}。`;
    parts.push(suggest);
    parts.push('不用一次把整件事解决掉。要我把这几步放进待办吗？你说不用也完全没关系。');
  } else if (dataRequested) {
    parts.push('你想接着问哪一部分都可以。');
  } else {
    parts.push('你想让我帮你把它变成几条能勾掉的小事吗？也可以先放一放，不用现在决定。');
  }

  return parts.join('\n\n');
}

// ================================================================ 模拟引擎主逻辑

/**
 * 模拟引擎。刻意做成「有记忆、会看上下文」的，而不是固定话术：
 *   · 从 conversation.asked 里知道哪些问题已经问过
 *   · 从历史消息里累积已经得到的科目信息
 */
function mockRespond(conversation, userText, options = {}) {
  // 危机输入先接住：不拆任务，也不假装成普通倾诉
  if (detectCrisis(userText)) return crisisResult();

  const context = options.context || null;
  const dataRequested = wantsLearningData(userText);
  const history = conversation.messages || [];
  const asked = new Set(conversation.asked || []);
  const turnIndex = history.filter((m) => m.role === 'user').length;

  // 把整段对话里出现过的信息都算进来：用户可能在上一轮才说「我考数学一和英语一」
  const wholeText = [...history.filter((m) => m.role === 'user').map((m) => m.content), userText].join('\n');

  const detected = detectIntent(userText, history);
  /**
   * 上一轮问过关键问题、这一轮用户只是简短作答时，detectIntent 会退化成「analyze」。
   * 那不是用户换了话题，而是在回答我。所以要接着上一轮的意图走。
   */
  const pending = conversation.pendingIntent;
  const looksLikeAnswer = /^[\s\S]{0,40}$/.test(userText) && !/(帮我|想|请)/.test(userText.slice(0, 6));
  const intent = pending && detected === 'analyze' && looksLikeAnswer ? pending : detected;

  // 领域：优先看这一句，看不出就沿用整段对话的领域。
  // 用户往往只在第一句说「考研」，后面就只说「帮我拆成小任务」。
  let domain = detectDomain(userText);
  if (domain.id === 'general') {
    const fromWhole = detectDomain(wholeText);
    if (fromWhole.id !== 'general') domain = fromWhole;
  }
  const slots = extractSlots(wholeText);
  const userSlots = extractSlots(userText);

  // 只在这一轮确实需要时引用学习数据；纯情绪表达不会被数据打断
  const contextNote = shouldUseContext(context, userText, intent)
    ? buildContextNote(context, { userText, intent })
    : '';
  const contextBlock = contextNote
    ? `系统里的记录：\n${contextNote}\n这些只是系统里现有的记录，不代表全部。`
    : '';

  // ---- 是否需要问一个关键问题
  // 只有「不知道会影响行动方向」的时候才问，而且同一个问题只问一次。
  let needsKeyQuestion = false;
  let keyQuestion = '';
  const wantsPlan = intent === 'plan' || intent === 'execute';

  if (wantsPlan && (domain.id === 'kaoyan' || domain.id === 'general') && slots.modules.length === 0
    && !asked.has('modules') && !dataRequested) {
    needsKeyQuestion = true;
    keyQuestion = domain.id === 'kaoyan'
      ? '你现在主要准备哪几科？比如数学、英语、政治、专业课——只说你已经确定的那几科就行，还没定的可以先放着。'
      : '这件事大概是什么类型的？是学习、工作，还是一件要交的东西？说得具体一点，我拆出来的步骤才是能用的。';
  }

  // ---- 问题梳理卡
  // 给不给卡片，看的是「有没有可整理的内容」，而不是用户选了什么模式。
  // 完全空的情绪宣泄就不硬塞一张卡片。
  let problemCard = buildProblemCard(wholeText, intent);
  const cardHasContent = problemCard
    && (problemCard.expressed.length || problemCard.unknowns.length || problemCard.directions.length);
  if (!cardHasContent) problemCard = null;

  // ---- 建议（不再是「方案卡」）
  // 只在这一轮明确要求规划/拆解时生成方案。
  // 用户只是描述状态或提问时，先回答，不自动塞一张计划。
  let proposal = null;
  const canSuggest = !needsKeyQuestion
    && domain.id !== 'self'
    && wantsPlan
    && intent !== 'pour';

  if (canSuggest) {
    const actions = pickActions(domain, slots, { max: 4 });
    if (actions.length) {
      const pendingItems = [];
      if (slots.schoolUndecided) {
        pendingItems.push('学校/院校还没定——这一步会明显影响后面怎么安排，值得单独拿出来做');
      }
      // 用户提到过、但明确说还没定的科目：只列为待确认，绝不生成任务
      const labels = (keys) => keys.map((k) => MODULE_DEFS.find((x) => x.key === k).label).join('、');
      if (slots.undecided.length) {
        pendingItems.push(`${labels(slots.undecided)}还没定——等定了再规划，现在不用急着买资料或排进度`);
      } else if (domain.id === 'kaoyan' && !slots.modules.includes('major')) {
        pendingItems.push('专业课还没确定——等目标院校定了再规划，现在不用急着买资料');
      }
      if (domain.id === 'kaoyan' && !slots.modules.includes('politics') && !slots.undecided.includes('politics')) {
        pendingItems.push('政治什么时候开始，你可以之后再决定，现在不必安排');
      }
      if (userSlots.timeHint) {
        pendingItems.push(`你说的时间是「${userSlots.timeHint}」——上面的任务我会按这个强度来，不会堆太满`);
      }

      proposal = newProposal({
        conversationId: conversation.id,
        title: domain.id === 'kaoyan' && slots.modules.length
          ? `${labels(slots.modules)} 起步行动`
          : '起步行动',
        summary: '这些是现在就能开始的几条，不是完整计划。做完一部分再回头调整。',
        actions,
        pendingItems,
      });
    }
  }

  // 纯倾诉场景：明确不给方案（PRD：只想倾诉时不强制制定计划）
  if (intent === 'pour') proposal = null;

  /**
   * 回复里引用的内容只取「这一轮」说的话。
   * 用整段历史会导致：用户换了个话题，AI 还在共情上一轮的句子。
   * 卡片仍然用累积的整段（那样才能看到还没定的事），但「说话」只看当下。
   */
  const currentCard = buildProblemCard(userText, intent);

  const reply = buildMockReply({
    userText, intent, domain, slots, userSlots, needsKeyQuestion, keyQuestion, proposal,
    card: currentCard, turnIndex, contextBlock, dataRequested,
  });

  // 状态推进：
  //   问了关键问题 → 记住「在等这个回答」，并记下当时的意图
  //   已经拿到回答并给了方案 → 清空等待状态
  let nextPendingIntent = pending;
  const newAsked = [];
  if (needsKeyQuestion) {
    newAsked.push('modules');
    nextPendingIntent = intent;
  } else if (proposal) {
    nextPendingIntent = null;
  }

  const hint = intent === 'pour' ? { kind: 'offer-plan' } : { kind: intent };

  return {
    reply,
    problemCard,
    proposal,
    provider: 'mock',
    intent,
    asked: newAsked,
    pendingIntent: nextPendingIntent,
    hint,
    contextUsed: Boolean(contextBlock),
    contextFactText: contextBlock,
    /** 只含事实条目，给 Ollama 做短改写用 */
    contextFactLines: contextNote,
  };
}

// ================================================================ 真实模型

const SYSTEM_PROMPT = `你是「缓一缓」个人学术工作台里的 AI 助手。你的职责是帮助用户理解问题，并在适当的时候把问题转化为少量、具体、可执行的行动。

严格遵守下面的规则：

1. 用户不必先选择情绪类型，也不必逐项填写感受、事实、猜测、担忧。你要先理解用户已经表达的内容。
2. 追问的数量和时机由上下文决定，不要固定问几个问题。同一个问题绝对不要在后续轮次重复问。
3. 当用户只想倾诉时，不要强行制定计划。
4. 当用户明确要求制定计划时，尽量直接给出初步方案，避免不必要的追问。
5. 只有当「缺少关键信息且会明显改变行动方向」时，才自然地询问一个关键问题。
6. 只针对用户已经提到、已经确定的科目或范围给建议。**不要擅自扩展**。例如用户只确定了数学和英语，就不要生成专业课的详细任务；把专业课列为「待确认」。
7. 不要根据一句描述就安排未来几个月的完整日程，也不要默认生成每日打卡表。默认只给 3–4 条近期行动。
8. 不确定的东西写成「待确认」，不要放进今天的任务里。
9. 不要把猜测说成事实，不要把正常的犹豫和焦虑解释为心理疾病或人格缺陷。
10. 绝不用羞辱、指责或催促的语言评价用户有没有完成。

只输出一个 JSON 对象，不要输出 markdown 代码块或任何解释文字。结构：

{
  "reply": "给用户看的话，自然、简洁、简体中文，可以有换行",
  "needQuestion": "如果确实需要问一个关键问题，写在这里；否则空字符串",
  "problemCard": {
    "summary": "一句话概括当前问题",
    "expressed": ["用户已经表达的困难"],
    "unknowns": ["尚未确定的信息"],
    "directions": ["值得考虑的方向"],
    "nextSteps": ["可采取的下一步"],
    "emotion": { "notice": "只有当用户谈到情绪或身体反应时才写这一栏", "items": ["…"] } 或 null
  } 或 null,
  "proposal": {
    "title": "方案标题",
    "summary": "一句说明",
    "actions": [
      {
        "title": "行动标题",
        "detail": "怎么做，一两句",
        "scheduledDate": "YYYY-MM-DD 或 null",
        "estimateMinutes": 20,
        "doneStandard": "做到什么算完成"
      }
    ],
    "pendingItems": ["还没确定、不加入今日待办的事项"]
  } 或 null
}

注意 problemCard 只呈现当前问题真正需要的内容。用户没谈情绪时，emotion 必须是 null。`;

function safeJson(text) {
  if (!text) return null;
  let s = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch { /* 继续尝试截取 */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  }
  return null;
}

// ---------------------------------------------------------------- 模型调用

/**
 * 带进模型的历史。
 *
 * 注意：调用前服务端已经把这句用户输入 push 进 conversation.messages 了（为了切页面不丢），
 * 所以这里要把最后那条挑出去 —— 否则模型会看到同一个问题连着出现两次，
 * 容易重复回答，也白烧 token。
 */
function historyOf(conversation, currentText = null, limit = 20) {
  let msgs = conversation.messages || [];
  if (currentText != null && msgs.length) {
    const last = msgs[msgs.length - 1];
    if (last.role === 'user' && String(last.content || '').trim() === String(currentText).trim()) {
      msgs = msgs.slice(0, -1);
    }
  }
  return msgs.slice(-limit).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));
}

/** 把模型叫一次，只负责拿到字符串；底层走 llm.js（统一超时、错误与 think 剥离） */
async function callChat(settings, messages, { timeoutMs = 90000, temperature = 0.4 } = {}) {
  const out = await llm.complete({ settings, messages, temperature, timeoutMs });
  return out.text;
}

/**
 * 解析模型输出。
 * 刻意宽容：不是 JSON 就当一段普通回复，不因为格式问题把整轮对话打掉。
 */
function parseAssistant(content, conversation) {
  const parsed = safeJson(content);
  if (!parsed) {
    const text = String(content || '').trim();
    return {
      reply: text || '我在。你想从哪里说起都可以。',
      problemCard: null,
      proposal: null,
      actions: [],
      raw: true,
    };
  }

  const problemCard = parsed.problemCard && typeof parsed.problemCard === 'object'
    ? {
        summary: String(parsed.problemCard.summary || ''),
        expressed: Array.isArray(parsed.problemCard.expressed) ? parsed.problemCard.expressed.map(String).slice(0, 6) : [],
        unknowns: Array.isArray(parsed.problemCard.unknowns) ? parsed.problemCard.unknowns.map(String).slice(0, 6) : [],
        directions: Array.isArray(parsed.problemCard.directions) ? parsed.problemCard.directions.map(String).slice(0, 4) : [],
        nextSteps: Array.isArray(parsed.problemCard.nextSteps) ? parsed.problemCard.nextSteps.map(String).slice(0, 5) : [],
        emotion: parsed.problemCard.emotion && typeof parsed.problemCard.emotion === 'object'
          ? {
              notice: String(parsed.problemCard.emotion.notice || ''),
              items: Array.isArray(parsed.problemCard.emotion.items) ? parsed.problemCard.emotion.items.map(String).slice(0, 5) : [],
            }
          : null,
      }
    : null;

  let proposal = null;
  if (parsed.proposal && Array.isArray(parsed.proposal.actions) && parsed.proposal.actions.length) {
    proposal = newProposal({
      conversationId: (conversation && conversation.id) || 'conv-agent',
      title: parsed.proposal.title,
      summary: parsed.proposal.summary,
      actions: parsed.proposal.actions.slice(0, 6).map((a, i) => ({
        ...a,
        id: `act-${i + 1}`,
        scheduledDate: dateOnly(a.scheduledDate),
        dueDate: dateOnly(a.dueDate),
      })),
      pendingItems: parsed.proposal.pendingItems,
    });
  }

  const actions = Array.isArray(parsed.actions)
    ? parsed.actions
        .filter((a) => a && typeof a.tool === 'string')
        .slice(0, 4)
        .map((a) => ({ tool: a.tool, args: a.args && typeof a.args === 'object' ? a.args : {} }))
    : [];

  return {
    reply: String(parsed.reply || '').trim() || '我在。你想从哪里说起都可以。',
    problemCard,
    proposal,
    actions,
    raw: false,
  };
}

/** 学习记录要不要发给远程模型，由设置里的开关决定；没开就一个字都不带 */
function contextBlockFor(context, userText, settings) {
  if (!settings || settings.shareContext !== true || !context) return '';
  let note = '';
  try {
    note = buildContextNote(context, { userText, intent: 'analyze' });
  } catch {
    note = '';
  }
  if (!note) return '';
  return `\n\n系统里的记录（只作为事实依据，不要照抄，也不要因为记录里没有就说用户没做过）：\n${note}`;
}

/** 长期记忆：只有在「让它看到学习记录」打开时才一起发出去 */
async function profileBlock(settings) {
  if (!settings || settings.shareContext !== true) return '';
  try {
    const text = await profile.asText();
    if (!text) return '';
    return '\n\n【关于这个人的长期记录】\n' + text + '\n（以前记下的，跨对话仍然成立；不要重复问，也不要当成新发现）';
  } catch { return ''; }
}
async function realRespond(conversation, userText, settings, context = null) {
  const extra = await profileBlock(settings);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...historyOf(conversation, userText),
    {
      role: 'user',
      content: `${userText}${contextBlockFor(context, userText, settings)}${extra}\n\n（今天是 ${todayStr()}。请只输出规定的 JSON。）`,
    },
  ];

  const content = await callChat(settings, messages);
  const out = parseAssistant(content, conversation);
  return {
    ...out,
    provider: 'real',
    intent: detectIntent(userText, conversation.messages),
    asked: [],
    hint: null,
  };
}

// ---------------------------------------------------------------- 智能体循环

const AGENT_PROTOCOL = `

【你可以调用工具】
${tools.TOOL_SPEC}

需要真实数据、或者需要替用户把事情做掉时，不要凭空猜，改成输出这样的 JSON：
{"reply":"我先查一下","actions":[{"tool":"list_tasks","args":{"scope":"today"}}]}
系统会执行 actions 并把结果回给你，你可以接着决定下一步，最多连续 3 轮。
拿到需要的信息之后，再按原来的格式给出最终回复 —— 最终回复里不要再带 actions。

规矩：
- 只读工具随时可查；create_project / add_course / create_tasks / update_task 只在用户明确要求你动手时使用。
- 用户说「加进去」「帮我建」「安排上」这类话，就是明确要求，可以直接建，不用再让他确认一遍。
- 用户提到某个学习项目或课程时：先用 list_projects 查到 id，再把 projectId（必要时 courseId）传给 create_tasks，这样任务才会归到那个项目下。
- 建之前先看一眼有没有同名的，别重复建。
- 只有工具真正执行成功，才能说「已经建好 / 已经读到」。工具表里没有的能力（比如改设置、删数据）不许声称做了；做不到就直说做不到，并给出你能做的替代动作。
- 你自己查到的事实才可以说；没查到就说没查到。`;

/**
 * 工具结果怎么回灌给模型。
 *
 * 以前是 JSON.stringify(整个数组).slice(0, 4000) —— 从中间硬切，
 * 括号和引号会被切掉，模型拿到的是残缺 JSON，容易误读，
 * 而 read_textbook 一次就能顶到上限。
 *
 * 现在改成一条一条列，每条单独限长，超了明说超了，
 * 结构始终是完整的句子，不是半截 JSON。
 */
/** 用户主动中止时抛这个，上层凭 stopped 标记区分「停止」和「出错」 */
function stoppedError() {
  const err = new Error('已停止生成');
  err.stopped = true;
  return err;
}

function formatToolResults(results, perItem = 3000, total = 7000) {
  const clip = (s, n) => {
    const str = String(s == null ? '' : s);
    if (str.length <= n) return str;
    return `${str.slice(0, n)}……（后面还有 ${str.length - n} 字没显示，需要细节就缩小范围再查一次）`;
  };
  const parts = results.map((r) => {
    const head = `【${r.tool || '?'}】${r.ok ? '成功' : '失败'}：${r.summary || ''}`;
    let body = '';
    try { body = JSON.stringify(r.data == null ? {} : r.data); } catch { body = String(r.data); }
    return `${head}\n数据：${clip(body, perItem)}`;
  });
  return clip(parts.join('\n\n'), total);
}
/** 工具痕迹要带回「这一下到底建了几条待办」，界面才好明确告诉用户已经直接建好了 */
function toolTrace(r) {
  return {
    tool: r.tool,
    ok: r.ok,
    summary: r.summary,
    createdCount: r.ok && r.tool === 'create_tasks' && r.data && Array.isArray(r.data.created)
      ? r.data.created.length
      : 0,
  };
}

/**
 * 工具调用循环。callModel 可注入，方便测试时不真的打模型。
 */
async function agentLoop({ settings, messages, conversation, maxRounds = 3, callModel = callChat }) {
  const started = Date.now();
  const trace = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    const content = await callModel(settings, messages);
    const out = parseAssistant(content, conversation);

    if (!out.actions || !out.actions.length) {
      return {
        ...out,
        provider: 'real',
        asked: [],
        hint: null,
        meta: { rounds: round, tools: trace, durationMs: Date.now() - started },
      };
    }

    const results = await tools.execute(out.actions, { conversationId: conversation && conversation.id });
    trace.push(...results.map(toolTrace));

    messages.push({ role: 'assistant', content });
    messages.push({
      role: 'user',
      content: `工具执行结果：\n${formatToolResults(results)}\n\n信息够了就给出最终回复（不要带 actions）；还不够就继续调用。`,
    });
  }

  // 到上限了：不再给工具，逼它收尾
  messages.push({ role: 'user', content: '已经到调用上限。请直接给出最终回复，不要再调用工具。' });
  const content = await callModel(settings, messages);
  const out = parseAssistant(content, conversation);
  return {
    ...out,
    actions: [],
    provider: 'real',
    asked: [],
    hint: null,
    meta: { rounds: maxRounds + 1, tools: trace, durationMs: Date.now() - started, capped: true },
  };
}

async function agentRespond(conversation, userText, settings, context = null) {
  const extra = await profileBlock(settings);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT + AGENT_PROTOCOL },
    ...historyOf(conversation, userText),
    {
      role: 'user',
      content: `${userText}${contextBlockFor(context, userText, settings)}${extra}\n\n（今天是 ${todayStr()}。需要工具就输出 actions；否则只输出规定的 JSON。）`,
    },
  ];

  const out = await agentLoop({ settings, messages, conversation });
  return {
    ...out,
    intent: detectIntent(userText, conversation.messages),
    actions: out.meta && out.meta.tools && out.meta.tools.length ? out.meta.tools : null,
  };
}

async function listOllamaModels(baseUrl = 'http://127.0.0.1:11434') {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return { online: false, models: [], error: '没有配置 Ollama 地址' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${base}/api/tags`, { signal: controller.signal });
    if (!res.ok) return { online: false, models: [], error: `Ollama 返回 ${res.status}` };
    const data = await res.json();
    const models = (data.models || []).map((m) => ({
      name: m.name,
      sizeBytes: m.size || 0,
      family: (m.details && m.details.family) || '',
      parameterSize: (m.details && m.details.parameter_size) || '',
      quantization: (m.details && m.details.quantization_level) || '',
    }));
    return { online: true, models, error: null };
  } catch (err) {
    return {
      online: false,
      models: [],
      error: err.name === 'AbortError' ? '连接超时（4 秒）' : (err.message || String(err)),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从模型输出里剥掉推理块、markdown 装饰和「回复：」这类前缀。
 *
 * 注意：推理模型（deepseek-r1 这类）会把思考过程写在 <think>…</think> 里。
 * 如果 token 上限先被思考吃掉，输出会在 <think> 内部被截断，
 * 于是「没闭合」的思考内容就会泄漏成正文。
 * 所以闭合的剥掉，**没闭合的整段丢弃**——宁可让上层回退，也不要展示半截思考。
 */
function cleanModelText(text) {
  let s = String(text || '');
  // 1. 先剥掉完整闭合的思考块
  s = s.replace(/<think(?:ing)?[\s\S]*?<\/think(?:ing)?>/gi, '');
  // 2. 还有没闭合的 <think —— 说明输出被截断在思考里，剩下的都不可用
  if (/<think(?:ing)?/i.test(s)) {
    const cut = s.search(/<think(?:ing)?/i);
    s = s.slice(0, cut);
  }
  s = s.replace(/<\/think(?:ing)?>/gi, '');
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
  // 小模型经常把提示里的标签原样回显出来
  s = s.replace(/^\s*(回复|答复|assistant|那句回答|改写后|改写|回答)\s*[:：]\s*/i, '');
  s = s.replace(/\*\*/g, '').replace(/^\s*[-*]\s+/gm, '· ');
  s = s.trim();
  if (s.length > 600) s = `${s.slice(0, 600)}…`;
  return s;
}

/**
 * 判断模型这次说的话能不能用。
 *
 * 实测 1.5B 模型会犯两类毛病：
 *   1. 把给它的「事实底稿」原样复述一遍（「系统已经整理出的事实包括……」）；
 *   2. 用第三人称谈论用户（「用户最近可能在准备专业课」「作为助手，我需要提醒用户……」）。
 * 这两种都不该出现在对话里，遇到就退回规则引擎的原话。
 */
const BAD_MODEL_REPLY = /(用户|作为助手|系统整理|整理出的事实|情况概括|事实底稿|assistant|作为一个AI|AI助手|让我们一起|感到自豪|你已经准备好了一切)/;

/**
 * 护栏：模型这次说的话能不能直接展示。
 *
 * 依据是实测 deepseek-r1:1.5b 的真实表现 —— 它会
 *   · 复述背景、用第三人称谈「用户」；
 *   · 写成长篇泛泛建议、推荐平台课程书籍；
 *   · 偶尔情绪过热（「让我们一起为你的学习计划感到自豪」）；
 *   · 把输入的提示原样回显。
 * 这些都不该出现在对话里。宁可退回规则引擎那句已经写好的话。
 */
function replyIsUnusable(text, userText = '', options = {}) {
  if (!text || typeof text !== 'string') return true;
  const t = text.trim();
  const maxLength = Number(options.maxLength) || 120;
  if (t.length < 6) return true;
  if (t.length > maxLength) return true;
  if (BAD_MODEL_REPLY.test(t)) return true;
  // 客服腔 / 资源推荐腔 / 泛泛建议腔
  if (/(欢迎继续咨询|欢迎随时|希望对你有帮助|以上建议|如有需要|文都|网课平台|报名辅导|参加.{0,4}课程|阅读.{0,4}书籍|在线课程|辅导班|培训机构)/.test(t)) return true;
  // 回显：把用户原话或提示里的标签照抄回来
  if (userText && userText.trim().length >= 8 && t.includes(userText.trim().slice(0, 10))) return true;
  // 近似回显：小模型有时只把「我」换成「你」，几乎原样复述一遍
  if (userText) {
    const normalize = (s) => String(s).replace(/[，。！？、；：\s]/g, '').replace(/[你我]/g, '');
    const u = normalize(userText);
    const m = normalize(t);
    if (u.length >= 8 && m.length >= 6 && m.length <= u.length + 4
      && (m.includes(u.slice(0, 8)) || u.includes(m.slice(0, 8)))) return true;
  }
  // 原文里没有的英文词（例如把「你」写成 you），说明模型自己编了内容
  if (options.sourceText) {
    const latin = (s) => String(s).match(/[A-Za-z]+/g) || [];
    const allowed = new Set(latin(options.sourceText).map((w) => w.toLowerCase()));
    if (latin(t).some((w) => !allowed.has(w.toLowerCase()))) return true;
  }
  // 改写事实时把提示词或条目符号也吐了出来，说明它没有真正改写
  if (options.rewriteWithContext) {
    if (/(系统记录|改写|一句自然|必须遵守|只输出)/.test(t)) return true;
    if (/[·•]/.test(t)) return true;
    if (t.split('\n').filter((line) => line.trim()).length > 2) return true;
  }
  // 倾诉轮只接住情绪：不能变成一段泛泛的安慰和建议
  if (!options.rewriteWithContext && options.intent === 'pour') {
    if (t.length > 60) return true;
    if (/(加油|多休息|出去走走|放松一下|每个人|不必|记住|生活都是|建议你|可以多|你应该)/.test(t)) return true;
  }
  // 空泛安慰：不接住具体处境，只丢一句「以后会好的」
  if (/(天气会变好|一切都会好起来|一切都会好的|明天会更好|生活总会好|都会过去的)/.test(t)) return true;
  if (/那句回答|他说的话|前情[:：]/.test(t)) return true;
  return false;
}

/** 从规则引擎的回复里取出「必须要问的那个问题」 */
function extractRequiredQuestion(draftReply) {
  const m = String(draftReply || '').match(/[^。！？\n]*(哪几科|什么类型)[^。！？\n]*[？?]?/);
  return m ? m[0].trim() : null;
}

/**
 * 让本地模型把回复重写得更自然。
 * 失败就抛异常，由 respond() 回退到规则引擎的原话。
 */
/**
 * 组装 Ollama 请求。独立出来是为了让测试能直接检查「模型实际收到了什么上下文」。
 *
 * 两种情况：
 *   · 这一轮引用了学习数据：给模型草稿 + 真实记录，让它改写表达，数字必须保留
 *   · 普通闲聊：仍然只让模型写一句接住对方的话
 */
function buildOllamaPrompt({ userText, draft, context }) {
  const requiredQuestion = extractRequiredQuestion(draft.reply);
  const needQuestion = Boolean(requiredQuestion);
  const factLines = String(draft.contextFactLines || '').trim();
  const rewriteWithContext = Boolean(factLines);

  if (rewriteWithContext) {
    /**
     * 实测 deepseek-r1:1.5b 拿到「草稿 + 整份上下文」时会直接回显输入。
     * 所以这里只给它这一轮真正要用的几条事实，让它做一句话改写，
     * 其余结构（开头、建议、结尾）仍由规则引擎保留。
     */
    const system = [
      '你是「缓一缓」学习工作台里的助手。',
      '把下面这段系统记录改写成一句自然的中文回复，直接对「你」说话。',
      '必须遵守：',
      '· 保留所有数字和日期，不能改数字，也不能新增数字；',
      '· 直接使用记录里给出的数字，不要做新的计算（例如不要重新算百分比）；',
      '· 百分比只写记录里给出的整数，不要出现小数点；',
      '· 不能编造学习时长、课程进度、任务数量或日期；',
      '· 没有记录只说明系统里没有记录，不能说成「你没有学习」；',
      '· 只陈述记录本身，不要分析原因，不要加「约」「左右」这类不确定词；',
      '· 不要照抄原文，不要加标题、引号、前缀或解释。',
      '只输出这一句话本身。',
    ].join('\n');

    const user = [
      '系统记录：',
      factLines,
    ].join('\n');

    return {
      system,
      user,
      requiredQuestion,
      needQuestion,
      rewriteWithContext,
      contextText: factLines,
    };
  }

  // 给模型一段自然的「前情」。
  // 注意全部用第二人称写 —— 只要 prompt 里出现「用户」「他」，
  // 小模型就会照抄这个第三人称，于是被质量护栏拒掉。
  const brief = [];
  if (draft.intent === 'pour') {
    brief.push('你这次只是想说说话，不需要计划，也不用给步骤。');
  }
  if (draft.intent !== 'pour' && draft.problemCard && (draft.problemCard.expressed || []).length) {
    brief.push(`你刚说出的困难是：${draft.problemCard.expressed.join('；')}。`);
  }
  if (draft.proposal) {
    brief.push(`界面下面已经列出 ${draft.proposal.actions.length} 条近期行动，你不用重复列举。`);
  }

  const examples = draft.intent === 'pour'
    ? [
        '正确示范（只接住，不复述，不给建议）：「嗯，我在。先不用急着做什么，想说就说。」',
      ]
    : needQuestion
      ? [
          '正确示范（只接住，不提问，不列清单）：「考研这件事一直悬着确实很耗人。我们先把范围定下来，其余的慢慢来。」',
        ]
      : [
          '正确示范（2 句，直接对「你」说话，不列清单）：「这件事拖着确实很难受。我把它拆成了几条现在能动手的小事，你挑一条先开始就行。」',
        ];

  const system = [
    '你是「缓一缓」学习工作台里的助手，正在和用户一对一聊天。',
    '要求：',
    '· 直接对「你」说话，绝对不要用「用户」「他」这类第三人称；',
    '· 只说 1 到 2 句，总共不超过 50 个汉字；',
    '· 不要复述对方的话，不要罗列步骤，不要解释你在做什么，不要提「系统」「事实」「整理」这些词；',
    '· 不要给建议清单，不要推荐平台、课程、资料或机构，不要说「欢迎继续咨询」；',
    '· 不要用英文单词，也不要替对方总结他今天做了什么；',
    '· 不要做心理诊断，不要说「你应该」「你必须」；',
    needQuestion ? '· 这次不要提问 —— 问题会由界面另外显示，你只写一句接住对方的话。' : '· 如果前面已经给出行动，提一句「挑一条先开始」就够了。',
    '',
    ...examples,
    '',
    '只输出这句话本身，不要加引号、不要加标题。',
  ].join('\n');

  const user = [
    `你刚说：「${userText}」`,
    brief.length ? `前情：${brief.join('')}` : '',
  ].filter(Boolean).join('\n');

  return { system, user, requiredQuestion, needQuestion, rewriteWithContext, contextText: '' };
}

async function ollamaReply({ settings, userText, draft, context }) {
  const base = String(settings.ollamaUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 Ollama 地址');
  const model = settings.ollamaModel;
  if (!model) throw new Error('还没有选择 Ollama 模型');

  const prompt = buildOllamaPrompt({ userText, draft, context });
  const { system, user, requiredQuestion, needQuestion, rewriteWithContext } = prompt;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);

  /**
   * think:false —— 关掉推理模型的思考过程。
   * 实测 deepseek-r1:1.5b 开思考要 5 秒多，而且 token 预算常被思考吃掉、
   * 导致正文被截断；关掉之后 1.3 秒返回，输出也干净。
   * 对不支持这个字段的模型，Ollama 会忽略它；万一报错，下面会重试一次。
   */
  const requestBody = {
    model,
    stream: false,
    think: false,
    options: rewriteWithContext
      ? { temperature: 0.2, num_predict: 140, top_p: 0.9, repeat_penalty: 1.1 }
      : { temperature: 0.5, num_predict: 110, top_p: 0.9, repeat_penalty: 1.1 },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };

  async function post(body) {
    return fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  }

  let res;
  try {
    res = await post(requestBody);
    if (res.status === 400) {
      // 有些 Ollama 版本不认 think 字段，去掉再试一次
      const { think, ...withoutThink } = requestBody;
      res = await post(withoutThink);
    }
  } catch (err) {
    clearTimeout(timer);
    throw new Error(
      err.name === 'AbortError'
        ? `Ollama 超过 ${Math.round(OLLAMA_TIMEOUT_MS / 1000)} 秒没有返回`
        : `连不上 Ollama（${base}）：${err.message}`
    );
  }
  clearTimeout(timer);

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama 返回 ${res.status}${body ? `：${body.slice(0, 160)}` : ''}`);
  }

  const data = await res.json();
  const text = cleanModelText((data.message && data.message.content) || '');
  if (!text || text.length < 4) throw new Error('Ollama 返回了空内容');

  // 质量不行就明确说不行，由上层退回规则引擎
  const maxLength = rewriteWithContext ? 240 : 120;
  if (replyIsUnusable(text, userText, {
    maxLength,
    sourceText: `${draft.reply}\n${draft.contextFactLines || ''}`,
    rewriteWithContext,
    intent: draft.intent,
  })) {
    throw new Error('模型这次的措辞不合格（跑题、回显或空泛建议），已改用规则引擎的说法');
  }

  // 重点校验学习事实：数字、日期、进度不能比草稿多，也不能比草稿少
  const factCheck = checkFactConsistency(text, { context, draft, userText });
  if (!factCheck.ok) {
    throw new Error(`模型改写时改动了学习数据（${factCheck.reason}），已改用规则引擎的说法`);
  }

  let finalText;
  if (rewriteWithContext) {
    const coverage = checkFactCoverage(text, draft.contextFactLines);
    if (!coverage.ok) {
      throw new Error(`模型改写时漏掉了真实记录（${coverage.missing.slice(0, 3).join('、')}），已改用规则引擎的说法`);
    }
    // 只替换事实段，规则引擎写好的开头、建议和结尾保持原样
    if (!draft.contextFactLines || !draft.reply.includes(draft.contextFactLines)) {
      throw new Error('规则草稿里找不到可替换的记录段，已改用规则引擎的说法');
    }
    finalText = draft.reply.replace(draft.contextFactLines, text);
  } else {
    // 需要提问时，把规则引擎的问题接在后面，保证它一定出现
    finalText = needQuestion ? `${text}\n\n${requiredQuestion}` : text;
  }

  return {
    text: finalText,
    model: data.model || model,
    evalCount: data.eval_count || null,
    durationMs: data.total_duration ? Math.round(data.total_duration / 1e6) : null,
  };
}

// ================================================================ 对外接口

/**
 * 唯一的入口。调用方（API 路由）不需要知道这次是哪个引擎、走了哪条路。
 * 任何外部引擎失败都回退到规则引擎，并如实把失败原因带回去（PRD 6.3）。
 */
async function respond({ conversation, userText, settings, context = null }) {
  // 危机输入在「选引擎」之前就接住：远程和 Ollama 都拿不到这句话
  if (detectCrisis(userText)) return crisisResult();

  // ---- 远程 OpenAI 兼容接口：模型负责全部内容
  // 学习记录要不要一起发出去，由设置里的 shareContext 显式决定（默认关）。
  if (settings.aiProvider === 'real' && settings.apiKey) {
    try {
      // 默认走带工具的智能体循环；agentEnabled=false 时退回单次问答
      if (settings.agentEnabled === false) {
        return await realRespond(conversation, userText, settings, context);
      }
      const out = await agentRespond(conversation, userText, settings, context);
      return out;
    } catch (err) {
      const fallback = mockRespond(conversation, userText, { context });
      return {
        ...fallback,
        warning: `远程模型调用失败，已用本地规则引擎回复。原因：${err.message}`,
      };
    }
  }

  // ---- 本地 Ollama：规则引擎定结构，模型只改措辞
  if (settings.aiProvider === 'ollama') {
    const draft = mockRespond(conversation, userText, { context });
    try {
      const out = await ollamaReply({ settings, userText, draft, context });
      return {
        ...draft,
        reply: out.text,
        provider: 'ollama',
        meta: { model: out.model, durationMs: out.durationMs },
      };
    } catch (err) {
      return {
        ...draft,
        // 保留规则引擎的原话，并说清楚为什么没用上模型
        warning: `Ollama 这次没有用上，回复来自本地规则引擎。原因：${err.message}`,
      };
    }
  }

  return mockRespond(conversation, userText, { context });
}

// ---------------------------------------------------------------- 流式

/**
 * 从半截 JSON 里抠出 "reply" 当前的值。
 * 模型是边生成边解析的，所以可能停在任意位置：没闭合引号就取到哪算哪。
 */
function partialReply(raw) {
  const key = String(raw || '').indexOf('"reply"');
  if (key < 0) return '';
  let i = raw.indexOf(':', key);
  if (i < 0) return '';
  i += 1;
  while (i < raw.length && /\s/.test(raw[i])) i += 1;
  if (raw[i] !== '"') return '';
  i += 1;
  let out = '';
  while (i < raw.length) {
    const c = raw[i];
    if (c === '\\') {
      const n = raw[i + 1];
      if (n === undefined) break;
      if (n === 'n') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'r') out += '';
      else if (n === 'u') {
        const hex = raw.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        const code = parseInt(hex, 16);
        if (Number.isFinite(code)) out += String.fromCharCode(code);
        i += 4;
      } else out += n;
      i += 2;
      continue;
    }
    if (c === '"') break;
    out += c;
    i += 1;
  }
  return out;
}

const STREAM_PROTOCOL = `

【输出格式（流式）】
第一个字段必须是 kind：
- 需要调用工具时输入 {"kind":"tool","actions":[...]}
- 给出最终回答时输入 {"kind":"answer","reply":"给用户看的话","problemCard":...,"proposal":...}
kind 之后才写别的内容，这样界面上才能边生成边显示。
`;

/**
 * 带工具循环的流式回答。
 * onEvent 会收到：{type:'status'} / {type:'partial',text} / {type:'tool',summary}
 */
async function agentRespondStream({ conversation, userText, settings, context = null, onEvent = () => {}, shouldStop = null }) {
  const extra = await profileBlock(settings);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT + AGENT_PROTOCOL + STREAM_PROTOCOL },
    ...historyOf(conversation, userText),
    {
      role: 'user',
      content: `${userText}${contextBlockFor(context, userText, settings)}${extra}\n\n（今天是 ${todayStr()}。需要工具就输出 kind=tool；否则输出 kind=answer。）`,
    },
  ];

  const started = Date.now();
  const trace = [];
  const maxRounds = 3;

  for (let round = 1; round <= maxRounds; round += 1) {
    // 用户点了停止、或者关了页面：这一轮就别再打模型了
    if (shouldStop && shouldStop()) throw stoppedError();
    let acc = '';
    let kind = '';
    let emitted = false;
    let announced = false;

    const streamed = await llm.completeStream({
      settings,
      messages,
      temperature: 0.4,
      onDelta: (piece) => {
        acc += piece;
        if (!kind) {
          if (/"kind"\s*:\s*"tool"/.test(acc)) kind = 'tool';
          else if (/"kind"\s*:\s*"answer"/.test(acc)) kind = 'answer';
        }
        if (kind === 'answer') {
          const r = partialReply(acc);
          if (r) {
            emitted = true;
            onEvent({ type: 'partial', text: r });
          }
        } else if (kind === 'tool' && !announced) {
          announced = true;
          onEvent({ type: 'status', text: '正在查…' });
        }
      },
    });
    const text = streamed.text;

    const out = parseAssistant(text, conversation);

    if (!out.actions || !out.actions.length) {
      // 停下来之后不要保存：半截答案比没有答案更让人困惑
      if (shouldStop && shouldStop()) throw stoppedError();
      if (!emitted) onEvent({ type: 'partial', text: out.reply });
      return {
        ...out,
        provider: 'real',
        asked: [],
        hint: null,
        // 流式路径也要把工具痕迹落到消息上，否则「它做过什么」永远不显示
        actions: trace.length ? trace : null,
        meta: { rounds: round, tools: trace, durationMs: Date.now() - started },
      };
    }

    const results = await tools.execute(out.actions, { conversationId: conversation && conversation.id });
    for (const r of results) {
      trace.push(toolTrace(r));
      onEvent({ type: 'tool', tool: r.tool, ok: r.ok, summary: r.summary, createdCount: toolTrace(r).createdCount });
    }

    messages.push({ role: 'assistant', content: text });
    messages.push({
      role: 'user',
      content: `工具执行结果：\n${formatToolResults(results)}\n\n信息够了就输出 kind=answer；还不够就继续 kind=tool。`,
    });
  }

  if (shouldStop && shouldStop()) throw stoppedError();
  messages.push({ role: 'user', content: '已经到调用上限。请直接输出 kind=answer，不要再调用工具。' });
  let acc = '';
  const cappedText = (await llm.completeStream({
    settings,
    messages,
    temperature: 0.4,
    onDelta: (piece) => {
      acc += piece;
      const r = partialReply(acc);
      if (r) onEvent({ type: 'partial', text: r });
    },
  })).text;
  const out = parseAssistant(cappedText, conversation);
  return {
    ...out,
    actions: trace.length ? trace : null,
    provider: 'real',
    asked: [],
    hint: null,
    meta: { rounds: maxRounds + 1, tools: trace, durationMs: Date.now() - started, capped: true },
  };
}

/** 统一的流式入口：非远程引擎直接一次性吐出规则引擎的回复 */
async function respondStream({ conversation, userText, settings, context = null, onEvent = () => {}, shouldStop = null }) {
  // 危机输入在选引擎之前就接住：流式这条路也不能绕过安全边界
  if (detectCrisis(userText)) {
    const out = crisisResult();
    onEvent({ type: 'partial', text: out.reply });
    return out;
  }
  if (settings.aiProvider === 'real' && settings.apiKey && settings.agentEnabled !== false) {
    let emitted = false;
    const wrapped = (e) => {
      if (e && e.type === 'partial' && e.text) emitted = true;
      onEvent(e);
    };
    try {
      return await agentRespondStream({ conversation, userText, settings, context, onEvent: wrapped, shouldStop });
    } catch (err) {
      // 用户自己点的停止：不要把结果换个就地重来，也不要回退到规则引擎
      if (err && err.stopped) throw err;
      const reason = String((err && err.message) || err).replace(/\s+/g, " ").slice(0, 160);
      // 已经吐了一半：不要换个答案重来，把错误如实交给界面
      if (emitted) throw new Error(reason);
      const fallback = mockRespond(conversation, userText, { context });
      onEvent({ type: 'partial', text: fallback.reply });
      return {
        ...fallback,
        warning: `远程模型这次没接通，已用本地规则引擎回复。原因：${reason}`,
      };
    }
  }
  const out = await respond({ conversation, userText, settings, context });
  onEvent({ type: 'partial', text: out.reply });
  return out;
}

module.exports = {
  respond,
  mockRespond,
  detectIntent,
  detectDomain,
  extractSlots,
  buildProblemCard,
  pickActions,
  listOllamaModels,
  cleanModelText,
  replyIsUnusable,
  buildOllamaPrompt,
  buildContextNote,
  shouldUseContext,
  wantsLearningData,
  checkFactConsistency,
  checkFactCoverage,
  extractFactTokens,
  MODULE_DEFS,
  agentRespond,
  agentLoop,
  parseAssistant,
  callChat,
  respondStream,
  agentRespondStream,
  partialReply,
  historyOf,
  formatToolResults,
};
