'use strict';

/**
 * 外刊阅读的 AI 通道：词汇解析 + 文章内问答。
 *
 * 与 ai.js 的短对话分开：这里只调用 llm.complete，不经过规则引擎、
 * 不生成行动方案、不会创建 Todo，也不会修改文章。
 * 本地规则引擎（mock）没有释义能力，这里明确报错，不伪造词典内容。
 */

const llm = require('./llm');

const LOOKUP_SYSTEM = `你在「缓一缓」外刊阅读器里做词汇解析。只根据用户给出的文章语境解释当前选中的词、短语或句子。

要求：
1. 用中文解释；英文释义和例句保持英文。
2. 不要声称释义来自牛津、朗文等词典，也不要编造词源或音标。
3. 不确定的词性、搭配或结构可以留空，不要硬凑。
4. collocations 只放真实、常见的搭配；没有把握就返回空数组，不要用「不相关」「无」这类占位词凑数。
5. 句子模式要说明句子结构（主句、从句、修饰关系），不要逐词翻译。
6. 只输出一个 JSON 对象，不要代码块，不要额外解释：
{"term":"选中的词或短语","kind":"word|phrase|sentence","partOfSpeech":"词性；句子可留空","structure":"句子结构；单词可留空","definitionEn":"英文解释","definitionZh":"中文解释","collocations":["常见搭配"],"examples":[{"en":"例句","zh":"例句翻译"}],"contextMeaning":"在当前文章语境下的含义","confidence":"high|medium|low"}`;

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

function examples(value) {
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
    .slice(0, 6);
}

function lookupEntry(raw, selection, provider, model) {
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
    examples: examples(data.examples),
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
    maxTokens: 900,
    timeoutMs: settings.aiProvider === 'ollama' ? 150000 : 60000,
  });
  const raw = llm.parseJson(out.text);
  if (!raw) throw new Error('模型没有返回可解析的释义，请再试一次');
  return {
    entry: lookupEntry(raw, selection, out.provider, out.model),
    provider: out.provider,
    model: out.model,
  };
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
    timeoutMs: settings.aiProvider === 'ollama' ? 150000 : 60000,
  });
  const content = String(out.text || '').trim();
  if (!content) throw new Error('模型返回了空回答');
  return { content: content.slice(0, 12000), provider: out.provider, model: out.model };
}

module.exports = { lookup, chat, assertAvailable, LOOKUP_SYSTEM, CHAT_SYSTEM };
