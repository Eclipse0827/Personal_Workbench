/**
 * 只够用的轻量 Markdown。
 * 所有内容都走 textNode，绝不拼 innerHTML —— 模型输出里出现 HTML 也只会当文字显示。
 */

import { h } from './ui.js';

function inline(text) {
  const nodes = [];
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\n]+\*)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith('**')) nodes.push(h('strong', {}, token.slice(2, -2)));
    else if (token.startsWith('`')) nodes.push(h('code', {}, token.slice(1, -1)));
    else nodes.push(h('em', {}, token.slice(1, -1)));
    last = m.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function paragraph(lines) {
  const nodes = [];
  lines.forEach((line, i) => {
    if (i > 0) nodes.push(h('br'));
    nodes.push(...inline(line));
  });
  return h('p.md-p', {}, nodes);
}

// 列表符号支持中文教材和模型常见的写法：
//   - xxx / •xxx / ●xxx / ·xxx
//   1. xxx / 1、xxx / （1）xxx / ①xxx
// 「1.5」这类小数不会被当成列表。
const BULLET_RE = /^\s*(?:[-*]\s+|[•●▪·]\s*)/;
const ORDERED_RE = /^\s*(?:\d{1,2}(?:[.)．](?!\d)|、)|[（(]\d{1,2}[）)]|[①-⑳])\s*/;

function startsList(line) {
  return BULLET_RE.test(line) || ORDERED_RE.test(line);
}

const NUMBER_MARKER_SRC = '(?:\\d{1,2}(?:[.)．](?!\\d)|、)|[（(]\\d{1,2}[）)]|[①-⑳])';
const NUMBER_MARKER_RE = new RegExp(NUMBER_MARKER_SRC, 'g');
const HEAD_START_PUNCT = /[\s。；;，,：:！!？?、]/;

function splitNumberedLine(line) {
  const raw = [...line.matchAll(NUMBER_MARKER_RE)].filter((m) => {
    // 「2023、」里的「23、」不算编号
    const before = m.index > 0 ? line[m.index - 1] : '';
    return !(/^\d/.test(m[0]) && /[\dA-Za-z]/.test(before));
  });
  if (raw.length < 2) return line;
  const first = raw[0];
  const lead = first.index > 0 ? line[first.index - 1] : '';
  // 只有整行确实以编号开头，或在标点/空格之后接编号，才当成并列的分点。
  // 这样「如图（2）所示」不会被拆开。
  if (first.index > 0 && !HEAD_START_PUNCT.test(lead)) return line;
  let out = line;
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    const at = raw[i].index;
    if (at > 0) out = `${out.slice(0, at)}\n${out.slice(at)}`;
  }
  return out;
}

function splitInlineNumbering(raw) {
  let inFence = false;
  return raw.split('\n').map((line) => {
    if (/^```/.test(line)) {
      inFence = !inFence;
      return line;
    }
    return inFence ? line : splitNumberedLine(line);
  }).join('\n');
}

export function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const raw = splitInlineNumbering(String(text || '').replace(/\r\n?/g, '\n').trim());
  if (!raw) return frag;

  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    if (/^```/.test(line)) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i += 1; }
      i += 1;
      frag.appendChild(h('pre.md-pre', {}, [h('code', {}, body.join('\n'))]));
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(4, heading[1].length + 2);
      frag.appendChild(h(`h${level}.md-h`, {}, inline(heading[2])));
      i += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      frag.appendChild(h('hr.md-hr'));
      i += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        body.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      frag.appendChild(h('blockquote.md-quote', {}, [paragraph(body)]));
      continue;
    }

    if (BULLET_RE.test(line)) {
      const list = h('ul.md-list');
      while (i < lines.length && BULLET_RE.test(lines[i])) {
        const itemLines = [lines[i].replace(BULLET_RE, '')];
        i += 1;
        // 列表项中间的自然换行，只有在下一行不是新条目/标题/引用时并进来
        while (i < lines.length && lines[i].trim()
          && !startsList(lines[i])
          && !/^```|^#{1,4}\s|^>\s?/.test(lines[i])) {
          itemLines.push(lines[i].trim());
          i += 1;
        }
        list.appendChild(h('li', {}, [...paragraph(itemLines).childNodes]));
      }
      frag.appendChild(list);
      continue;
    }

    if (ORDERED_RE.test(line)) {
      const list = h('ol.md-list');
      while (i < lines.length && ORDERED_RE.test(lines[i])) {
        const itemLines = [lines[i].replace(ORDERED_RE, '')];
        i += 1;
        while (i < lines.length && lines[i].trim()
          && !startsList(lines[i])
          && !/^```|^#{1,4}\s|^>\s?/.test(lines[i])) {
          itemLines.push(lines[i].trim());
          i += 1;
        }
        list.appendChild(h('li', {}, [...paragraph(itemLines).childNodes]));
      }
      frag.appendChild(list);
      continue;
    }

    const body = [line];
    i += 1;
    while (i < lines.length && lines[i].trim()
      && !/^```|^#{1,4}\s|^>\s?/.test(lines[i])
      && !startsList(lines[i])) {
      body.push(lines[i]);
      i += 1;
    }
    frag.appendChild(paragraph(body));
  }

  return frag;
}
