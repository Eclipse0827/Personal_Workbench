/**
 * 外刊阅读的文本工具：段落渲染、选区偏移、单词/句子边界。
 *
 * 高亮只保存段落内字符偏移，渲染时再切分成 textNode 和 <mark>；
 * 所有文字都通过文本节点写入，绝不拼 innerHTML。
 */

import { h } from './ui.js';

const WORD_CHAR = /[A-Za-z'’-]/;

function clampRange(start, end, length) {
  const a = Math.max(0, Math.min(length, start));
  const b = Math.max(a, Math.min(length, end));
  return [a, b];
}

export function splitHighlightSegments(text, highlights = []) {
  const source = String(text || '');
  const valid = (highlights || [])
    .filter((hl) => hl && Number.isInteger(hl.start) && Number.isInteger(hl.end))
    .map((hl) => {
      const [start, end] = clampRange(hl.start, hl.end, source.length);
      return { ...hl, start, end };
    })
    .filter((hl) => hl.start < hl.end);

  if (!valid.length) return [{ start: 0, end: source.length, text: source, ids: [] }];

  const points = new Set([0, source.length]);
  for (const hl of valid) {
    points.add(hl.start);
    points.add(hl.end);
  }
  const sorted = [...points].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const start = sorted[i];
    const end = sorted[i + 1];
    const ids = valid
      .filter((hl) => hl.start <= start && hl.end >= end)
      .map((hl) => hl.id);
    out.push({ start, end, text: source.slice(start, end), ids });
  }
  return out;
}

export function renderArticleParagraph(paragraph, highlights = [], { onHighlightClick } = {}) {
  const tag = paragraph.kind === 'heading' ? 'h2'
    : paragraph.kind === 'quote' ? 'blockquote'
      : paragraph.kind === 'code' ? 'pre'
        : 'p';
  const el = h(`${tag}.article-block.article-${paragraph.kind || 'paragraph'}`, {
    dataset: { paragraphId: paragraph.id },
  });

  const segments = splitHighlightSegments(paragraph.text, highlights);
  for (const segment of segments) {
    if (!segment.text) continue;
    if (!segment.ids.length) {
      el.appendChild(document.createTextNode(segment.text));
      continue;
    }
    const mark = h('mark.article-hl', {
      dataset: { highlightIds: segment.ids.join(',') },
      title: '查看批注',
      onclick: (e) => {
        e.stopPropagation();
        if (onHighlightClick) onHighlightClick(segment.ids[0]);
      },
    }, segment.text);
    el.appendChild(mark);
  }
  return el;
}

export function wordRangeAt(text, index) {
  const source = String(text || '');
  if (!source.length) return null;
  let at = Math.max(0, Math.min(source.length - 1, index));
  if (!WORD_CHAR.test(source[at]) && at > 0 && WORD_CHAR.test(source[at - 1])) at -= 1;
  if (!WORD_CHAR.test(source[at])) return null;
  let start = at;
  let end = at + 1;
  while (start > 0 && WORD_CHAR.test(source[start - 1])) start -= 1;
  while (end < source.length && WORD_CHAR.test(source[end])) end += 1;
  const value = source.slice(start, end).replace(/^[-’']+|[-’']+$/g, '');
  if (!/[A-Za-z]/.test(value)) return null;
  return { start, end, text: value };
}

export function sentenceRangeAt(text, index) {
  const source = String(text || '');
  if (!source.trim()) return null;
  const at = Math.max(0, Math.min(source.length - 1, index));
  let start = 0;
  for (let i = at; i > 0; i -= 1) {
    if (/[.!?]/.test(source[i - 1]) && /\s/.test(source[i] || '')) { start = i; break; }
  }
  let end = source.length;
  for (let i = at; i < source.length; i += 1) {
    if (/[.!?]/.test(source[i])) { end = i + 1; break; }
  }
  while (start < end && /\s/.test(source[start])) start += 1;
  while (end > start && /\s/.test(source[end - 1])) end -= 1;
  if (start >= end) return null;
  return { start, end, text: source.slice(start, end) };
}

export function modeForText(value) {
  const text = String(value || '').trim();
  if (!text) return 'phrase';
  if (/^[A-Za-z][A-Za-z'’-]*$/.test(text)) return 'word';
  if (/[.!?。！？]$/.test(text) || text.split(/\s+/).length > 10) return 'sentence';
  return 'phrase';
}

function paragraphOf(node) {
  let el = node && node.nodeType === 3 ? node.parentNode : node;
  while (el && el.nodeType === 1) {
    if (el.dataset && el.dataset.paragraphId) return el;
    el = el.parentNode;
  }
  return null;
}

export function selectionOffsets(paragraphEl) {
  const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const startParagraph = paragraphOf(range.startContainer);
  const endParagraph = paragraphOf(range.endContainer);
  if (!startParagraph || startParagraph !== endParagraph || startParagraph !== paragraphEl) return null;

  const beforeStart = document.createRange();
  beforeStart.setStart(paragraphEl, 0);
  beforeStart.setEnd(range.startContainer, range.startOffset);
  let start = beforeStart.toString().length;

  const beforeEnd = document.createRange();
  beforeEnd.setStart(paragraphEl, 0);
  beforeEnd.setEnd(range.endContainer, range.endOffset);
  let end = beforeEnd.toString().length;

  const full = paragraphEl.textContent || '';
  while (start < end && /\s/.test(full[start])) start += 1;
  while (end > start && /\s/.test(full[end - 1])) end -= 1;
  if (start >= end) return null;
  const text = full.slice(start, end);
  return {
    paragraphId: paragraphEl.dataset.paragraphId,
    start,
    end,
    text,
    mode: modeForText(text),
  };
}

export function caretOffset(paragraphEl, clientX, clientY) {
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(clientX, clientY);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(clientX, clientY);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
    }
  }
  if (!range) return null;
  if (paragraphOf(range.startContainer) !== paragraphEl) return null;
  const before = document.createRange();
  before.setStart(paragraphEl, 0);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

export function setSelectionRangeInParagraph(paragraphEl, start, end) {
  if (!paragraphEl || typeof window === 'undefined' || !window.getSelection) return false;
  const walker = document.createTreeWalker(paragraphEl, NodeFilter.SHOW_TEXT);
  let position = 0;
  let startNode = null;
  let endNode = null;
  let startOffset = 0;
  let endOffset = 0;
  let node = walker.nextNode();
  while (node) {
    const next = position + node.textContent.length;
    if (!startNode && start >= position && start <= next) {
      startNode = node;
      startOffset = start - position;
    }
    if (!endNode && end >= position && end <= next) {
      endNode = node;
      endOffset = end - position;
    }
    if (startNode && endNode) break;
    position = next;
    node = walker.nextNode();
  }
  if (!startNode || !endNode) return false;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}
