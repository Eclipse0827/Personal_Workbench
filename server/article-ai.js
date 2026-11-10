'use strict';

/**
 * 外刊阅读的 AI 通道：词汇解析 + 文章内问答。
 *
 * 与 ai.js 的短对话分开：这里只调用 llm.complete，不经过规则引擎、
 * 不生成行动方案、不会创建 Todo，也不会修改文章。
 * 本地规则引擎（mock）没有释义能力，这里明确报错，不伪造词典内容。
 */

const llm = require('./llm');
const dictionary = require('./dictionary');

const LOOKUP_SYSTEM = `你在「缓一缓」外刊阅读器里做词汇解析。只根据用户给出的文章语境解释当前选中的词、短语或句子。

要求：
1. 用中文解释；英文释义和例句保持英文。
2. 不要声称释义来自牛津、朗文等词典，也不要编造词源或音标。
3. 不确定的词性、搭配或结构可以留空，不要硬凑。
4. collocations 只放真实、常见的搭配；没有把握就返回空数组，不要用「不相关」「无」这类占位词凑数。
5. derivatives 只列与选中词同词根、靠前缀或后缀构成的真实派生词，附词性和中文。只要存在常见派生形式（如 -ly、-ness、-tion、-ment、-er、un- 等）就至少给 1 个；确实是基础虚词、没有常见派生词时才返回空数组。不要把复数、过去式、比较级这类词形变化当成派生词。
6. relatedWords 列由该词构成或与它紧密相关的常见短语 / 词，附中文；没有就空数组。不要抄文章里的其他词组，不要用生僻词或编造词凑数。
7. 句子模式要说明句子结构（主句、从句、修饰关系），不要逐词翻译；派生词和衍生词可以留空。
8. examples 是你自己新写的 2–3 个英文例句，用来展示这个词在真实生活、学习、工作或新闻中的常见用法；每句附中文翻译。不要照抄、引用或只改几个词就复用文章里的句子，也不要复述文章内容。一般要给满 2–3 个；只有在选中的是句子、或确实写不出与原文不重复的例句时才返回空数组。
9. 下面的 JSON 里每个键都必须出现，数组可以是空数组，但不要省略键。只输出一个 JSON 对象，不要代码块，不要额外解释：
{"term":"选中的词或短语","kind":"word|phrase|sentence","partOfSpeech":"词性；句子可留空","structure":"句子结构；单词可留空","definitionEn":"英文解释","definitionZh":"中文解释","collocations":["常见搭配"],"derivatives":[{"word":"派生词","partOfSpeech":"词性","meaningZh":"中文"}],"relatedWords":[{"word":"衍生词或短语","meaningZh":"中文"}],"examples":[{"en":"例句","zh":"例句翻译"}],"contextMeaning":"在当前文章语境下的含义","confidence":"high|medium|low"}`;

const GAP_SYSTEM = `你在补全一个英文词或短语的词典信息。只输出一个 JSON 对象，不要代码块，不要额外解释。

要求：
1. 只补用户点名缺少的字段，不要重复解释整个词。
2. derivatives 只列真实的派生词（同词根，靠 -ly、-ness、-tion、-ment、-er、un- 等前后缀构成），附词性和中文；不要把复数、过去式、比较级当成派生词。没有就返回空数组。
3. relatedWords 只列由该词构成的常见短语或紧密相关的词，附中文；不要抄文章里的其他词组。没有就返回空数组。
4. examples 另写 2–3 个英文例句并附中文翻译，展示真实生活、学习、工作或新闻里的常见用法。绝不能照抄、引用或只改几个词就复用用户给出的原文。写不出与原文不重复的例句就返回空数组。
5. 只输出这个结构（只包含用户要求补的键也可以）：
{"derivatives":[{"word":"","partOfSpeech":"","meaningZh":""}],"relatedWords":[{"word":"","meaningZh":""}],"examples":[{"en":"","zh":""}]}`;

const CHAT_SYSTEM = `你在「缓一缓」外刊阅读器里回答关于当前文章的问题。

要求：
1. 只依据提供的文章标题、选中内容和附近原文回答；原文没有提到就明确说没有提到。
2. 用中文回答，引用英文原文时保持原样。
3. 不要创建待办、计划或行动方案，也不要修改文章内容。
4. 回答简洁，通常 120–500 字；用户要求展开时可以更长。
5. 不要声称引用牛津、朗文等词典。`;

function unavailable() {
  return Object.assign(
    new Error('当前是本地规则引擎，无法生成词汇释义或文章问答。请在设置里连接 Ollama 或远程模型。'),
    { status: 409, code: 'ai-unavailable' }
  );
}

function assertAvailable(settings) {
  if (!settings || settings.aiProvider === 'mock') throw unavailable();
  if (settings.aiProvider === 'real' && !settings.apiKey) {
    throw Object.assign(new Error('远程模型还没有配置 API Key'), { status: 409, code: 'ai-unavailable' });
  }
  if (settings.aiProvider === 'ollama' && (!settings.ollamaUrl || !settings.ollamaModel)) {
    throw Object.assign(new Error('还没有配置 Ollama 地址或模型'), { status: 409, code: 'ai-unavailable' });
  }
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

const PLACEHOLDER = /^(不相关|无关|无|没有|暂无|未知|n\/?a|none|null|unknown|—|-|\.{1,3})$/i;

function stringList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item, maxLength))
    .filter((item) => item && !PLACEHOLDER.test(item))
    .slice(0, maxItems);
}

function compareWords(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** 模型有时会把原文原句当例句返回。和上下文有整段或四词以上连续重合的，一律丢掉 */
function copiedFromContext(example, contextText) {
  const words = compareWords(example);
  if (!words.length) return false;
  const contextWords = compareWords(contextText);
  if (!contextWords.length) return false;

  const phrase = words.join(' ');
  if (phrase.length >= 12 && contextWords.join(' ').includes(phrase)) return true;

  const size = 4;
  if (words.length < size || contextWords.length < size) return false;
  const contextGrams = new Set();
  for (let i = 0; i <= contextWords.length - size; i += 1) {
    contextGrams.add(contextWords.slice(i, i + size).join(' '));
  }
  for (let i = 0; i <= words.length - size; i += 1) {
    if (contextGrams.has(words.slice(i, i + size).join(' '))) return true;
  }
  return false;
}

function examples(value, contextText) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return { en: text(item, 400), zh: '' };
      if (!item || typeof item !== 'object') return null;
      const en = text(item.en, 400);
      const zh = text(item.zh, 300);
      return en || zh ? { en, zh } : null;
    })
    .filter(Boolean)
    .filter((item) => !copiedFromContext(item.en, contextText))
    .slice(0, 6);
}

function wordEntries(value, maxItems, maxWordLength) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') {
        const word = text(item, maxWordLength);
        return word && !PLACEHOLDER.test(word) ? { word, partOfSpeech: '', meaningZh: '' } : null;
      }
      if (!item || typeof item !== 'object') return null;
      const word = text(item.word, maxWordLength);
      if (!word || PLACEHOLDER.test(word)) return null;
      const meaningZh = text(item.meaningZh, 300);
      return {
        word,
        partOfSpeech: text(item.partOfSpeech, 60),
        meaningZh: PLACEHOLDER.test(meaningZh) ? '' : meaningZh,
      };
    })
    .filter(Boolean)
    .slice(0, maxItems);
}

function mergeExamples(existing, incoming) {
  const out = [...(existing || [])];
  const seen = new Set(out.map((item) => String(item.en || '').toLowerCase().trim()).filter(Boolean));
  for (const item of incoming || []) {
    const key = String(item.en || '').toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(0, 6);
}

/** 第一次结果里缺少哪些字段；牛津已经提供的部分不重复问模型 */
function missingFields(entry, selection) {
  if (selection.mode === 'sentence') return [];
  const missing = [];
  const officialExamples = (entry.oxford && entry.oxford.examples) || [];
  if ((entry.examples || []).length < 2 && officialExamples.length < 2) missing.push('examples');
  if (selection.mode === 'word' && !(entry.derivatives || []).length) {
    missing.push('derivatives');
  }
  return missing;
}

async function fillGaps({ settings, selection, contextText, entry, missing }) {
  const user = [
    contextText,
    '',
    `词/短语：「${selection.text}」`,
    `已有释义：${entry.definitionZh || entry.definitionEn || '（暂无）'}`,
    `请只补这些字段：${missing.join('、')}`,
  ].join('\n');

  try {
    const out = await llm.complete({
      settings,
      system: GAP_SYSTEM,
      user,
      temperature: 0.4,
      maxTokens: 900,
      timeoutMs: settings.aiProvider === 'ollama' ? 150000 : 90000,
      disableReasoning: true,
    });
    const raw = llm.parseJson(out.text);
    if (!raw) return entry;

    const next = { ...entry };
    if (missing.includes('examples')) {
      const extra = examples(raw.examples, contextText);
      if (extra.length) next.examples = mergeExamples(next.examples, extra);
    }
    if (missing.includes('derivatives')) {
      const extra = wordEntries(raw.derivatives, 8, 80);
      if (extra.length) next.derivatives = extra;
    }
    if (missing.includes('relatedWords')) {
      const extra = wordEntries(raw.relatedWords, 8, 120);
      if (extra.length) next.relatedWords = extra;
    }
    return next;
  } catch {
    // 补全只是加分项，失败时保留第一次的释义
    return entry;
  }
}

function lookupEntry(raw, selection, provider, model, contextText) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const definitionEn = text(data.definitionEn, 800);
  const definitionZh = text(data.definitionZh, 800);
  const contextMeaning = text(data.contextMeaning, 1000);
  if (!definitionZh && !contextMeaning) {
    throw new Error('模型没有给出可用的释义');
  }
  return {
    term: text(data.term, 120) || selection.text,
    kind: ['word', 'phrase', 'sentence'].includes(data.kind) ? data.kind : selection.mode,
    partOfSpeech: text(data.partOfSpeech, 80),
    structure: text(data.structure, 500),
    definitionEn,
    definitionZh,
    collocations: stringList(data.collocations, 8, 180),
    derivatives: wordEntries(data.derivatives, 8, 80),
    relatedWords: wordEntries(data.relatedWords, 8, 120),
    examples: examples(data.examples, contextText),
    contextMeaning,
    confidence: ['high', 'medium', 'low'].includes(data.confidence) ? data.confidence : 'medium',
    provider,
    model: model || '',
  };
}

async function lookup({ settings, article, selection, contextText }) {
  assertAvailable(settings);
  const user = [
    contextText,
    '',
    `请解释选中的${selection.mode === 'sentence' ? '句子' : selection.mode === 'word' ? '单词' : '短语'}：「${selection.text}」`,
  ].join('\n');

  const out = await llm.complete({
    settings,
    system: LOOKUP_SYSTEM,
    user,
    temperature: 0.2,
    maxTokens: 1800,
    timeoutMs: settings.aiProvider === 'ollama' ? 150000 : 90000,
    disableReasoning: true,
  });
  const raw = llm.parseJson(out.text);
  if (!raw) throw new Error('模型没有返回可解析的释义，请再试一次');

  let entry = lookupEntry(raw, selection, out.provider, out.model, contextText);
  try {
    entry = await dictionary.enrich(entry, { settings, selection });
  } catch {
    // 词典服务不可用不能拖垮查词，继续用模型结果
  }

  const missing = missingFields(entry, selection);
  if (missing.length) {
    entry = await fillGaps({ settings, selection, contextText, entry, missing });
  }

  return { entry, provider: out.provider, model: out.model };
}

async function chat({ settings, article, contextText, question, history }) {
  assertAvailable(settings);
  const historyMessages = (history || []).slice(-8).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 1600),
  }));
  const messages = [
    { role: 'system', content: CHAT_SYSTEM },
    { role: 'system', content: contextText },
    ...historyMessages,
    { role: 'user', content: question },
  ];

  const out = await llm.complete({
    settings,
    messages,
    temperature: 0.3,
    maxTokens: 1200,
    timeoutMs: settings.aiProvider === 'ollama' ? 150000 : 90000,
    disableReasoning: true,
  });
  const content = String(out.text || '').trim();
  if (!content) throw new Error('模型返回了空回答');
  return { content: content.slice(0, 12000), provider: out.provider, model: out.model };
}

module.exports = { lookup, chat, assertAvailable, LOOKUP_SYSTEM, CHAT_SYSTEM };
