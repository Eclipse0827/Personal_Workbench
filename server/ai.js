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
}) {
  const seed = (userText || '').length + turnIndex * 7;
  const labels = (keys) => keys.map((k) => MODULE_DEFS.find((x) => x.key === k).label).join('、');
  const parts = [];

  // 1) 先接住
  parts.push(empathyFor(intent, card, seed));

  // 2) 只想倾诉：不推计划，留一个口子
  if (intent === 'pour') {
    // 只引用「这一轮」提到的科目，避免把上一轮的话题翻出来
    const nowModules = (userSlots && userSlots.modules) || [];
    if (nowModules.length) parts.push(`你提到在准备${labels(nowModules)}，我先记着。`);
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

  // 5) 建议：说成「我建议你可以……」而不是「下面这 3 件事」
  if (proposal && proposal.actions.length) {
    const a0 = proposal.actions[0];
    const a1 = proposal.actions[1];
    const suggest = a1
      ? `我建议你可以先从很小的一步开始：${a0.title}。要是还有力气，再顺手把「${a1.title}」也做掉。`
      : `我建议你可以先试试：${a0.title}。`;
    parts.push(suggest);
    parts.push('不用一次把整件事解决掉。要我把这几步放进待办吗？你说不用也完全没关系。');
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
function mockRespond(conversation, userText) {
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

  // ---- 是否需要问一个关键问题
  // 只有「不知道会影响行动方向」的时候才问，而且同一个问题只问一次。
  let needsKeyQuestion = false;
  let keyQuestion = '';
  const wantsPlan = intent === 'plan' || intent === 'execute';

  if (wantsPlan && (domain.id === 'kaoyan' || domain.id === 'general') && slots.modules.length === 0 && !asked.has('modules')) {
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
  // 触发条件放宽：不再需要用户先说「帮我拆成小任务」。
  // 只要这一轮能落地（有具体领域、且不是只想倾诉），就在对话里直接给建议，
  // 由用户决定要不要确认成待办。这正是「说我建议你可以怎么样，然后我确认」的做法。
  let proposal = null;
  const canSuggest = !needsKeyQuestion
    && domain.id !== 'self'
    && (wantsPlan || intent === 'analyze')
    && !(intent === 'pour');

  if (canSuggest) {
    const actions = pickActions(domain, slots, { max: wantsPlan ? 4 : 3 });
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
    card: currentCard, turnIndex,
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

async function realRespond(conversation, userText, settings) {
  const base = (settings.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置接口地址');
  if (!settings.apiKey) throw new Error('未配置 API Key');

  const history = (conversation.messages || []).slice(-14).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: settings.model || 'gpt-4o-mini',
        temperature: 0.4,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...history,
          {
            role: 'user',
            content: `${userText}\n\n（今天是 ${todayStr()}。请只输出规定的 JSON。）`,
          },
        ],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`模型接口返回 ${res.status}${body ? `：${body.slice(0, 160)}` : ''}`);
  }

  const payload = await res.json();
  const content = payload?.choices?.[0]?.message?.content || '';
  const parsed = safeJson(content);
  if (!parsed) throw new Error('模型返回的内容不是有效 JSON');

  // 校验并规整模型输出，避免坏结构直接进数据库
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
      conversationId: conversation.id,
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

  return {
    reply: String(parsed.reply || '').trim() || '我在。你想从哪里说起都可以。',
    problemCard,
    proposal,
    provider: 'real',
    intent: detectIntent(userText, conversation.messages),
    asked: [],
    hint: null,
  };
}

// ================================================================ 本地 Ollama

/**
 * Ollama 通道的分工（这个选择很重要，写在这里留给以后的自己看）：
 *
 *   规则引擎  →  问题梳理卡、行动方案、行动条目、待确认事项、要不要问关键问题
 *   Ollama    →  只负责把「回复」这句话说得自然一点
 *
 * 为什么不让小模型生成结构化内容：
 *   实测本机 1.5B 模型在 format:json 下会把键名写错（"needQuestion:"），
 *   输出也会被截断；更要紧的是它不遵守 PRD 那几条硬规则
 *   （不擅自给「还没定」的科目排任务、不重复问同一个问题、倾诉时不推方案）。
 *   把它限制在「措辞」这一层，既用上了本地模型，又不会破坏已经测过的行为。
 */

const OLLAMA_TIMEOUT_MS = 120000;

/** 列出本机 Ollama 的模型。连不上就返回 online:false，不抛异常。 */
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
function replyIsUnusable(text, userText = '') {
  if (!text || typeof text !== 'string') return true;
  const t = text.trim();
  if (t.length < 6) return true;
  if (t.length > 120) return true;
  if (BAD_MODEL_REPLY.test(t)) return true;
  // 客服腔 / 资源推荐腔 / 泛泛建议腔
  if (/(欢迎继续咨询|欢迎随时|希望对你有帮助|以上建议|如有需要|文都|网课平台|报名辅导|参加.{0,4}课程|阅读.{0,4}书籍|在线课程|辅导班|培训机构)/.test(t)) return true;
  // 回显：把用户原话或提示里的标签照抄回来
  if (userText && userText.trim().length >= 8 && t.includes(userText.trim().slice(0, 10))) return true;
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
async function ollamaReply({ settings, userText, draft }) {
  const base = String(settings.ollamaUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('未配置 Ollama 地址');
  const model = settings.ollamaModel;
  if (!model) throw new Error('还没有选择 Ollama 模型');

  // 需要提问时，问题由规则引擎自己附上，模型只负责写前半句。
  // 这样「必须问的那一个问题」永远不会被小模型吃掉。
  const requiredQuestion = extractRequiredQuestion(draft.reply);
  const needQuestion = Boolean(requiredQuestion);

  // 给模型一段自然的「前情」。
  // 注意全部用第二人称写 —— 只要 prompt 里出现「用户」「他」，
  // 小模型就会照抄这个第三人称，于是被质量护栏拒掉。
  const brief = [];
  if (draft.intent === 'pour') {
    brief.push('你这次只是想说说话，不需要计划，也不用给步骤。');
  }
  if (draft.problemCard && (draft.problemCard.expressed || []).length) {
    brief.push(`你刚说出的困难是：${draft.problemCard.expressed.join('；')}。`);
  }
  if (draft.proposal) {
    brief.push(`界面下面已经列出 ${draft.proposal.actions.length} 条近期行动，你不用重复列举。`);
  }

  const examples = needQuestion
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
    '· 不要复述背景信息，不要罗列步骤，不要解释你在做什么，不要提「系统」「事实」「整理」这些词；',
    '· 不要给建议清单，不要推荐平台、课程、资料或机构，不要说「欢迎继续咨询」；',
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
    options: { temperature: 0.5, num_predict: 110, top_p: 0.9, repeat_penalty: 1.1 },
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
  if (replyIsUnusable(text, userText)) {
    throw new Error('模型这次的措辞不合格（跑题、回显或空泛建议），已改用规则引擎的说法');
  }

  // 需要提问时，把规则引擎的问题接在后面，保证它一定出现
  const finalText = needQuestion ? `${text}\n\n${requiredQuestion}` : text;

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
async function respond({ conversation, userText, settings }) {
  // ---- 远程 OpenAI 兼容接口：模型负责全部内容
  if (settings.aiProvider === 'real' && settings.apiKey) {
    try {
      return await realRespond(conversation, userText, settings);
    } catch (err) {
      const fallback = mockRespond(conversation, userText);
      return {
        ...fallback,
        warning: `远程模型调用失败，已用本地规则引擎回复。原因：${err.message}`,
      };
    }
  }

  // ---- 本地 Ollama：规则引擎定结构，模型只改措辞
  if (settings.aiProvider === 'ollama') {
    const draft = mockRespond(conversation, userText);
    try {
      const out = await ollamaReply({ settings, userText, draft });
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

  return mockRespond(conversation, userText);
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
  MODULE_DEFS,
};
