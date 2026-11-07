'use strict';

/**
 * 外刊阅读：文章、高亮、生词、文章内对话的数据与校验。
 *
 * 文章正文单独存放，列表接口不读全文；高亮只记录段落内字符偏移，
 * 改字号或窗口宽度都不会让批注错位。
 */

const db = require('./db');

const MAX_ARTICLE_CHARS = 300000;
const MAX_PARAGRAPHS = 3000;
const MAX_HIGHLIGHTS = 500;
const MAX_HIGHLIGHT_CHARS = 2000;
const MAX_HIGHLIGHT_NOTE = 1000;
const MAX_CHAT_MESSAGES = 200;
const MAX_CHAT_CHARS = 4000;
const FONT_MIN = 16;
const FONT_MAX = 26;
const DEFAULT_FONT = 19;

function bad(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function str(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function int(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function normalizeText(input) {
  return String(input || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripInlineMarkdown(line) {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!])/g, '$1');
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, '');
}

function splitLongBlock(text, max = 1400) {
  if (text.length <= max) return [text];
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = -1;
    for (let i = max; i >= Math.floor(max * 0.45); i -= 1) {
      if (/[.!?。！？]/.test(rest[i - 1])) { cut = i; break; }
    }
    if (cut < 0) cut = rest.lastIndexOf(' ', max);
    if (cut < 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}

/**
 * 纯文本 / Markdown → 段落。
 * HTML 标签一律剥掉，只保留文字；Markdown 只识别标题、引用、列表和代码块。
 */
function parseArticleText(input, format = 'plain') {
  const text = normalizeText(input);
  if (!text) throw bad('文章内容是空的');
  if (text.length > MAX_ARTICLE_CHARS) {
    throw bad(`文章超过 ${MAX_ARTICLE_CHARS} 个字符，先拆分一下再导入`);
  }

  const isMarkdown = format === 'md' || format === 'markdown';
  const lines = text.split('\n');
  const raw = [];
  let codeLines = null;

  const pushParagraph = (value) => {
    const clean = String(value || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    for (const piece of splitLongBlock(clean)) raw.push({ kind: 'paragraph', text: piece });
  };

  let buffer = [];
  const flush = () => {
    if (buffer.length) {
      pushParagraph(buffer.join(' '));
      buffer = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (isMarkdown && /^```/.test(trimmed)) {
      if (codeLines) {
        const code = codeLines.join('\n').trim();
        if (code) raw.push({ kind: 'code', text: code.slice(0, 20000) });
        codeLines = null;
      } else {
        flush();
        codeLines = [];
      }
      continue;
    }
    if (codeLines) { codeLines.push(line); continue; }
    if (!trimmed) { flush(); continue; }

    if (isMarkdown) {
      const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flush();
        raw.push({
          kind: 'heading',
          level: heading[1].length,
          text: stripInlineMarkdown(heading[2]).trim().slice(0, 300),
        });
        continue;
      }
      const quote = trimmed.match(/^>\s?(.*)$/);
      if (quote) {
        flush();
        raw.push({ kind: 'quote', text: stripInlineMarkdown(quote[1]).trim() });
        continue;
      }
      const list = trimmed.match(/^(?:[-*+]|\d{1,2}[.)])\s+(.+)$/);
      if (list) {
        flush();
        raw.push({ kind: 'list', text: stripInlineMarkdown(list[1]).trim() });
        continue;
      }
      buffer.push(stripInlineMarkdown(trimmed));
      continue;
    }

    buffer.push(stripHtml(trimmed));
  }
  flush();
  if (codeLines && codeLines.length) {
    const code = codeLines.join('\n').trim();
    if (code) raw.push({ kind: 'code', text: code.slice(0, 20000) });
  }

  const paragraphs = raw
    .filter((p) => p.text)
    .slice(0, MAX_PARAGRAPHS)
    .map((p, index) => ({ id: `p-${index + 1}`, ...p }));

  if (!paragraphs.length) throw bad('没有从内容里读到可阅读的文字');
  return paragraphs;
}

function countWords(paragraphs) {
  const text = paragraphs.map((p) => p.text).join(' ');
  const latin = text.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];
  if (latin.length) return latin.length;
  return (text.replace(/\s/g, '') || '').length;
}

function makeExcerpt(paragraphs) {
  const first = paragraphs.find((p) => p.kind === 'paragraph') || paragraphs[0];
  return String(first ? first.text : '').replace(/\s+/g, ' ').slice(0, 180);
}

function normalizeUrl(value) {
  const url = str(value, 500);
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) throw bad('文章链接需要以 http:// 或 https:// 开头');
  return url;
}

function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((tag) => str(tag, 24))
    .filter(Boolean)
    .slice(0, 8);
}

function newArticleRecord({
  title, source, author, issue, url, format, fileName, paragraphs,
}) {
  const now = db.nowIso();
  const safeParagraphs = Array.isArray(paragraphs) ? paragraphs : [];
  return {
    id: db.newId('art'),
    title: str(title, 200) || '未命名外刊',
    source: str(source, 120),
    author: str(author, 120),
    issue: str(issue, 60),
    url: normalizeUrl(url),
    format: ['plain', 'md', 'pdf'].includes(format) ? format : 'plain',
    fileName: str(fileName, 260),
    wordCount: countWords(safeParagraphs),
    paragraphCount: safeParagraphs.length,
    excerpt: makeExcerpt(safeParagraphs),
    tags: normalizeTags([]),
    status: 'ready',
    progress: {
      anchorParagraphId: null,
      anchorRatio: 0,
      percent: 0,
      lastReadAt: null,
    },
    reader: { fontSize: DEFAULT_FONT },
    highlights: [],
    createdAt: now,
    updatedAt: now,
  };
}

function refreshArticleStats(article, paragraphs) {
  article.paragraphCount = paragraphs.length;
  article.wordCount = countWords(paragraphs);
  article.excerpt = makeExcerpt(paragraphs);
  return article;
}

function articleSummary(article) {
  return {
    id: article.id,
    title: article.title,
    source: article.source,
    author: article.author,
    issue: article.issue,
    url: article.url,
    format: article.format,
    fileName: article.fileName,
    wordCount: article.wordCount,
    paragraphCount: article.paragraphCount,
    excerpt: article.excerpt,
    tags: article.tags || [],
    progress: article.progress || null,
    reader: article.reader || { fontSize: DEFAULT_FONT },
    createdAt: article.createdAt,
    updatedAt: article.updatedAt,
  };
}

function articleDetail(article) {
  return {
    ...articleSummary(article),
    highlights: Array.isArray(article.highlights) ? article.highlights : [],
  };
}

function patchArticle(article, body = {}) {
  if (typeof body.title === 'string') {
    const title = str(body.title, 200);
    if (!title) throw bad('给这篇文章起个名字吧');
    article.title = title;
  }
  if (typeof body.source === 'string') article.source = str(body.source, 120);
  if (typeof body.author === 'string') article.author = str(body.author, 120);
  if (typeof body.issue === 'string') article.issue = str(body.issue, 60);
  if (body.url !== undefined) article.url = normalizeUrl(body.url);
  if (body.tags !== undefined) article.tags = normalizeTags(body.tags);
  if (body.reader && body.reader.fontSize !== undefined) {
    const size = Number(body.reader.fontSize);
    if (!Number.isFinite(size)) throw bad('字号不正确');
    article.reader = { fontSize: clamp(Math.round(size), FONT_MIN, FONT_MAX) };
  }
  return article;
}

function applyProgress(article, paragraphs, input = {}) {
  const paragraphId = str(input.paragraphId, 64);
  const index = (paragraphs || []).findIndex((p) => p.id === paragraphId);
  if (index < 0) throw bad('找不到要定位的段落');
  const ratio = Number(input.ratio);
  if (!Number.isFinite(ratio)) throw bad('阅读位置不正确');
  const safeRatio = clamp(ratio, 0, 1);
  const percent = Math.round(((index + safeRatio) / paragraphs.length) * 100);
  article.progress = {
    anchorParagraphId: paragraphId,
    anchorRatio: Math.round(safeRatio * 1000) / 1000,
    percent: clamp(percent, 0, 100),
    lastReadAt: db.nowIso(),
  };
  return article.progress;
}

function ensureHighlightBudget(article, exceptId = null) {
  const count = (article.highlights || []).filter((h) => h.id !== exceptId).length;
  if (count >= MAX_HIGHLIGHTS) throw bad(`每篇文章最多 ${MAX_HIGHLIGHTS} 条高亮`);
}

function buildHighlight(article, paragraphs, input = {}, existing = null) {
  const paragraphId = str(input.paragraphId, 64);
  const paragraph = paragraphs.find((p) => p.id === paragraphId);
  if (!paragraph) throw bad('找不到要高亮的段落');
  const start = int(input.start);
  const end = int(input.end);
  if (start === null || end === null || start < 0 || start >= end || end > paragraph.text.length) {
    throw bad('高亮范围不正确');
  }
  if (end - start > MAX_HIGHLIGHT_CHARS) throw bad('一次高亮的文字太长了');
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, MAX_HIGHLIGHT_NOTE) : '';
  const now = db.nowIso();
  if (existing) {
    existing.paragraphId = paragraphId;
    existing.start = start;
    existing.end = end;
    existing.quote = paragraph.text.slice(start, end);
    existing.note = note;
    existing.updatedAt = now;
    return existing;
  }
  ensureHighlightBudget(article);
  return {
    id: db.newId('hl'),
    paragraphId,
    start,
    end,
    quote: paragraph.text.slice(start, end),
    note,
    createdAt: now,
    updatedAt: now,
  };
}

function findHighlight(article, highlightId) {
  return (article.highlights || []).find((h) => h.id === highlightId) || null;
}

function normalizeSelection(paragraphs, input = {}) {
  const paragraphId = str(input.paragraphId, 64);
  const paragraph = paragraphs.find((p) => p.id === paragraphId);
  if (!paragraph) throw bad('找不到选中的段落');
  const start = int(input.start);
  const end = int(input.end);
  if (start === null || end === null || start < 0 || start >= end || end > paragraph.text.length) {
    throw bad('选中的文字范围不正确');
  }
  if (end - start > MAX_HIGHLIGHT_CHARS) throw bad('一次选中的文字太长了');
  return {
    paragraphId,
    start,
    end,
    text: paragraph.text.slice(start, end),
    mode: ['word', 'phrase', 'sentence'].includes(input.mode) ? input.mode : 'phrase',
    paragraph,
  };
}

/** 查词只带选中内容、所在段落和前后各一段，不把整篇文章发给模型。 */
function buildLookupContext(article, paragraphs, selection) {
  const index = paragraphs.findIndex((p) => p.id === selection.paragraphId);
  const before = index > 0 ? paragraphs[index - 1].text : '';
  const after = index + 1 < paragraphs.length ? paragraphs[index + 1].text : '';
  return [
    `文章：${article.title}`,
    article.source ? `来源：${article.source}` : '',
    `选中内容（${selection.mode}）：${selection.text}`,
    `所在段落：${selection.paragraph.text.slice(0, 1400)}`,
    before ? `上一段：${before.slice(0, 400)}` : '',
    after ? `下一段：${after.slice(0, 400)}` : '',
  ].filter(Boolean).join('\n').slice(0, 2600);
}

function buildChatContext(article, paragraphs, { paragraphId = '', selectionText = '' } = {}) {
  const index = Math.max(0, paragraphs.findIndex((p) => p.id === paragraphId));
  const nearby = paragraphs
    .slice(Math.max(0, index - 1), Math.min(paragraphs.length, index + 2))
    .map((p) => p.text)
    .join('\n\n');
  return [
    `文章：${article.title}`,
    article.source ? `来源：${article.source}` : '',
    selectionText ? `用户选中的内容：${selectionText.slice(0, 1200)}` : '',
    `当前阅读位置附近的原文：${nearby.slice(0, 3000)}`,
  ].filter(Boolean).join('\n').slice(0, 6000);
}

// ---------------------------------------------------------------- 生词本

function normalizeTerm(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 120);
}

function stringList(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === 'string' ? item.trim().slice(0, maxLength) : ''))
    .filter(Boolean)
    .slice(0, maxItems);
}

function exampleList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === 'string') return { en: item.trim().slice(0, 400), zh: '' };
      if (!item || typeof item !== 'object') return null;
      const en = str(item.en, 400);
      const zh = str(item.zh, 300);
      return en || zh ? { en, zh } : null;
    })
    .filter(Boolean)
    .slice(0, 6);
}

function newVocabularyRecord({ article, contextText, selectionText, kind, entry }) {
  const term = str(entry && entry.term, 120) || str(selectionText, 120);
  const normalized = normalizeTerm(term);
  if (!normalized) throw bad('没有可加入生词本的内容');
  const now = db.nowIso();
  return {
    id: db.newId('voc'),
    term,
    normalized,
    kind: ['word', 'phrase', 'sentence'].includes(kind) ? kind : 'word',
    partOfSpeech: str(entry && entry.partOfSpeech, 80),
    structure: str(entry && entry.structure, 500),
    definitionEn: str(entry && entry.definitionEn, 800),
    definitionZh: str(entry && entry.definitionZh, 800),
    collocations: stringList(entry && entry.collocations, 8, 180),
    examples: exampleList(entry && entry.examples),
    contextMeaning: str(entry && entry.contextMeaning, 1000),
    contextText: str(contextText, 800),
    articleId: article.id,
    articleTitle: article.title,
    entryProvider: str(entry && entry.provider, 20) || 'unknown',
    entryModel: str(entry && entry.model, 120),
    entryGeneratedAt: now,
    note: '',
    seenCount: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function mergeVocabulary(existing, incoming) {
  existing.seenCount = (Number(existing.seenCount) || 1) + 1;
  existing.contextText = incoming.contextText || existing.contextText;
  existing.articleId = incoming.articleId;
  existing.articleTitle = incoming.articleTitle;
  if (!existing.definitionZh && incoming.definitionZh) existing.definitionZh = incoming.definitionZh;
  if (!existing.contextMeaning && incoming.contextMeaning) existing.contextMeaning = incoming.contextMeaning;
  existing.updatedAt = db.nowIso();
  return existing;
}

// ---------------------------------------------------------------- 文章内对话

function newArticleChat() {
  return { messages: [] };
}

function appendChatMessage(chat, message) {
  chat.messages.push(message);
  if (chat.messages.length > MAX_CHAT_MESSAGES) {
    chat.messages = chat.messages.slice(-MAX_CHAT_MESSAGES);
  }
  return message;
}

function newChatMessage({ role, content, selection, provider, model }) {
  return {
    id: db.newId('amsg'),
    role: role === 'assistant' ? 'assistant' : 'user',
    content: str(content, role === 'assistant' ? 12000 : MAX_CHAT_CHARS),
    selection: selection || null,
    provider: provider || null,
    model: model || '',
    createdAt: db.nowIso(),
  };
}

module.exports = {
  MAX_ARTICLE_CHARS,
  MAX_PARAGRAPHS,
  MAX_HIGHLIGHTS,
  MAX_CHAT_MESSAGES,
  FONT_MIN,
  FONT_MAX,
  DEFAULT_FONT,
  normalizeText,
  parseArticleText,
  countWords,
  newArticleRecord,
  refreshArticleStats,
  articleSummary,
  articleDetail,
  patchArticle,
  applyProgress,
  buildHighlight,
  findHighlight,
  normalizeSelection,
  buildLookupContext,
  buildChatContext,
  normalizeTerm,
  newVocabularyRecord,
  mergeVocabulary,
  newArticleChat,
  appendChatMessage,
  newChatMessage,
};
