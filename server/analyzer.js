'use strict';

/**
 * 本地智能分析引擎
 * ---------------------------------------------------------------
 * 目标不是「AI 替用户下结论」，而是把一段糊成一团的焦虑，
 * 拆成用户可以自己校验的五类东西：
 *
 *   事情经过 / 我的猜测 / 我的担忧 / 尚未确定的信息 / 我真正的需要
 *
 * 然后把它翻译成能一步一步做的「微行动」。
 *
 * 两条铁律（来自产品设计）：
 *   1. 所有拆解都是「等待验证的假设」，用户永远可以纠正，纠正后以用户为准。
 *   2. 数据不够时明确说「还不足以总结」，绝不强行生成画像。
 */

// ================================================================ 词典

/** 情绪/担忧「类型」识别：用于生成个性化反馈与行动建议 */
const PATTERNS = [
  {
    id: 'fear-regret',
    label: '害怕以后后悔',
    hypothesis:
      '你似乎很在意这个选择的长期影响——怕的不是当下的难，而是将来回头看时觉得自己选错了。',
    hint: '把「会不会后悔」换成「哪个选项更贴合我真正想要的东西」，可逆的决定可以先小步试。',
    keywords: ['后悔', '以后会', '将来会', '错过了', '错过', '来不及', '白费', '浪费了', '走错路', '如果当初'],
    regex: /(后悔|错过|来不及|白费|浪费|走错)/,
  },
  {
    id: 'catastrophize',
    label: '预先想象最坏结果',
    hypothesis:
      '你已经在脑海里把最坏的结果演过一遍了——这很费心力，但那条最坏路径目前还只是想象，不是事实。',
    hint: '把「最坏会怎样」写成一句具体的话，再问：它发生的条件是什么？我能提前做点什么？',
    keywords: ['完蛋', '全毁了', '一定会失败', '肯定不行', '做不到', '撑不住', '最坏', '糟糕', '崩溃', '毁掉'],
    regex: /(完蛋|全毁|彻底|一定会|肯定会|肯定不|绝对不|最坏|崩溃|撑不住)/,
  },
  {
    id: 'seek-certainty',
    label: '需要确定答案才敢行动',
    hypothesis:
      '好像要等所有条件都确定下来，你才允许自己往前走——可是现实里很少有哪一步是「完全确定」的。',
    hint: '把「等确定」改成一个明确的截止时间：到那天，用当时手上有的信息做决定。',
    keywords: ['确定', '万一', '如果不', '要是', '保证', '一定得', '必须知道', '说不准', '没把握'],
    regex: /(万一|要是|如果不|保证|确定不|吃不准|说不准|心里没底|没把握)/,
  },
  {
    id: 'rumination',
    label: '反复比较 / 事后反刍',
    hypothesis:
      '你已经有了可行的方案，但还在继续找「会不会有更好的」；或者决定已经做了，脑子还在替另一个选项打分。',
    hint: '给比较设一个上限：列到第三个选项就停，然后只比最在意的那两项。',
    keywords: ['如果选', '另一个', '更好的', '是不是', '反复想', '一直在想', '脑子停不下来', '比较', '纠结'],
    regex: /(如果选|另一个|会不会更|更好的选|一直在想|停不下来|翻来覆去|反复想|纠结)/,
  },
  {
    id: 'other-approval',
    label: '需要别人的答案来确认',
    hypothesis:
      '你问过不止一个人，可换个人答案又不一样——因为这些答案里装的其实是他们自己的经验，不是你的。',
    hint: '问人的时候改成问「你当时是怎么判断的」，而不是「你觉得我该选哪个」。',
    keywords: ['别人', '他们', '怎么说', '建议', '问过', '都说', '朋友说', '家人说', '同学说', '意见', '问了'],
    regex: /(别人|朋友|家人|同学|老师|同事|领导)(说|都觉得|建议|劝|告诉|怎么看)|问了|都劝|问过|征求意见/,
  },
  {
    id: 'self-doubt',
    label: '提前判定自己不行',
    hypothesis: '事情还没开始，你已经在替结果判了「我做不到」。',
    hint: '把「我做不到」写成「我现在还不会 X」，然后只补最缺的那一块。',
    keywords: ['不行', '不够好', '配不上', '比不上', '太差', '没能力', '不配', '丢人', '被看不起'],
    regex: /(我不行|做不到|不够好|比不上|配不上|太差|没资格|丢人)/,
  },
  {
    id: 'waiting',
    label: '卡在等待别人回复上',
    hypothesis:
      '有一部分进程不在你手里，你只能等——等待期间人会不停猜测对方怎么想，这几乎必然发生。',
    hint: '给等待设一个明确的截止时间，到期没消息就按「默认方案」走。',
    keywords: ['等回复', '等消息', '等他', '等她', '还没回', '等待', '什么时候回', '没有回复'],
    regex: /(等|等不到|还没回|没有回复|什么时候回)/,
  },
  {
    id: 'compare-ideal',
    label: '拿现状和理想目标对比',
    hypothesis: '你把「现在的位置」和「想去的位置」放在同一把尺子上量，中间那段差距就成了压力本身——有时候比的还是别人。',
    hint: '把目标切成这一周能完成的一格，只跟上周的自己比。',
    keywords: ['理想', '应该', '本可以', '目标', '计划', '落后', '差距', '同龄', '比我', '别人都'],
    regex: /(本该|本可以|应该早就|落后|差距|同龄|别人都比我|比我强|比我好)/,
  },
  {
    id: 'physical',
    label: '焦虑已经影响到身体和睡眠',
    hypothesis: '这不只是想法的问题了，你的身体已经在报警——睡不好时，判断会明显更容易偏向坏结果。',
    hint: '先照顾身体，再处理决定。这不是逃避，是让后面的判断更准。',
    keywords: ['睡不着', '失眠', '头疼', '头痛', '心慌', '胸闷', '喘不过', '吃不下', '没胃口', '发抖', '恶心', '累'],
    regex: /(睡不着|失眠|头疼|头痛|心慌|胸闷|喘不上|吃不下|没胃口|发抖|半夜醒)/,
  },
];

/** 类别判定词 */
const LEX = {
  worry: ['担心', '害怕', '恐惧', '怕', '焦虑', '紧张', '不安', '心慌', '慌', '愁', '压力', '难受', '痛苦', '崩溃', '完蛋', '撑不住', '头疼', '头痛', '胸闷', '喘不上', '吃不下', '没胃口', '发抖'],
  /** 身体和心理状态：它既是一种信号，也常常需要单独归一类 */
  physical: ['睡不着', '失眠', '睡不好', '半夜醒', '头疼', '头痛', '心慌', '胸闷', '喘不上', '吃不下', '没胃口', '发抖', '恶心', '想哭', '累得', '没力气'],
  guess: ['可能', '也许', '大概', '或许', '应该会', '会不会', '感觉', '觉得', '估计', '说不定', '似乎', '好像', '也许吧', '按理说'],
  unknown: ['不知道', '不确定', '不清楚', '还不了解', '没查过', '不了解', '未知', '未知数', '说不准', '没法判断', '吃不准', '心里没底', '没把握', '还没有'],
  need: ['想要', '希望', '需要', '真正想', '在意', '重视', '怕失去', '舍不得', '值得', '梦想', '目标', '期望', '我在乎'],
  done: ['已经', '刚刚', '昨天', '前天', '上次', '当时', '之前', '刚', '向来', '一直', '原本'],
};

/** 事实的可验证特征：数字、时间、可核查的事件，以及「我做了什么 / 我观察到什么」 */
const FACT_CUES = /^\s*(看到|听说|得到|收到|查到|发现|被告知|通知|安排|报|考了|拿了|去了|见了)|^\s*我\s*(看到|听说|收到|查到|发现|做了|去了|问了|考了)|\d|今天|昨天|明天|上周|这周|上个月|这个月|今年|去年|成绩|分数|招生|复试线|报销|工资|名额|人数|截止|日期|通知|邮件|电话|会议|体检|面试|报名/;

// ================================================================ 工具

function clean(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * 切分句子。
 * 关键在于：一句里常常同时装着「事实」和「担忧」，例如
 *   「看到目标学校往年复试线比较高，我可能考不上，如果选简单的学校以后又会后悔。」
 * 如果整句只归一类，事实和担忧就会互相吃掉。
 * 所以先按句末标点切，再按「我 / 但是 / 也 / 却 / 又 / 一直」这类分句起点二次切分。
 */
function sentences(text) {
  const out = [];
  const firstPass = clean(text)
    .split(/[\n。！？!?；;]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const s of firstPass) {
    // 只在逗号后面跟「可能出现新主语 / 新话题 / 新状态」时切，避免把列举切碎。
    // 最后一组是身体和心理状态词：它们常常挂在逗号后面当成独立的小句，
    // 例如「一直反复比较三所学校，睡不着」——不切开就会和前面的话题混成一类。
    const parts = s
      .split(
        /[，,](?=\s*(?:我|但|但是|可|可是|却|又|也|而|而且|同时|另一方面|另外|不过|只是|所以|结果|后来|现在|以后|万一|要是|如果|一直|总|还是|每天|最近|这阵|整晚|常常))/)
      .flatMap((p) =>
        p.split(
          /[，,](?=\s*(?:睡不着|失眠|睡不好|吃不下|没胃口|心慌|胸闷|头疼|头痛|发抖|恶心|累|撑不住|想哭))/
        )
      )
      .map((x) => x.trim());
    for (const p of parts) {
      const t = p.replace(/^[，,、.．\-—*\s]+/, '').replace(/[，,、\s]+$/, '').trim();
      if (t.length >= 2) out.push(t);
    }
  }
  return out;
}

function hit(text, list) {
  return list.some((k) => text.includes(k));
}

function scoreOf(text, list) {
  return list.reduce((n, k) => (text.includes(k) ? n + 1 : n), 0);
}

function uniqPush(arr, item) {
  const key = item.text;
  if (!arr.some((x) => x.text === key)) arr.push(item);
}

// ================================================================ 拆解

/**
 * 把一段自由文本拆成结构化的五类。
 * 返回的每一项都带 source（原文片段），保证「AI 说的」可追溯到「用户写的」。
 */
function dissect(text) {
  const facts = [];
  const guesses = [];
  const worries = [];
  const unknowns = [];
  const needs = [];
  const actions = [];

  const units = sentences(text);
  // 长文本里，整段本身常常是「担忧的总述」，作为兜底来源
  for (const s of units) {
    const item = { text: s, source: s };

    const isAction =
      /^\s*(先|然后|接下来|下一步|明天去|今天去|明天要|今天要)/.test(s) ||
      /(打算|准备|决定先)/.test(s) ||
      /(去问|去查|去联系|去报名|去预约|去确认|去做|写完|整理|列一个|列个|打电话|发邮件)/.test(s);
    const sWorry = scoreOf(s, LEX.worry);
    const sPhysical = scoreOf(s, LEX.physical);
    const sGuess = scoreOf(s, LEX.guess);
    const sUnknown = scoreOf(s, LEX.unknown);
    const sNeed = scoreOf(s, LEX.need);
    const factCue = FACT_CUES.test(s);
    const sFact = (factCue ? 1 : 0) + (hit(s, LEX.done) ? 1 : 0);
    // 「我可能考不上」这类：既有不确定性，又带否定力量。算猜测，不算纯担忧。
    const isModalNegative = /(可能|也许|大概|或许|估计|说不定)(不|没|做不|考不|过不|撑不)/.test(s);
    const hasWorryWord = sWorry > 0;

    if (isAction) {
      uniqPush(actions, item);
      continue;
    }
    // 判定顺序，先强后弱：
    //   身体/睡眠状态（单独成句时）    -> 担忧（身体信号最需要先被看见）
    //   明确的「不知道/不确定」        -> 尚未确定的信息（「万一没考上」归这里）
    //   不确定性 + 否定力量            -> 猜测（「我可能考不上」）
    //   有担忧词                       -> 担忧
    //   有可核对的事实线索             -> 事实
    //   不确定性词                     -> 猜测
    //   需要词                         -> 需要
    if (sPhysical > 0 && sPhysical >= sWorry) {
      uniqPush(worries, item);
    } else if (sUnknown > 0 && sUnknown >= sGuess) {
      uniqPush(unknowns, item);
    } else if (isModalNegative) {
      uniqPush(guesses, item);
    } else if (hasWorryWord) {
      uniqPush(worries, item);
    } else if (factCue) {
      uniqPush(facts, item);
    } else if (sGuess > 0) {
      uniqPush(guesses, item);
    } else if (sNeed > 0) {
      uniqPush(needs, item);
    } else if (sFact > 0) {
      uniqPush(facts, item);
    } else {
      // 无法判定时倾向于当成「猜测/想法」，因为它通常出现在焦虑叙述里
      uniqPush(guesses, item);
    }
  }

  // 「未知」没有明确写出来时，可以从担忧里反推：担忧往往指向一个未知
  if (unknowns.length === 0) {
    const derived = worries
      .filter((w) => /(万一|会不会|能不能|行不行|有没有|是不是)/.test(w.text))
      .slice(0, 2)
      .map((w) => ({ text: `「${w.text}」这件事的实际情况还没有核实`, source: w.source, derived: true }));
    for (const d of derived) uniqPush(unknowns, d);
  }

  // 「需要」没有明确写出来时，从担忧的反面提取
  if (needs.length === 0 && worries.length > 0) {
    const w = worries[0].text;
    let need = '一个能让自己安心的确定答案';
    if (/(后悔|错过|来不及)/.test(text)) need = '不想因为提前放弃而错过自己真正想要的东西';
    else if (/(别人|朋友|家人|同学|老师|同事)/.test(text)) need = '希望自己的判断被理解，而不是被代替';
    else if (/(失败|做不到|不行|不够好)/.test(text)) need = '想确认自己有能力把事情做完，而不是只证明自己不行';
    else if (/(等|回复|消息)/.test(text)) need = '需要知道这件事到底有没有在自己手上';
    uniqPush(needs, { text: need, source: w, derived: true });
  }

  // 一句都没拆出来时，至少保留整段作为「事情经过」
  if (!facts.length && !guesses.length && !worries.length && !unknowns.length) {
    uniqPush(facts, { text: clean(text).slice(0, 200), source: clean(text).slice(0, 200) });
  }

  return { facts, guesses, worries, unknowns, needs, actions };
}

/**
 * 可控 / 不可控清单
 * ---------------------------------------------------------------
 * 这是整个产品里最能降焦虑的一步，所以规则写得更明确一些。
 * 判断依据：这件事的结果是不是真的由我的行为决定。
 *   外部的人、机构、行情、名额、录取、运气 —— 不在我手上
 *   我自己的动作、我自己的作息和状态       —— 在我手上
 */
const NOT_CONTROLLABLE_RE =
  /(别人|他人|他们|他|她|对方|导师|老师|领导|老板|面试官|公司|学校|hr|HR|招生|评审|政策|行情|市场|名额|结果|录取|分数线|排名|运气|机会|什么时候|回复|通知|消息|会不会|能不能|是否|够不够|比不比|考不考|做不了|办不到|没办法)/;
const CONTROLLABLE_RE =
  /^我(可以|能|要|去|打算|准备|应该)|^我的|(我能|我可以|我要|我打算|我准备|我会|整理|列一个|列个|查一下|问一下|打电话|发邮件|写下来|分两栏|设定|设一个|分类|预约|报名|复核|练习|复习|核对|备份)/;
/** 自己身体和心理状态是能调整的（不是「忍一忍」，是有具体办法的） */
const SELF_STATE_RE = /(睡不着|失眠|睡不好|作息|熬夜|心情|情绪|焦虑|紧张|没胃口|吃不下|身体|运动|休息)/;

function controllability(text, dissectResult) {
  const controllable = [];
  const notControllable = [];

  // 尚未核实的信息，默认先归到「不在我手上」——它还只是个问号
  const unknownTexts = new Set(dissectResult.unknowns.map((u) => u.text));

  const all = [...dissectResult.worries, ...dissectResult.guesses, ...dissectResult.unknowns];
  for (const item of all) {
    const t = item.text;
    if (!t || item.placeholder) continue;

    if (unknownTexts.has(t)) {
      uniqPush(notControllable, item);
      continue;
    }
    // 「我自己的状态」比「外部的人」优先判断：睡不着是我能着手调整的
    if (SELF_STATE_RE.test(t)) {
      uniqPush(controllable, item);
      continue;
    }
    if (CONTROLLABLE_RE.test(t)) {
      uniqPush(controllable, item);
      continue;
    }
    if (NOT_CONTROLLABLE_RE.test(t)) {
      uniqPush(notControllable, item);
      continue;
    }
    // 都不匹配时：以「我」开头、且指向未来行动的多半是能着手的地方；
    // 带否定力量的（「我能力不行」）是对自己的评价，不放进「我能决定」那一栏。
    const hasNegation = /(不|没|无法)/.test(t);
    if (/^我/.test(t) && !hasNegation && /(可能|也许|大概|会|要|想|准备|打算)/.test(t)) {
      uniqPush(controllable, item);
    } else {
      uniqPush(notControllable, item);
    }
  }

  // 兜底：两边都要有内容，否则这一步就失去意义了
  if (!controllable.length) {
    uniqPush(controllable, {
      text: '我现在能决定的那一小步（还没写下来）',
      source: '',
      placeholder: true,
    });
  }
  if (!notControllable.length) {
    uniqPush(notControllable, {
      text: '目前确实不在我手上、只能等待的部分',
      source: '',
      placeholder: true,
    });
  }
  return { controllable, notControllable };
}

/** 思考模式识别：给假设 + 证据，并显式声明这只是「等待验证的假设」 */
function detectPatterns(text, dissectResult) {
  const haystack = clean(text);
  const found = [];
  for (const p of PATTERNS) {
    const evidence = [];
    // 只看结构化的部分作为依据来源，保证「系统说的」能追溯到「用户写的」
    for (const unit of [...dissectResult.worries, ...dissectResult.guesses, ...dissectResult.unknowns, ...dissectResult.needs]) {
      if (p.regex.test(unit.text) || hit(unit.text, p.keywords)) evidence.push(unit.text);
    }
    if (evidence.length === 0) continue;

    // 打分 = 命中条数 + 依据本身的长度。
    // 之所以要算长度：像「睡不着」这种很短但很关键的身体信号，
    // 不能因为句子短就被一句冗长的「害怕以后后悔」挤掉。
    // 身体信号如果真的出现，一定要留在结果里——漏掉它比多报一条更糟。
    const evidenceChars = evidence.reduce((n, s) => n + s.length, 0);
    const score = evidence.length * 10 + Math.min(evidenceChars, 120);
    const confidence = evidence.length < 2 && haystack.length < 40 ? 'weak' : 'clear';

    found.push({
      id: p.id,
      label: p.label,
      hypothesis: p.hypothesis,
      hint: p.hint,
      evidence: evidence.slice(0, 3),
      score,
      strength: Number(Math.min(0.9, 0.3 + evidence.length * 0.15 + (haystack.length > 80 ? 0.1 : 0)).toFixed(2)),
      confidence,
      /** 用户可以对每条假设按下「不是这样」，前端把它记进 corrections */
      status: 'hypothesis',
    });
  }

  found.sort((a, b) => b.score - a.score);
  const top = found.slice(0, 4);
  // 身体/睡眠信号如果出现了却掉出前四，也要补回来——这一条不该被挤掉
  const body = found.find((p) => p.id === 'physical');
  if (body && !top.includes(body)) {
    top.pop();
    top.push(body);
  }
  return top;
}

// ================================================================ 微行动

const ACTION_BANK = {
  facts: {
    title: '把「事实」和「我的猜测」分成两栏写下来',
    detail: '左边只写能拿证据核对的（数字、日期、别人原话），右边写你的想法。这一步本身就能降一部分焦虑。',
    minutes: 10,
    horizon: 'today',
    reversible: true,
    tag: '拆解',
  },
  smallStep: {
    title: '从清单里挑一件 15 分钟内能做完的小事，现在做掉',
    detail: '不求解决整件事，只求让局面从「完全没动」变成「动了一点」。',
    minutes: 15,
    horizon: 'today',
    reversible: true,
    tag: '行动',
  },
  deadline: {
    title: '给这件事设一个明确的截止时间',
    detail: '写下来：到某天某时，我就用当时手上的信息做决定。到期不再往后拖。',
    minutes: 5,
    horizon: 'today',
    reversible: true,
    tag: '设置边界',
  },
  waiting: {
    title: '给等待设默认方案：到期没消息就按 B 计划走',
    detail: '把「等」变成一个有时间上限的状态，而不是无限期的悬空。',
    minutes: 10,
    horizon: 'today',
    reversible: true,
    tag: '设置边界',
  },
  askProcess: {
    title: '找 1 个人，改问「你当时是怎么判断的」',
    detail: '别问「你觉得我该选哪个」。你要的是别人的判断过程，不是替你做决定。最多问 2 个人，问完就停。',
    minutes: 20,
    horizon: 'week',
    reversible: true,
    tag: '外部信息',
  },
  verify: {
    title: '核实 1 条未知信息',
    detail: '从「尚未确定的信息」里挑一条最容易查的（招生人数、报名截止、对方口径），今天查到就记下来。',
    minutes: 20,
    horizon: 'today',
    reversible: true,
    tag: '补信息',
  },
  compare: {
    title: '只比最在意的两条标准，比完就停',
    detail: '写下你最在意的两项（比如「上岸概率」和「以后的方向」），只按这两项排一次序，不再引入第三项。',
    minutes: 25,
    horizon: 'week',
    reversible: true,
    tag: '收敛选择',
  },
  tinyReversible: {
    title: '先做一个可反悔的小决定',
    detail: '选那个「做错了也能退回来」的动作先做，用真实反馈替掉脑内推演。',
    minutes: 15,
    horizon: 'today',
    reversible: true,
    tag: '行动',
  },
  body: {
    title: '先照顾身体：把今晚的睡觉时间定下来',
    detail: '定一个具体的熄灯时间，睡前 30 分钟不碰这件事。睡不好时判断会明显偏向坏结果，这一步是为了让后面的判断更准。',
    minutes: 5,
    horizon: 'today',
    reversible: true,
    tag: '照顾自己',
  },
  selfCompassion: {
    title: '把「我做不到」改写成「我现在还不会 X」',
    detail: '写出那个具体的 X，然后只补最缺的一块。允许自己从不会开始。',
    minutes: 10,
    horizon: 'today',
    reversible: true,
    tag: '自我对话',
  },
  rest: {
    title: '给自己留 20 分钟，什么都不解决',
    detail: '不分析、不比较、不查资料。焦虑不是一个需要立刻消灭的敌人，它也需要有地方放一会儿。',
    minutes: 20,
    horizon: 'today',
    reversible: true,
    tag: '照顾自己',
  },
  scheduleReview: {
    title: '设定这次的回看时间',
    detail: '选一个日子回来看看：当初的判断有多少说准了。',
    minutes: 2,
    horizon: 'today',
    reversible: true,
    tag: '为未来留门',
  },
};

/**
 * 依据拆解结果生成 4-6 条具体措施。
 * 每条都是「今天/这周能做的具体动作」，不是「你要放平心态」这种没法执行的话。
 */
function buildActions(text, d, patterns) {
  const ids = new Set();
  const patternIds = new Set(patterns.map((p) => p.id));
  const push = (id, reason) => {
    if (ids.has(id)) return;
    ids.add(id);
    const base = ACTION_BANK[id];
    if (!base) return;
    ids.add(id);
    return { ...base, id: `${id}`, reason };
  };

  const out = [];
  const add = (id, reason) => {
    const a = push(id, reason);
    if (a) out.push(a);
  };

  // 1. 所有情况都先做「事实/猜测分栏」
  add('facts', '把糊在一起的东西分开，是这一步里最省力也最有效的动作。');

  // 2. 有什么未知就先去核实
  if (d.unknowns.length > 0) {
    add('verify', `你写了 ${d.unknowns.length} 条「还不确定」的信息，其中大多数是能查到的。`);
  }

  // 3. 按识别到的模式加对应的动作
  if (patternIds.has('fear-regret')) add('compare', '「怕以后后悔」通常来自选项没收敛，而不是信息不够。');
  if (patternIds.has('catastrophize')) add('smallStep', '对抗想象最坏结果的方式不是想得更乐观，而是拿到一点真实反馈。');
  if (patternIds.has('seek-certainty')) add('deadline', '你不需要一个确定答案才行动，你需要一个截止时间。');
  if (patternIds.has('rumination')) add('deadline', '反刍需要一个刹车，截止时间就是那个刹车。');
  if (patternIds.has('other-approval')) add('askProcess', '把「要答案」换成「要过程」，别人的经验才用得上。');
  if (patternIds.has('self-doubt')) add('selfCompassion', '先松开「我不行」这个结论，才有力气补具体的那一块。');
  if (patternIds.has('waiting')) add('waiting', '等待是最容易滋生猜测的状态，给它一个边界。');
  if (patternIds.has('compare-ideal')) add('smallStep', '把目标缩到这一周能完成的一格，压力才会变成动作。');
  if (patternIds.has('physical')) {
    out.unshift({ ...ACTION_BANK.body, id: 'body', reason: '你的记录里出现了身体反应，先照顾它，再处理决定。' });
    ids.add('body');
  }

  // 4. 可逆的小决定 —— 这条对「做决定」模式特别重要
  if (d.unknowns.length > 0 || patternIds.has('seek-certainty')) add('tinyReversible', '可逆的动作风险最低，却能最快换来真实信息。');

  // 5. 兜底：至少三条可执行动作
  if (out.length < 3) add('smallStep', '先让局面从「完全没动」变成「动了一点」。');
  if (out.length < 3) add('rest', '有些焦虑不需要被解决，只需要被允许存在一会儿。');
  if (out.length < 4) add('scheduleReview', '给自己留一个回来的时间，这一步是后面所有积累的起点。');

  return out.slice(0, 6).map((a, i) => ({
    ...a,
    id: a.id,
    order: i + 1,
    /** AI 的初稿，用户可任意编辑；editedAt 有值就说明是用户改过的 */
    editedAt: null,
    done: false,
  }));
}

// ================================================================ 主入口

/**
 * 分析一次记录，返回结构化的「思考档案」。
 * 输出结构与「真 AI」模式完全一致，前端与数据层不需要知道是谁分析的。
 */
function analyze({ title, mode, rawText, moodBefore }) {
  const text = clean(rawText);
  const d = dissect(text);
  const patterns = detectPatterns(text, d);
  const { controllable, notControllable } = controllability(text, d);
  const actions = buildActions(text, d, patterns);

  const modeHint = {
    pour: '你这次选的是「我想倾诉」。所以下面的整理不是要你去执行什么，只是让你看清自己在想什么。',
    clarify: '你这次选的是「我想理清问题」。下面的拆解就是我们用来理清的那张桌子。',
    decide: '你这次选的是「我想做个决定」。所以重点放在「哪些信息还缺」和「哪一步可以先走」。',
  }[mode] || '';

  return {
    engine: 'local',
    engineLabel: '本地分析引擎（离线，可直接编辑）',
    analyzedAt: new Date().toISOString(),
    summary: buildSummary(text, d, patterns),
    modeHint,
    facts: d.facts,
    guesses: d.guesses,
    worries: d.worries,
    unknowns: d.unknowns,
    needs: d.needs,
    controllable,
    notControllable,
    patterns,
    actions,
    /** 需要在回看时回答的问题，由「当时的我」先写下预期 */
    invitations: buildInvitations(text, d, patterns),
    /** 拆解时明确声明这是假设，不是结论 */
    disclaimer:
      '以上都是根据你自己写的文字整理的暂定假设，不是对你的判断，也不是心理诊断。哪一条不对，直接改掉或删掉——以你为准。',
  };
}

function buildSummary(text, d, patterns) {
  const bits = [];
  if (d.worries.length) bits.push(`${d.worries.length} 处担忧`);
  if (d.unknowns.length) bits.push(`${d.unknowns.length} 处还没确定的信息`);
  if (d.needs.length) bits.push(`${d.needs.length} 处你真正在意的东西`);
  const head = bits.length ? `这段记录里有 ${bits.join('、')}。` : '这段记录还比较短，我先把它放在这里。';
  const tail = patterns.length
    ? `其中比较明显的一个是「${patterns[0].label}」——这只是个假设，你可以说「不是这样」。`
    : '暂时还没有看出反复出现的模式，记录多几次会更清楚。';
  return head + tail;
}

function buildInvitations(text, d, patterns) {
  const list = [
    { id: 'what-happened', q: '实际发生了什么？', placeholder: '只写事实，不评价。' },
    { id: 'what-right', q: '当时哪些判断说准了？', placeholder: '哪怕只有一条也行。' },
    { id: 'what-wrong', q: '哪些担忧没有发生？哪些风险确实存在？', placeholder: '分开写：没发生的 / 真发生了的。' },
    { id: 'keep-change', q: '如果重来一次，我会保留什么、改变什么？', placeholder: '不用给标准答案，写你现在的想法。' },
  ];
  if (patterns.some((p) => p.id === 'fear-regret')) {
    list.splice(3, 0, { id: 'regret-check', q: '现在回头看，你有后悔吗？', placeholder: '有 / 没有 / 说不好，都可以。' });
  }
  return list;
}

module.exports = { analyze, dissect, detectPatterns, PATTERNS, ACTION_BANK };
