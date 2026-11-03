'use strict';

/**
 * 教材精读
 * ---------------------------------------------------------------
 * 浏览器用 PDF.js 把 PDF 提取成「一页一段文字 + PDF 书签」，
 * 服务端在这里做三件事：
 *
 *   1. 目录 → 大框架（章）/ 小框架（节），并把页码区间算准；
 *   2. 每一节按需生成讲义（远程模型 / 本机模型 / 本地规则整理）；
 *   3. 教材内问答，只把这一节相关的原文交给模型。
 *
 * 和对话模块一样，任何外部模型失败都回退到本地整理，并如实标注来源。
 * 页数、页码、二维码等内容绝不假装存在：扫描版 PDF 提取不到文字会直接报错。
 */

const db = require('./db');
const models = require('./models');
const { complete, parseJson, providerLabel } = require('./llm');
const ocr = require('./ocr');
const { parseToc } = require('./ocr-toc');
const glossary = require('./glossary');

const MAX_PAGES = 3000;
const MAX_PAGE_TEXT = 120000;
const MAX_TOTAL_TEXT = 15 * 1000 * 1000;
const MAX_SECTION_LLM_CHARS = 18000;
const MAX_CHAT_EXCERPT_CHARS = 7000;
const MAX_CHAT_MESSAGES = 80;

const OCR_FRONT_INITIAL = 10;
const OCR_FRONT_MAX = 24;
const OCR_BATCH_PAGES = 6;
const OCR_SECTION_MAX_PAGES = 40;
const OCR_WIDTH = 1800;

const DEMO_RULES = [
  {
    // 标题只认具体电路概念，不认裸「电路 / 电压 / 电流」，
    // 否则整本《电路分析》的每一节都会弹出同一个演示。
    id: 'circuit-ohm',
    title: /(欧姆定律|欧姆|串联|并联|基尔霍夫|戴维南|诺顿|电阻电路|电路分析|节点电压|网孔电流|交流电路|直流电路|ohm'?s law|series circuit|parallel circuit|kirchhoff|thevenin|norton)/i,
    body: [
      /(欧姆定律|ohm'?s law)/i,
      /(串联电路|并联电路|串联|并联|series circuit|parallel circuit)/i,
      /(基尔霍夫|kirchhoff|节点电压|网孔电流)/i,
      /(总电阻|等效电阻|分压|分流)/i,
    ],
  },
  {
    // 「计算机网络」「网络」这种书名级词不能当命中词
    id: 'packet-switching',
    title: /(分组交换|电路交换|报文交换|数据报|路由器|路由选择|网络层|存储转发|packet[- ]switching|circuit[- ]switching|datagram|router|routing|network layer)/i,
    body: [
      /(分组交换|packet[- ]switching)/i,
      /(电路交换|circuit[- ]switching)/i,
      /(报文交换|数据报|datagram)/i,
      /(存储转发|store[- ]and[- ]forward)/i,
      /(路由器|路由选择|router|routing)/i,
    ],
  },
  {
    // SYN / ACK 必须整词匹配，否则 packet 里的 "ack" 也会被当成 ACK
    id: 'tcp-handshake',
    title: /(\bTCP\b|三次握手|传输层|可靠传输|连接建立|拥塞控制|滑动窗口|three-way handshake|transport layer|reliable transmission)/i,
    body: [
      /(三次握手|three-way handshake)/i,
      /\bSYN\b/i,
      /\bACK\b/i,
      /(传输层|transport layer)/i,
      /(可靠传输|reliable transmission|拥塞控制|滑动窗口)/i,
    ],
  },
];

// ================================================================ 文本工具

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[\u2000-\u200b]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function oneLine(text, max = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function cleanHeading(text) {
  return String(text || '')
    .replace(/[.·…．•]{2,}\s*\d{0,4}\s*$/, '')
    .replace(/\s+\d{1,4}\s*$/, '')
    .replace(/^[\s·•\-—]+/, '')
    .replace(/[\s:：.．、\-]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** 把 PDF 里一行一行的文字合并成更像段落的块 */
function toParagraphs(text) {
  const lines = normalizeText(text)
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !/^第?\s*\d{1,4}\s*页?$/.test(s));
  const paras = [];
  let buf = '';
  for (const line of lines) {
    if (!buf) { buf = line; continue; }
    const prevEnds = /[。！？；：.!?;:]$/.test(buf);
    const isHeading = /^(第[一二三四五六七八九十百千零〇两\d]+[章节讲篇部]|\d+(?:\.\d+){1,3}\s|例\s*\d|图\s*\d|表\s*\d)/.test(line);
    const isShortHeading = line.length <= 22 && !/[，。；：,.;:]$/.test(line);
    if (!prevEnds && !isHeading && !isShortHeading && buf.length + line.length < 700) {
      // 中文换行通常没有空格；英文单词之间补一个空格
      buf += /[A-Za-z0-9]$/.test(buf) && /^[A-Za-z0-9]/.test(line) ? ` ${line}` : line;
    } else {
      paras.push(buf);
      buf = line;
    }
  }
  if (buf) paras.push(buf);
  return paras.filter((p) => p.replace(/\s/g, '').length >= 8);
}

function sentencesOf(text) {
  return normalizeText(text)
    .replace(/\n+/g, ' ')
    .split(/(?<=[。！？；!?;])/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 220);
}

function splitSentences(text) {
  return sentencesOf(text).map((s) => oneLine(s, 150));
}

function parseNumberedLevel(marker) {
  if (/^第/.test(marker)) return 0;
  if (/^chapter/i.test(marker)) return 0;
  if (/^附录/.test(marker)) return 0;
  const parts = String(marker).replace(/[^\d.]/g, '').split('.').filter(Boolean);
  return Math.max(0, Math.min(3, parts.length - 1));
}

// ================================================================ 目录解析

function parseTocLine(line, pageCount) {
  const raw = String(line || '').replace(/\s+/g, ' ').trim();
  if (!raw || raw.length > 140) return null;
  if (/^(目\s*录|contents)$/i.test(raw)) return null;

  // 行尾页码：允许点线、空格或全角空白
  const m = /^(.*?)(?:[.·…．•]{2,}|\s{2,}|\s)\s*(\d{1,4})\s*$/.exec(raw);
  if (!m) return null;
  const head = m[1].replace(/[.·…．•]{2,}/g, ' ').trim();
  let page = Number(m[2]);
  if (!Number.isFinite(page) || page < 1) return null;
  if (page > pageCount + 40) return null;

  let marker = null;
  let title = '';
  let level = 0;

  const chapter = /^(第[一二三四五六七八九十百千零〇两\d]+[章篇部编])\s*[、.．:：]?\s*(.+)$/.exec(head);
  const appendix = /^(附录\s*[A-Za-z\d]*)\s*[、.．:：]?\s*(.*)$/.exec(head);
  const chapterEn = /^(Chapter\s+\d+)\s*[.:：\-]?\s*(.+)$/i.exec(head);
  const numbered = /^(\d{1,2}(?:\.\d{1,3}){0,3})\s*[、.．:：]?\s*(.+)$/.exec(head);

  if (chapter) {
    marker = chapter[1];
    title = `${chapter[1]} ${chapter[2]}`;
    level = 0;
  } else if (appendix) {
    marker = appendix[1];
    title = `${appendix[1]} ${appendix[2] || ''}`.trim();
    level = 0;
  } else if (chapterEn) {
    marker = chapterEn[1];
    title = `${chapterEn[1]} ${chapterEn[2]}`;
    level = 0;
  } else if (numbered) {
    // 纯数字编号通常是正文里的公式/题号，标题要像标题：有中文、不是一句话
    const rest = numbered[2].trim();
    if (!/[\u4e00-\u9fffA-Za-z]/.test(rest)) return null;
    if (/[。！？；]/.test(rest)) return null;
    marker = numbered[1];
    title = `${numbered[1]} ${rest}`;
    level = parseNumberedLevel(marker);
  } else {
    return null;
  }

  title = cleanHeading(title);
  if (!title || title.length < 2) return null;
  if (/[。！？]$/.test(title)) return null;
  return { title, pageStart: page, level, marker };
}

function parseTocPages(pages, pageCount) {
  const front = pages.slice(0, Math.min(32, pages.length));
  const pageMatches = [];
  for (const p of front) {
    const lines = normalizeText(p.text).split('\n');
    const matches = [];
    for (const line of lines) {
      const parsed = parseTocLine(line, pageCount);
      if (parsed) matches.push({ ...parsed, order: matches.length });
    }
    if (matches.length) {
      const hasTocWord = /目\s*录|contents/i.test(p.text);
      pageMatches.push({ page: p.page, matches, score: matches.length + (hasTocWord ? 4 : 0) });
    }
  }
  if (!pageMatches.length) return [];

  const good = pageMatches.filter((x) => x.score >= 3 || x.matches.length >= 3);
  if (!good.length) return [];

  let all = good.flatMap((x) => x.matches.map((m) => ({ ...m, tocPage: x.page })));
  if (all.length < 3) return [];

  // 目录印刷页码 → PDF 页序的简单偏移修正：只处理「尾部超出少许」的情况
  const maxPrinted = Math.max(...all.map((x) => x.pageStart));
  if (maxPrinted > pageCount) {
    const offset = maxPrinted - pageCount;
    if (offset <= 40) {
      all = all.map((x) => ({ ...x, pageStart: Math.max(1, x.pageStart - offset) }));
    } else {
      all = all.filter((x) => x.pageStart <= pageCount);
    }
  }

  // 去重并稳定排序
  const seen = new Set();
  all = all
    .filter((x) => {
      const key = `${x.title}|${x.pageStart}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.pageStart - b.pageStart || a.order - b.order);

  // 有些目录页会把正文里的「1.1 xxx 12」也认出来；数量异常多时保守丢弃
  if (all.length > 400) all = all.slice(0, 400);
  return all.map((x) => ({ title: x.title, pageStart: x.pageStart, level: x.level }));
}

function scanHeadings(pages, pageCount) {
  const out = [];
  for (const p of pages) {
    if (p.page > 900) break;
    const lines = normalizeText(p.text).split('\n');
    for (const line of lines) {
      const s = line.trim();
      if (!s || s.length > 60) continue;
      if (/[。！？；]$/.test(s)) continue;
      let level = null;
      if (/^第[一二三四五六七八九十百千零〇两\d]+[章篇部]/.test(s)) level = 0;
      else if (/^(Chapter\s+\d+)/i.test(s)) level = 0;
      else if (/^附录\s*[A-Za-z\d]/i.test(s)) level = 0;
      else if (/^\d{1,2}(\.\d{1,3}){1,2}\s+\S/.test(s)) {
        const marker = s.match(/^\d{1,2}(?:\.\d{1,3}){1,2}/)[0];
        level = parseNumberedLevel(marker);
      }
      if (level === null) continue;
      if (/^(第[一二三四五六七八九十百千零〇两\d]+[章篇部])$/.test(s) && s.length < 4) continue;
      out.push({ title: cleanHeading(s), pageStart: p.page, level });
    }
  }
  const seen = new Set();
  return out.filter((x) => {
    const key = `${x.title}|${x.pageStart}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ================================================================ 框架整理

function titleDemoId(title) {
  const rule = DEMO_RULES.find((item) => item.title.test(String(title || '')));
  return rule ? rule.id : null;
}

function detectDemos(title, text) {
  const heading = String(title || '');
  // 标题命中优先，并且最多只配一个：同一节堆几个泛化动画，
  // 反而会让人误以为每个概念都有对应演示。
  const titleHit = titleDemoId(heading);
  if (titleHit) return [titleHit];

  // 标题没提具体概念时才看正文，而且只扫这一节的开头。
  // 目录页/页眉常常把整章关键词带进每一页，正文匹配必须更严格：
  // 至少命中 3 个不同的强信号，才认为这一节真的在讲这个机制。
  const hay = normalizeText(text).slice(0, 1600);
  const scored = DEMO_RULES
    .map((rule, index) => ({
      rule,
      index,
      score: rule.body.reduce((n, re) => n + (re.test(hay) ? 1 : 0), 0),
    }))
    .filter((item) => item.score >= 3)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.length ? [scored[0].rule.id] : [];
}

function sectionTextFor(pages, pageStart, pageEnd) {
  return pages
    .filter((p) => p.page >= pageStart && p.page <= pageEnd)
    .map((p) => p.text)
    .join('\n');
}

/**
 * 把「目录条目」整理成两层：章 → 节。
 * 目录超过两层时，更深的标题保留为 section.subsections，供阅读时提示，
 * 但导航只显示两层，避免一本书出现几百个同级入口。
 */
function chaptersFromItems(items, pageCount, source) {
  if (!Array.isArray(items) || items.length < 2) return [];

  const cleaned = items
    .map((it, idx) => ({
      title: cleanHeading(it.title),
      pageStart: Math.round(Number(it.pageStart || it.page) || 0),
      level: Number.isFinite(Number(it.level)) ? Math.max(0, Math.min(6, Number(it.level))) : 0,
      order: idx,
    }))
    .filter((it) => it.title && it.pageStart >= 1 && it.pageStart <= pageCount)
    .sort((a, b) => a.pageStart - b.pageStart || a.order - b.order);

  if (cleaned.length < 2) return [];

  // 有些 PDF 书签是平的，全在同一层。标题里其实带着层级，按标题补回来，
  // 否则「第1章」和「1.1」会被当成并列的两章。
  if (new Set(cleaned.map((x) => x.level)).size === 1) {
    const inferred = cleaned.map((it) => {
      if (/^第[一二三四五六七八九十百千零〇两\d]+[章篇部]|^chapter\b|^附录/i.test(it.title)) return 0;
      if (/^第[一二三四五六七八九十百千零〇两\d]+节/.test(it.title)) return 1;
      const m = /^(\d{1,2}(?:\.\d{1,3}){1,3})\s/.exec(it.title);
      if (m) return m[1].split('.').length - 1;
      return null;
    });
    if (inferred.filter((x) => x !== null).length >= 2) {
      cleaned.forEach((x, i) => { x.level = inferred[i] === null ? 0 : inferred[i]; });
    }
  }

  const levels = [...new Set(cleaned.map((x) => x.level))].sort((a, b) => a - b);
  let chapterLevel = levels[0];

  // 「第一篇 / Part」这类顶层通常是卷，不是章：如果下一层全是“第X章”，就下沉一层
  const topItems = cleaned.filter((x) => x.level === chapterLevel);
  if (
    levels.length > 1
    && topItems.length <= 4
    && topItems.every((x) => /第[一二三四五六七八九十百千零〇两\d]+[篇部]|\bpart\b/i.test(x.title))
    && cleaned.some((x) => x.level === levels[1] && /第.+章|chapter/i.test(x.title))
  ) {
    chapterLevel = levels[1];
  }

  const deeper = levels.filter((l) => l > chapterLevel);
  const sectionLevel = deeper.length ? deeper[0] : null;

  const chapters = [];
  let chapter = null;
  let section = null;

  const ensureChapter = (item) => {
    if (chapter) return chapter;
    chapter = {
      title: item ? item.title : '未命名章节',
      pageStart: item ? item.pageStart : 1,
      pageEnd: pageCount,
      sections: [],
      _items: [],
      _order: item ? item.order : 0,
    };
    chapters.push(chapter);
    return chapter;
  };

  for (const item of cleaned) {
    if (item.level < chapterLevel) continue;
    if (item.level === chapterLevel) {
      chapter = {
        title: item.title,
        pageStart: item.pageStart,
        pageEnd: pageCount,
        sections: [],
        _items: [item],
        _order: item.order,
      };
      chapters.push(chapter);
      section = null;
      continue;
    }
    if (!chapter) chapter = ensureChapter(null);
    chapter._items.push(item);

    if (sectionLevel === null) {
      section = {
        title: item.title,
        pageStart: item.pageStart,
        pageEnd: pageCount,
        subsections: [],
        _order: item.order,
      };
      chapter.sections.push(section);
      continue;
    }

    if (item.level === sectionLevel || !section) {
      section = {
        title: item.title,
        pageStart: item.pageStart,
        pageEnd: pageCount,
        subsections: [],
        _order: item.order,
      };
      chapter.sections.push(section);
    } else if (section.subsections.length < 20) {
      section.subsections.push({ title: item.title, page: item.pageStart });
    }
  }

  // 页码区间：章的终点是下一章起点前；节的终点是下一节/下一章起点前
  for (let i = 0; i < chapters.length; i += 1) {
    const c = chapters[i];
    const next = chapters[i + 1];
    if (next && next.pageStart > c.pageStart) c.pageEnd = next.pageStart - 1;
    else c.pageEnd = pageCount;

    c.sections.sort((a, b) => a.pageStart - b.pageStart || a._order - b._order);
    for (let j = 0; j < c.sections.length; j += 1) {
      const s = c.sections[j];
      const nextS = c.sections[j + 1];
      if (nextS && nextS.pageStart > s.pageStart) s.pageEnd = nextS.pageStart - 1;
      else s.pageEnd = c.pageEnd;
      if (s.pageEnd < s.pageStart) s.pageEnd = s.pageStart;
    }
    if (!c.sections.length) {
      c.sections.push({
        title: '全章',
        pageStart: c.pageStart,
        pageEnd: c.pageEnd,
        subsections: [],
        wholeChapter: true,
      });
    }
    if (c.pageEnd < c.pageStart) c.pageEnd = c.pageStart;
  }

  // 去掉明显的前置噪音
  const filtered = chapters.filter((c) => !/^(目\s*录|contents)$/i.test(c.title));
  return finalizeChapters(filtered.length ? filtered : chapters, pageCount, source);
}

// 标题命中的动画是这一节明确在讲的概念，允许同一章里多节各自保留；
// 只靠正文关键词命中的动画比较弱，同一章只留第一处，避免一整章每节都挂同一个演示。
function assignChapterDemos(chapter, pages) {
  const usedBodyDemos = new Set();
  for (const section of chapter.sections || []) {
    if (!pages) { section.demos = []; continue; }
    // 只有「全章」这一节才借助章标题；普通小节按自己的标题和正文匹配，
    // 避免「网络性能指标」这种小节因为所在章叫「计算机网络」也弹出分组交换动画
    const demoTitle = section.wholeChapter ? `${chapter.title} ${section.title}` : section.title;
    const titleId = titleDemoId(demoTitle);
    const demos = detectDemos(demoTitle, sectionTextFor(pages, section.pageStart, section.pageEnd));
    section.demos = demos.filter((id) => id === titleId || !usedBodyDemos.has(id));
    for (const id of section.demos) {
      if (id !== titleId) usedBodyDemos.add(id);
    }
  }
}

function finalizeChapters(chapters, pageCount, source, pages) {
  const out = [];
  let chIndex = 0;
  for (const c of chapters.slice(0, 80)) {
    const start = Math.max(1, Math.min(pageCount, Number(c.pageStart) || 1));
    const end = Math.max(start, Math.min(pageCount, Number(c.pageEnd) || pageCount));
    const chapter = {
      id: `ch${chIndex + 1}`,
      title: cleanHeading(c.title) || `第 ${chIndex + 1} 章`,
      pageStart: start,
      pageEnd: end,
      sections: [],
    };
    let sIndex = 0;
    for (const s of (c.sections || []).slice(0, 80)) {
      const sStart = Math.max(start, Math.min(end, Number(s.pageStart) || start));
      const sEnd = Math.max(sStart, Math.min(end, Number(s.pageEnd) || end));
      const section = {
        id: `${chapter.id}-s${sIndex + 1}`,
        title: cleanHeading(s.title) || `第 ${sIndex + 1} 节`,
        pageStart: sStart,
        pageEnd: sEnd,
        wholeChapter: Boolean(s.wholeChapter),
        subsections: Array.isArray(s.subsections)
          ? s.subsections.slice(0, 20).map((x) => ({
              title: cleanHeading(x.title),
              page: Math.max(1, Math.min(pageCount, Number(x.page) || sStart)),
            })).filter((x) => x.title)
          : [],
        demos: [],
        lesson: null,
        done: false,
        doneAt: null,
      };
      chapter.sections.push(section);
      sIndex += 1;
    }
    if (!chapter.sections.length) {
      chapter.sections.push({
        id: `${chapter.id}-s1`,
        title: '全章',
        pageStart: start,
        pageEnd: end,
        wholeChapter: true,
        subsections: [],
        demos: [],
        lesson: null,
        done: false,
        doneAt: null,
      });
    }
    assignChapterDemos(chapter, pages);
    out.push(chapter);
    chIndex += 1;
  }
  return out;
}

const DEMO_POLICY_VERSION = 2;

// 旧版本按整本书粗略匹配，把同一个动画挂到了几乎每一节。
// 这里用现在的规则重算一遍已经导入的教材，不用用户重新导入。
function refreshDemos(book, pages) {
  if (!Array.isArray(pages) || !pages.length) {
    const demoCount = (book.chapters || []).reduce(
      (n, c) => n + (c.sections || []).filter((s) => s.demos && s.demos.length).length, 0
    );
    return { changed: false, demoCount };
  }
  let changed = false;
  let demoCount = 0;
  for (const chapter of book.chapters || []) {
    const before = JSON.stringify((chapter.sections || []).map((s) => s.demos || []));
    assignChapterDemos(chapter, pages);
    const after = JSON.stringify((chapter.sections || []).map((s) => s.demos || []));
    if (before !== after) changed = true;
    demoCount += (chapter.sections || []).filter((s) => s.demos && s.demos.length).length;
  }
  if (book.guide && typeof book.guide === 'object') {
    const note = demoCount
      ? `其中 ${demoCount} 节附有可选动画，放在讲义之后，只辅助理解个别概念；主要学习材料仍是讲义和教材原文。`
      : '';
    if (book.guide.demoNote !== note) {
      book.guide.demoNote = note;
      changed = true;
    }
  }
  return { changed, demoCount };
}

function chunkChapters(pageCount) {
  const chapters = [];
  const chapterSize = 30;
  const sectionSize = 10;
  let ch = 0;
  for (let start = 1; start <= pageCount; start += chapterSize) {
    ch += 1;
    const end = Math.min(pageCount, start + chapterSize - 1);
    const chapter = {
      id: `ch${ch}`,
      title: `第 ${ch} 部分`,
      pageStart: start,
      pageEnd: end,
      sections: [],
    };
    let sidx = 0;
    for (let s = start; s <= end; s += sectionSize) {
      sidx += 1;
      const sEnd = Math.min(end, s + sectionSize - 1);
      chapter.sections.push({
        id: `${chapter.id}-s${sidx}`,
        title: `第 ${s}–${sEnd} 页`,
        pageStart: s,
        pageEnd: sEnd,
        wholeChapter: false,
        subsections: [],
        demos: [],
        lesson: null,
        done: false,
        doneAt: null,
      });
    }
    chapters.push(chapter);
  }
  return chapters;
}

function buildStructure({ pages, pageCount, outlineItems }) {
  let chapters = [];
  let source = 'chunks';
  let note = '';

  if (Array.isArray(outlineItems) && outlineItems.length >= 2) {
    chapters = chaptersFromItems(outlineItems, pageCount, 'bookmarks');
    if (chapters.length >= 1) {
      source = 'bookmarks';
      note = '章节来自 PDF 自带书签，页码按 PDF 页序。';
    }
  }

  if (!chapters.length) {
    const tocItems = parseTocPages(pages, pageCount);
    if (tocItems.length >= 3) {
      chapters = chaptersFromItems(tocItems, pageCount, 'toc');
      if (chapters.length >= 1) {
        source = 'toc';
        note = '章节来自目录页识别。个别页码可能和书上印刷页码差几页。';
      }
    }
  }

  if (!chapters.length) {
    const headings = scanHeadings(pages, pageCount);
    if (headings.length >= 3) {
      chapters = chaptersFromItems(headings, pageCount, 'headings');
      if (chapters.length >= 1) {
        source = 'headings';
        note = '没有认出目录页，章节是按正文标题整理的。';
      }
    }
  }

  if (!chapters.length) {
    chapters = chunkChapters(pageCount);
    source = 'chunks';
    note = '没有识别到可用目录，先按页范围分段。给 PDF 加上书签后重新导入，目录会更准确。';
  }

  // 为章节内的节补上演示匹配（chunk 章节在最终确认时统一再算一次）
  return { chapters: finalizeChapters(chapters, pageCount, source, pages), source, note };
}

// ================================================================ 讲义

function extractDefinitions(text) {
  const out = [];
  const re = /([\u4e00-\u9fa5A-Za-z0-9（）()·\-]{2,24})(?:是指|指的是|称为|叫做|定义为|是一种|是)([^。！？；]{8,160}[。；])/g;
  let m;
  while ((m = re.exec(text)) && out.length < 8) {
    const term = m[1].trim();
    if (term.length < 2 || /^(它|这|那|我们|你们|他们|其中|因此|所以|但是|如果|由于)/.test(term)) continue;
    out.push({ term, sentence: oneLine(`${term}${text.slice(m.index + term.length, m.index + term.length + 1)}${m[2]}`, 180) });
  }
  return out;
}

function pickKeySentences(text, limit = 6) {
  const sents = sentencesOf(text);
  const scored = sents.map((s, i) => {
    let score = 0;
    if (/(是指|指的是|称为|定义|定理|定律|公式|结论|因此|所以|表示|等于|性质|特点|分类|作用)/.test(s)) score += 3;
    if (/(注意|切忌|不能|必须|区别|区分|容易)/.test(s)) score += 1;
    if (i < 4) score += 1;
    if (/\d/.test(s)) score += 0.5;
    if (s.length > 160) score -= 0.5;
    return { s: oneLine(s, 170), score, i };
  });
  const picked = [];
  const seen = new Set();
  for (const item of scored.sort((a, b) => b.score - a.score || a.i - b.i)) {
    const key = item.s.slice(0, 14);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(item.s);
    if (picked.length >= limit) break;
  }
  return picked.sort((a, b) => {
    const ia = sents.findIndex((x) => x.includes(a.slice(0, 10)));
    const ib = sents.findIndex((x) => x.includes(b.slice(0, 10)));
    return ia - ib;
  });
}

function pickPitfalls(text) {
  return sentencesOf(text)
    .filter((s) => /(注意|切忌|不能|必须|区分|区别|容易|误区|特别要)/.test(s))
    .slice(0, 3)
    .map((s) => oneLine(s, 150));
}

function pickExample(paragraphs) {
  return paragraphs.find((p) => /^(例|例题|例如|比如)|例如|比如/.test(p) && p.length >= 20) || null;
}

function localLesson({ bookTitle, chapterTitle, section, text, textInfo = null }) {
  const clean = normalizeText(text);
  const charCount = clean.replace(/\s/g, '').length;
  if (charCount < 12 || ocr.isLikelyGarbled(clean)) {
    const unreadable = textInfo && Array.isArray(textInfo.unreadablePages) && textInfo.unreadablePages.length
      ? `这一节有 ${textInfo.unreadablePages.length} 页没有可靠文字。`
      : '';
    const ocrHint = textInfo && textInfo.source === 'none'
      ? '文字层读不出可读内容，本机 OCR 也没有得到足够文字。'
      : '这一节提取到的可用文字太少。';
    return {
      provider: 'local',
      model: null,
      generatedAt: db.nowIso(),
      overview: `${ocrHint}${unreadable}这可能是扫描页、整页公式/图片，或者页码区间不准确。请对照「PDF 原页」阅读，不要根据乱码文字硬凑讲解。`,
      keyPoints: [],
      blocks: [],
      example: null,
      pitfalls: [],
      summary: '',
      questions: [],
      warning: '没有足够可靠的原文，已跳过模型和本地整理，避免把乱码当成教材内容。',
    };
  }

  const short = charCount < 120;
  const paragraphs = toParagraphs(clean);
  const defs = extractDefinitions(clean);
  const keys = pickKeySentences(clean, 6);
  const pitfalls = pickPitfalls(clean);
  const example = pickExample(paragraphs);
  const displayTitle = section.wholeChapter ? chapterTitle : section.title;
  const firstPara = paragraphs[0] ? oneLine(paragraphs[0], 220) : '';
  const subsectionTitles = (section.subsections || []).slice(0, 6).map((x) => x.title);

  const overview = [
    `这一节（${displayTitle}，第 ${section.pageStart}–${section.pageEnd} 页）共提取到约 ${clean.replace(/\s/g, '').length} 字。`,
    firstPara ? `原文开头在讲：${firstPara}` : '',
    subsectionTitles.length ? `可以按这几个小标题读：${subsectionTitles.join('；')}。` : '',
  ].filter(Boolean).join('\n\n');

  const block1 = paragraphs.slice(0, 2).map((p) => oneLine(p, 260)).join('\n\n');
  const block2 = defs.slice(0, 4).map((d) => `- ${d.sentence}`).join('\n') || keys.slice(0, 3).map((k) => `- ${k}`).join('\n');
  const block3 = keys.slice(0, 4).map((k) => `- ${k}`).join('\n');

  const questions = [];
  for (const d of defs.slice(0, 2)) {
    questions.push(`用自己的话解释「${d.term}」，并举一个例子。`);
  }
  questions.push('这一节的核心结论是什么？如果把条件改掉，结论还成立吗？');

  return {
    provider: 'local',
    model: null,
    generatedAt: db.nowIso(),
    overview,
    keyPoints: keys,
    blocks: [
      { heading: '这一节在讲什么', body: block1 || overview },
      { heading: '概念与结论', body: block2 },
      { heading: '顺着原文再读一遍', body: block3 },
    ].filter((b) => b.body),
    example: example ? oneLine(example, 400) : null,
    pitfalls,
    summary: keys[0] || firstPara || '先读原文，再把这一节的核心概念用自己的话复述一遍。',
    questions: questions.slice(0, 3),
    warning: short
      ? '这一节提取到的文字偏少（可能以图、公式或留白为主），讲义只能做简单整理。建议对照「教材原文 / PDF 原页」阅读。'
      : '这份讲义由本地规则从原文抽取整理，不是模型生成的讲解。想要更连贯的解释，可以在设置里换成本机或远程模型。',
  };
}

function validateLesson(raw, provider, model) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const arr = (v, n, len) => (Array.isArray(v) ? v.map((x) => str(x, len)).filter(Boolean).slice(0, n) : []);
  const blocks = Array.isArray(raw.blocks)
    ? raw.blocks.slice(0, 8).map((b) => ({
        heading: str(b && b.heading, 80),
        body: str(b && b.body, 6000),
      })).filter((b) => b.body)
    : [];

  const terms = Array.isArray(raw.terms)
    ? raw.terms.slice(0, 6).map((t) => ({
        term: str(t && t.term, 40),
        plain: str(t && t.plain, 600),
        example: str(t && t.example, 600),
      })).filter((t) => t.term && t.plain)
    : [];

  const lesson = {
    provider,
    model: model || null,
    generatedAt: db.nowIso(),
    overview: str(raw.overview, 2000),
    keyPoints: arr(raw.keyPoints, 8, 500),
    blocks,
    example: raw.example ? str(raw.example, 3000) : null,
    pitfalls: arr(raw.pitfalls, 5, 500),
    summary: str(raw.summary, 1200),
    questions: arr(raw.questions, 5, 400),
    terms,
    warning: null,
  };
  if (!lesson.overview && !lesson.blocks.length && !lesson.keyPoints.length) return null;
  if (!lesson.blocks.length && lesson.keyPoints.length) {
    lesson.blocks.push({ heading: '核心要点', body: lesson.keyPoints.map((k) => `- ${k}`).join('\n') });
  }
  return lesson;
}

const LESSON_SYSTEM = `你是一位大学教材精读助教。你的任务是把一节教材内容讲清楚，帮助学生真正理解，而不是复述目录或堆砌套话。
规则：
1. 只依据提供的教材原文讲解。原文不足以支撑时，明确写「这一节提取的文字里没有展开」，不要编造公式、页码、作者观点。
2. 面向大学生，用中文讲。先给整体思路，再解释概念之间的因果关系，最后指出易错点。
3. 公式用可读的纯文本表示；不要输出 LaTeX 专用命令。不要输出 HTML。
4. 讲义以教材文字为唯一主线。页面上的动画只是可选辅助，不要用动画替代讲解，也不要把「先看动画」写成学习步骤。
5. 输出一个 JSON 对象，不要 markdown 代码块，不要额外解释。结构：
{
  "overview": "2-4 句，说明这一节在解决什么问题、和前后内容的关系",
  "keyPoints": ["4-6 条真正重要的结论或概念"],
  "blocks": [{"heading": "小标题", "body": "用 markdown 写的讲解，2-4 段；可用 - 列表"}],
  "example": "一个来自原文或贴合原文的简短例子；没有就写空字符串",
  "pitfalls": ["容易混淆或算错的地方"],
  "summary": "一句话总结",
  "questions": ["2-3 个自测问题"],
  "terms": [{"term": "这一节里生涩的专业词汇", "plain": "用大白话解释它是什么、在这里起什么作用", "example": "一个日常生活里的类比"}]
}`;

async function generateLesson({ settings, book, chapter, section, text, textInfo = null }) {
  const excerpt = normalizeText(text).slice(0, MAX_SECTION_LLM_CHARS);
  const local = localLesson({
    bookTitle: book.title,
    chapterTitle: chapter.title,
    section,
    text,
    textInfo,
  });

  if (!isUsableText(text)) return local;
  if (settings.aiProvider === 'mock') return local;

  const ocrNote = textInfo && (textInfo.source === 'ocr' || textInfo.source === 'mixed')
    ? '注意：原文由本机 OCR 识别，公式、符号和上下标可能有误。不要试图补全看不清的公式；拿不准时明确说明。'
    : '';

  const prompt = [
    `教材：《${book.title}》`,
    `章节：${chapter.title} / ${section.title}`,
    `页码范围：第 ${section.pageStart}–${section.pageEnd} 页`,
    ocrNote,
    '',
    '教材原文（由 PDF 提取，可能有断行、页眉和公式失真）：',
    excerpt,
    '',
    '请按规定的 JSON 结构输出这一节的精读讲义。terms 只挑 2-4 个这一节里真正难懂的专业词，用生活里的例子解释。',
  ].filter(Boolean).join('\n');

  try {
    const out = await complete({
      settings,
      system: LESSON_SYSTEM,
      user: prompt,
      temperature: 0.3,
      maxTokens: 3000,
      timeoutMs: settings.aiProvider === 'ollama' ? 150000 : 90000,
    });
    const parsed = parseJson(out.text);
    const lesson = validateLesson(parsed, out.provider, out.model);
    if (!lesson) throw new Error('模型返回的内容不是可用的讲义结构');
    return lesson;
  } catch (err) {
    return {
      ...local,
      warning: `模型这次没有生成讲义，已改用本地原文整理。原因：${err.message}`,
    };
  }
}

// ================================================================ 教材问答

function keywordsOf(text) {
  const t = String(text || '');
  const words = new Set();
  for (const w of t.match(/[A-Za-z][A-Za-z0-9+\-]{1,24}/g) || []) words.add(w.toLowerCase());
  for (const w of t.match(/[\u4e00-\u9fff]{2,6}/g) || []) words.add(w);
  return [...words].filter((w) => !/^(什么|怎么|为什么|可以|这个|那个|这一|一下|的|了|是|和|与|在|有|我|你)$/.test(w));
}

function rankParagraphs(paragraphs, query, limit = 4) {
  const kws = keywordsOf(query);
  if (!kws.length) return paragraphs.slice(0, limit);
  const scored = paragraphs.map((p, i) => {
    let score = 0;
    for (const k of kws) if (p.includes(k)) score += k.length >= 2 ? 2 : 1;
    return { p, i, score };
  }).filter((x) => x.score > 0);
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.p);
}

function localChatAnswer({ question, section, lesson, text, textInfo = null }) {
  const q = String(question || '').trim();
  if (!isUsableText(text)) {
    const detail = textInfo && textInfo.unreadablePages && textInfo.unreadablePages.length
      ? `这一节有 ${textInfo.unreadablePages.length} 页没有可靠文字。`
      : '这一节没有提取到可靠的原文。';
    return [
      `${detail}可能是扫描页、公式图片，或页码区间不准确。`,
      '我不会根据乱码硬答，避免把错误内容当成教材原文。',
      '可以点「PDF 原页」对照阅读；如果这一节确实有文字，请在书架里重试分析，或检查本机 OCR 语言包。',
      '（这是本地规则引擎的回答，没有调用模型。）',
    ].join('\n\n');
  }
  const paragraphs = toParagraphs(text);
  const ranked = rankParagraphs(paragraphs, q, 3);
  const defs = extractDefinitions(text);
  const keys = (lesson && lesson.keyPoints) || [];
  const wants = {
    summary: /(总结|概括|梳理|讲了什么|主要内容)/.test(q),
    example: /(例子|举例|例子|应用|实际)/.test(q),
    simpler: /(不懂|看不懂|简单|通俗|大白话|解释|什么意思)/.test(q),
    difference: /(区别|不同|为什么|关系|对比)/.test(q),
    exercise: /(题|练习|自测|考|测一测)/.test(q),
  };

  const parts = [];
  if (wants.exercise) {
    const qs = (lesson && lesson.questions) || [];
    if (qs.length) {
      parts.push('可以先用这几个问题自测：');
      qs.forEach((x, i) => parts.push(`${i + 1}. ${x}`));
      parts.push('先不看讲义回答一遍，再回来对照原文——能说出「为什么」才算真懂。');
    } else {
      parts.push('这一节还没有生成讲义，暂时没有现成的自测题。先读一遍原文，试着用自己的话解释本节标题。');
    }
  } else if (wants.summary) {
    if (lesson && lesson.summary) parts.push(`一句话：${lesson.summary}`);
    if (keys.length) {
      parts.push('这一节的几个关键点：');
      keys.slice(0, 4).forEach((k) => parts.push(`· ${k}`));
    }
    if (!parts.length) parts.push('这一节提取到的文字比较零散，先看「教材原文」确认页码是否准确。');
  } else if (wants.example) {
    if (lesson && lesson.example) parts.push(`原文里的例子：${lesson.example}`);
    else if (lesson && lesson.pitfalls && lesson.pitfalls.length) {
      parts.push(`原文没有直接给例子。你可以用一个极端情况来检验概念：${lesson.pitfalls[0]}`);
    } else {
      parts.push('这一节的提取文字里没有直接给例子。可以先把定义抄下来，再找一个课本后面的例题对照。');
    }
  } else if (wants.simpler) {
    if (lesson && lesson.overview) parts.push(lesson.overview);
    if (defs.length) {
      parts.push(`先抓住一个定义：「${defs[0].sentence}」`);
      parts.push('把这句里的「条件、对象、结果」分别圈出来，再读后面的推导，会顺很多。');
    } else if (ranked.length) {
      parts.push(`原文里最相关的一句是：「${oneLine(ranked[0], 220)}」`);
      parts.push('可以先把这句拆成主谓宾，再看它前后两句分别在解释什么。');
    }
  } else if (wants.difference && ranked.length) {
    parts.push(`原文里和这个问题最接近的段落是：「${oneLine(ranked[0], 240)}」`);
    if (ranked[1]) parts.push(`紧接着还提到：「${oneLine(ranked[1], 200)}」`);
    parts.push('把这两段放在一起看，区别通常就在「条件不同 → 结果不同」这一层。');
  } else if (defs.length && /(是什么|定义|含义|指什么)/.test(q)) {
    parts.push(`可以这样理解：${defs[0].sentence}`);
    if (keys.length) parts.push(`这一节还需要连着看：${keys[0]}`);
  } else if (ranked.length) {
    parts.push(`教材这一节里相关的内容是：「${oneLine(ranked[0], 260)}」`);
    if (ranked[1]) parts.push(`另一段可以对照着看：「${oneLine(ranked[1], 220)}」`);
    if (lesson && lesson.summary) parts.push(`放回本节主旨里：${lesson.summary}`);
  } else {
    parts.push('在提取到的这一节文字里，没有找到和这个问题直接相关的内容。可能是这一页以图为主，或者页码区间偏了。');
    parts.push('你可以打开「教材原文」或「PDF 原页」核对；也可以换个更具体的问法，比如直接问某个概念名。');
  }

  parts.push('（这是本地规则引擎基于原文检索的回答。在设置里换成远程模型，可以展开更完整的讲解。）');
  return parts.join('\n\n');
}

const CHAT_SYSTEM = `你是「缓一缓」教材精读里的学习助教，正在陪一位大学生读教材。
规则：
1. 优先依据提供的教材原文回答，并尽量指出页码。原文没有的内容，要明确说「这一节原文没有展开」，再决定是否用一般知识补充；补充时要标明是补充。
2. 解释要具体：概念用「是什么—为什么—怎么用」讲，公式说清每个符号的含义和条件。
3. 学生说看不懂时，换更简单的说法或给一个小例子，不要重复原文。
4. 回答简洁，通常 150–400 字；学生明确要求详细展开时可以更长。用中文，可用 markdown 列表。
5. 不要编造页码、作者、定理名称；不确定就说不确定。
6. 不要做心理诊断，不要用居高临下的语气。`;

function chatExcerpt(text) {
  const clean = normalizeText(text);
  if (clean.length <= MAX_CHAT_EXCERPT_CHARS) return clean;
  return `${clean.slice(0, MAX_CHAT_EXCERPT_CHARS)}\n\n（原文过长，以上是本节前一部分。）`;
}

async function answerWithModel({ settings, book, chapter, section, lesson, text, question, history, textInfo = null }) {
  if (!isUsableText(text)) {
    return {
      content: localChatAnswer({ question, section, lesson, text, textInfo }),
      provider: 'local',
      model: null,
      warning: null,
    };
  }
  const paragraphs = toParagraphs(text);
  const relevant = rankParagraphs(paragraphs, question, 5);
  const excerpt = relevant.length ? relevant.join('\n\n') : chatExcerpt(text);
  const historyMessages = (history || []).slice(-8).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || '').slice(0, 1200),
  }));

  const context = [
    `教材：《${book.title}》`,
    `当前小节：${chapter.title} / ${section.title}（第 ${section.pageStart}–${section.pageEnd} 页）`,
    lesson ? `本节讲义摘要：${oneLine(lesson.summary || lesson.overview, 700)}` : '',
    lesson && lesson.keyPoints && lesson.keyPoints.length
      ? `本节关键点：${lesson.keyPoints.slice(0, 4).join('；')}`
      : '',
    '',
    '与本问题最相关的教材原文：',
    normalizeText(excerpt).slice(0, MAX_CHAT_EXCERPT_CHARS),
  ].filter(Boolean).join('\n');

  const messages = [
    { role: 'system', content: CHAT_SYSTEM },
    { role: 'system', content: context },
    ...historyMessages,
    { role: 'user', content: question },
  ];

  const out = await complete({
    settings,
    messages,
    temperature: 0.35,
    maxTokens: 1200,
    timeoutMs: settings.aiProvider === 'ollama' ? 150000 : 60000,
  });
  const answer = String(out.text || '').trim();
  if (!answer) throw new Error('模型返回了空回答');
  return {
    content: answer.slice(0, 12000),
    provider: out.provider,
    model: out.model,
    warning: null,
  };
}

// ================================================================ 书籍记录

function bookSummary(book) {
  const total = (book.chapters || []).reduce((n, c) => n + (c.sections || []).length, 0);
  const done = (book.chapters || []).reduce(
    (n, c) => n + (c.sections || []).filter((s) => s.done).length,
    0
  );
  return {
    id: book.id,
    title: book.title,
    fileName: book.fileName,
    fileSize: book.fileSize,
    pageCount: book.pageCount,
    status: book.status,
    statusMessage: book.statusMessage || '',
    structureSource: book.structureSource || '',
    structureNote: book.structureNote || '',
    analysisProvider: book.analysisProvider || 'local',
    textSource: book.textSource || 'pdf',
    textQuality: book.textQuality || null,
    ocrUsed: Boolean(book.ocr && book.ocr.used),
    chapterCount: (book.chapters || []).length,
    sectionCount: total,
    progress: { done, total, pct: total ? Math.round((done / total) * 100) : 0 },
    guide: book.guide || null,
    hasFile: Boolean(book.hasFile),
    lastSectionId: (book.progress && book.progress.lastSectionId) || null,
    lastReadAt: (book.progress && book.progress.lastReadAt) || null,
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
  };
}

function findSection(book, sectionId) {
  for (const chapter of book.chapters || []) {
    for (const section of chapter.sections || []) {
      if (section.id === sectionId) return { chapter, section };
    }
  }
  return null;
}

function firstSection(book) {
  for (const chapter of book.chapters || []) {
    if (chapter.sections && chapter.sections.length) return { chapter, section: chapter.sections[0] };
  }
  return null;
}

function countSections(book) {
  return (book.chapters || []).reduce((n, c) => n + (c.sections || []).length, 0);
}

function nextSection(book, sectionId) {
  const list = [];
  for (const chapter of book.chapters || []) {
    for (const section of chapter.sections || []) list.push({ chapter, section });
  }
  const i = list.findIndex((x) => x.section.id === sectionId);
  return i >= 0 ? list[i + 1] || null : null;
}

function refreshProgress(book) {
  const total = countSections(book);
  const done = (book.chapters || []).reduce(
    (n, c) => n + (c.sections || []).filter((s) => s.done).length,
    0
  );
  book.progress = {
    ...(book.progress || {}),
    totalSections: total,
    doneSections: done,
    lastReadAt: (book.progress && book.progress.lastReadAt) || null,
    lastSectionId: (book.progress && book.progress.lastSectionId) || null,
  };
}

function newBookRecord({ title, fileName, fileSize, pageCount, outlineItems }) {
  const now = db.nowIso();
  return {
    id: db.newId('book'),
    title: String(title || '').trim().slice(0, 200) || '未命名教材',
    fileName: String(fileName || '').slice(0, 260),
    fileSize: Math.max(0, Number(fileSize) || 0),
    pageCount,
    status: 'imported',
    statusMessage: '',
    chapters: [],
    guide: null,
    structureSource: '',
    structureNote: '',
    analysisProvider: 'local',
    outlineItems: Array.isArray(outlineItems) ? outlineItems.slice(0, 500) : [],
    progress: { doneSections: 0, totalSections: 0, lastSectionId: null, lastReadAt: null },
    chats: {},
    hasFile: false,
    createdAt: now,
    updatedAt: now,
  };
}

function sanitizePages(input, pageCount) {
  if (!Array.isArray(input)) return [];
  const map = new Map();
  let total = 0;
  for (const item of input.slice(0, MAX_PAGES)) {
    const page = Math.round(Number(item && item.page));
    if (!Number.isFinite(page) || page < 1 || page > pageCount) continue;
    let text = String((item && item.text) || '');
    if (text.length > MAX_PAGE_TEXT) text = text.slice(0, MAX_PAGE_TEXT);
    total += text.length;
    if (total > MAX_TOTAL_TEXT) break;
    map.set(page, normalizeText(text));
  }
  const pages = [];
  for (let i = 1; i <= pageCount; i += 1) {
    pages.push({ page: i, text: map.get(i) || '' });
  }
  return pages;
}

// ================================================================ OCR 兜底

const ocrBookLocks = new Map();
const ocrRuns = new Map();

function compactText(text) {
  return normalizeText(text).replace(/\s/g, '');
}

function isUsableText(text) {
  const clean = normalizeText(text);
  if (compactText(clean).length < 12) return false;
  return !ocr.isLikelyGarbled(clean);
}

/** 这一页能不能拿去生成讲义。OCR 过的页面按识别结果处理，不再重复判断乱码。 */
function isPageReadable(page) {
  if (!page) return false;
  const text = String(page.text || '');
  if (!compactText(text)) return false;
  if (page.source === 'ocr') return true;
  return !ocr.isLikelyGarbled(text);
}

function lineKey(line) {
  return String(line || '').replace(/[\s\u00a0]+/g, '').slice(0, 80);
}

/**
 * 去掉每页重复的书名/章名页眉页脚。
 * 只处理同一位置连续出现超过六成页面的行，避免误删正文里的重复句子。
 */
function stripRunningHeaders(pageList) {
  const list = Array.isArray(pageList) ? pageList : [];
  if (list.length < 4) return list;
  const rows = list.map((p) => String(p.text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean));
  const nonEmpty = rows.filter((r) => r.length);
  if (nonEmpty.length < 4) return list;

  const threshold = Math.max(3, Math.ceil(nonEmpty.length * 0.6));
  const countAt = (position) => {
    const counts = new Map();
    for (const row of nonEmpty) {
      const line = position === 'first' ? row[0] : row[row.length - 1];
      const key = lineKey(line);
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  };
  const repeated = (counts) => new Set(
    [...counts].filter(([key, n]) => n >= threshold && key.length <= 80).map(([key]) => key)
  );
  const dropFirst = repeated(countAt('first'));
  const dropLast = repeated(countAt('last'));
  if (!dropFirst.size && !dropLast.size) return list;

  return list.map((page, index) => {
    const lines = rows[index].slice();
    if (lines.length && dropFirst.has(lineKey(lines[0]))) lines.shift();
    if (lines.length && dropLast.has(lineKey(lines[lines.length - 1]))) lines.pop();
    if (lines.length === rows[index].length) return page;
    return { ...page, text: lines.join('\n') };
  });
}

/** 需不需要为这一页跑 OCR。已经试过的页不再反复识别。 */
function pageNeedsOcr(page) {
  if (!page || page.source === 'ocr' || page.ocrTried) return false;
  const compact = compactText(page.text);
  if (!compact) return true;
  if (compact.length < 40) return false;
  return ocr.isLikelyGarbled(page.text);
}

function applyOcrResult(pages, data) {
  const map = new Map(pages.map((p) => [p.page, p]));
  let applied = 0;
  let empty = 0;
  let failed = 0;
  const appliedPages = [];
  for (const result of (data && data.pages) || []) {
    const target = map.get(Number(result && result.page));
    if (!target) continue;
    if (!result || result.error) { failed += 1; continue; }
    if (!pageNeedsOcr(target)) continue;
    const text = normalizeText(ocr.pageText(result));
    const compact = compactText(text);
    const han = (text.match(/[\u3400-\u9fff]/g) || []).length;
    const usable = compact.length >= 12 && (!ocr.isLikelyGarbled(text) || han >= 12);
    if (usable) {
      target.text = text;
      target.source = 'ocr';
      target.ocrTried = true;
      target.ocrAppliedAt = db.nowIso();
      applied += 1;
      appliedPages.push(target.page);
    } else {
      target.ocrTried = true;
      target.ocrEmpty = !compact;
      if (compact) target.ocrLowQuality = true;
      empty += 1;
    }
  }
  return { applied, empty, failed, pages: appliedPages };
}

function withOcrBookLock(bookId, task) {
  const prev = ocrBookLocks.get(bookId) || Promise.resolve();
  const next = prev.catch(() => {}).then(task);
  const guard = next.catch(() => {});
  ocrBookLocks.set(bookId, guard);
  guard.then(() => {
    if (ocrBookLocks.get(bookId) === guard) ocrBookLocks.delete(bookId);
  });
  return next;
}

/**
 * 识别指定页，并把可用的文字写回页面文件。
 * 同一本书串行执行，避免两个请求同时写同一份页面数据；
 * 完全相同的页范围会复用正在进行的任务。
 */
async function runOcrForPages(book, pageNumbers, { column = false, onBatch } = {}) {
  const list = [...new Set((pageNumbers || [])
    .map((n) => Math.round(Number(n)))
    .filter((n) => n >= 1 && n <= book.pageCount))]
    .sort((a, b) => a - b)
    .slice(0, OCR_SECTION_MAX_PAGES);
  if (!list.length) return { applied: 0, empty: 0, failed: 0, pages: [], dataPages: [] };

  const key = `${book.id}:${column ? 'col' : 'txt'}:${list.join(',')}`;
  if (ocrRuns.has(key)) return ocrRuns.get(key);

  const job = withOcrBookLock(book.id, async () => {
    if (!(await db.textbookFileExists(book.id))) {
      throw Object.assign(new Error('原始 PDF 没有保存在本机，无法进行本机 OCR。可以重新导入这个文件。'), {
        code: 'OCR_NO_PDF',
      });
    }
    const availability = await ocr.getAvailability();
    if (!availability.available) {
      throw Object.assign(new Error(availability.reason || '本机 OCR 不可用'), { code: 'OCR_UNAVAILABLE' });
    }

    const pages = await db.readTextbookPages(book.id);
    const byPage = new Map(pages.map((p) => [p.page, p]));
    const targets = list.filter((n) => pageNeedsOcr(byPage.get(n)));
    if (!targets.length) return { applied: 0, empty: 0, failed: 0, pages: [], dataPages: [] };

    let applied = 0;
    let empty = 0;
    let failed = 0;
    const appliedPages = [];
    const dataPages = [];
    for (let i = 0; i < targets.length; i += OCR_BATCH_PAGES) {
      const batch = targets.slice(i, i + OCR_BATCH_PAGES);
      const data = await ocr.runPages({
        pdfPath: db.textbookFilePath(book.id),
        pages: batch,
        width: OCR_WIDTH,
        languages: ['zh-Hans-CN', 'en-US'],
        column,
      });
      const merged = applyOcrResult(pages, data);
      applied += merged.applied;
      empty += merged.empty;
      failed += merged.failed;
      appliedPages.push(...merged.pages);
      dataPages.push(...((data && data.pages) || []));
      if (merged.applied) await db.writeTextbookPages(book.id, pages);
      if (typeof onBatch === 'function') {
        await onBatch({ done: Math.min(i + batch.length, targets.length), total: targets.length, applied: merged.applied });
      }
    }
    return { applied, empty, failed, pages: appliedPages, dataPages };
  });

  ocrRuns.set(key, job);
  const cleanup = () => { if (ocrRuns.get(key) === job) ocrRuns.delete(key); };
  job.then(cleanup, cleanup);
  return job;
}

/** 先识别前几页目录区域；不够再往后扩，避免一上来把整本书都 OCR。 */
async function ocrFrontPages(book, { onProgress } = {}) {
  const rawPages = [];
  let applied = 0;
  let readUntil = 0;

  const runStage = async (until) => {
    const nums = [];
    for (let n = readUntil + 1; n <= until; n += 1) nums.push(n);
    readUntil = until;
    if (!nums.length) return;
    const result = await runOcrForPages(book, nums, {
      column: true,
      onBatch: async ({ done, total, applied: batchApplied }) => {
        applied += batchApplied;
        if (onProgress) await onProgress({ done, total, stageTotal: until });
      },
    });
    rawPages.push(...result.dataPages);
  };

  await runStage(Math.min(book.pageCount, OCR_FRONT_INITIAL));
  rawPages.sort((a, b) => Number(a.page) - Number(b.page));
  let toc = parseToc(rawPages, { pageCount: book.pageCount });

  if (!toc.ok && book.pageCount > readUntil) {
    await runStage(Math.min(book.pageCount, OCR_FRONT_MAX));
    rawPages.sort((a, b) => Number(a.page) - Number(b.page));
    toc = parseToc(rawPages, { pageCount: book.pageCount });
  }
  return { rawPages, toc, applied, readUntil };
}

function chaptersFromOcrToc(toc, pageCount, pages) {
  if (!toc || !toc.ok || !Array.isArray(toc.chapters) || !toc.chapters.length) return [];
  const chapters = toc.chapters.map((c) => ({
    title: c.chapterTitle,
    pageStart: c.pageStart,
    pageEnd: pageCount,
    sections: (c.sections || []).map((s) => ({
      title: s.sectionTitle,
      pageStart: s.pageStart,
      pageEnd: pageCount,
      wholeChapter: false,
      subsections: [],
    })),
  }));

  for (let ci = 0; ci < chapters.length; ci += 1) {
    const chapter = chapters[ci];
    chapter.sections.sort((a, b) => a.pageStart - b.pageStart);
    const nextChapter = chapters[ci + 1];
    chapter.pageEnd = nextChapter && nextChapter.pageStart > chapter.pageStart
      ? nextChapter.pageStart - 1
      : pageCount;
    for (let si = 0; si < chapter.sections.length; si += 1) {
      const section = chapter.sections[si];
      const nextSection = chapter.sections[si + 1];
      section.pageEnd = nextSection && nextSection.pageStart > section.pageStart
        ? nextSection.pageStart - 1
        : chapter.pageEnd;
      if (section.pageEnd < section.pageStart) section.pageEnd = section.pageStart;
    }
  }
  return finalizeChapters(chapters, pageCount, 'ocr', pages);
}

// ================================================================ 目录导览

async function buildGuide({ settings, book, chapters, pages }) {
  const chapterLines = chapters.slice(0, 30).map((c, i) => {
    const secs = c.sections.slice(0, 8).map((s) => s.title).join('；');
    return `${i + 1}. ${c.title}（第 ${c.pageStart}–${c.pageEnd} 页）${secs ? `：${secs}` : ''}`;
  }).join('\n');
  const front = stripRunningHeaders(pages.slice(0, 8))
    .filter((p) => isPageReadable(p))
    .map((p) => p.text)
    .join('\n')
    .slice(0, 7000);
  const demoCount = chapters.reduce((n, c) => n + c.sections.filter((s) => s.demos && s.demos.length).length, 0);

  const sectionCount = chapters.reduce((n, c) => n + c.sections.length, 0);
  const local = {
    overview: `《${book.title}》共 ${book.pageCount} 页，整理出 ${chapters.length} 个章节、${sectionCount} 个可读小节。建议先翻一遍目录，再按小节精读：每节先看讲义抓住主线，再回到原文核对细节。`,
    studyPath: chapters.slice(0, 7).map((c) => `先读「${c.title}」，再按节推进`),
    demoNote: demoCount ? `其中 ${demoCount} 节附有可选动画，放在讲义之后，只辅助理解个别概念；主要学习材料仍是讲义和教材原文。` : '',
    provider: 'local',
    model: null,
    warning: null,
    generatedAt: db.nowIso(),
  };

  if (settings.aiProvider === 'mock' || !chapters.length || !front) return local;

  const prompt = [
    `教材：《${book.title}》`,
    `共 ${book.pageCount} 页。整理出的章节框架：`,
    chapterLines,
    demoCount ? `其中 ${demoCount} 节会在讲义之后提供可选的辅助动画（仅作为文字讲解的补充）。` : '',
    '',
    '开头几页的文字（可能有页眉和断行）：',
    front,
    '',
    '请输出 JSON：{"overview":"3-4 句全书导览，说明这本教材的主线", "studyPath":["3-6 条阅读建议，按先后顺序"], "demoNote":"如果书里有电路/网络相关章节，写一句说明动画只是讲义的辅助、以文字为主；没有就写空字符串"}',
    '不要编造目录之外的内容。',
  ].filter(Boolean).join('\n');

  try {
    const out = await complete({
      settings,
      system: '你是大学教材阅读规划师。根据目录框架和开头文字写一份简短的阅读导览，只输出 JSON，不要额外解释。',
      user: prompt,
      temperature: 0.3,
      maxTokens: 900,
      timeoutMs: settings.aiProvider === 'ollama' ? 100000 : 60000,
    });
    const parsed = parseJson(out.text);
    if (!parsed || !parsed.overview) throw new Error('模型返回的导览结构不可用');
    return {
      overview: String(parsed.overview).slice(0, 2000),
      studyPath: Array.isArray(parsed.studyPath)
        ? parsed.studyPath.map((x) => String(x).slice(0, 300)).filter(Boolean).slice(0, 6)
        : local.studyPath,
      demoNote: typeof parsed.demoNote === 'string'
        ? parsed.demoNote.slice(0, 500)
        : local.demoNote,
      provider: out.provider,
      model: out.model,
      warning: null,
      generatedAt: db.nowIso(),
    };
  } catch (err) {
    return {
      ...local,
      warning: `模型这次没有生成阅读导览，已用本地整理。原因：${err.message}`,
    };
  }
}

// ================================================================ 对外流程

async function analyze(bookId, settings) {
  const book = await db.get('textbooks', bookId);
  let pages = await db.readTextbookPages(bookId);
  if (!pages.length) {
    book.status = 'error';
    book.statusMessage = '这本书还没有正文，无法分析。请重新导入。';
    await db.put('textbooks', book);
    throw Object.assign(new Error(book.statusMessage), { status: 400 });
  }

  const initialQuality = ocr.assessTextQuality(pages);
  const needsOcr = initialQuality.quality === 'empty' || initialQuality.quality === 'garbled';

  book.status = 'analyzing';
  book.statusMessage = needsOcr
    ? '文字层读不出可读文字，正在准备本机 OCR…'
    : '正在整理目录和章节框架…';
  await db.put('textbooks', book);

  try {
    let front = null;
    let quality = initialQuality;
    if (needsOcr) {
      if (!book.hasFile) {
        throw Object.assign(new Error(
          '这份 PDF 的文字层读不出可读文字，而原始 PDF 也没有保存到本机，无法做 OCR。请重新导入这个文件。'
        ), { status: 422, code: 'ocr-no-pdf' });
      }
      book.statusMessage = '文字层读不出可读文字，正在用本机 OCR 识别目录…';
      await db.put('textbooks', book);

      front = await ocrFrontPages(book, {
        onProgress: async ({ done, total, stageTotal }) => {
          book.statusMessage = `文字层读不出可读文字，正在用本机 OCR 识别目录…（${done}/${total} 页，已覆盖到第 ${stageTotal} 页）`;
          await db.put('textbooks', book);
        },
      });
      pages = await db.readTextbookPages(bookId);
      quality = ocr.assessTextQuality(pages);
      const anyReadable = pages.some((p) => isPageReadable(p));
      if (!front.applied && !anyReadable) {
        throw Object.assign(new Error(
          '本机 OCR 也没有识别出可读文字。请确认 Windows 已安装中文 OCR 语言包，或换一份更清晰的 PDF。'
        ), { status: 422, code: 'ocr-empty' });
      }
    }

    const hasBookmarks = Array.isArray(book.outlineItems) && book.outlineItems.length >= 2;
    let chapters = [];
    let source = '';
    let note = '';

    if (hasBookmarks) {
      chapters = chaptersFromItems(book.outlineItems, book.pageCount, 'bookmarks');
      if (chapters.length) {
        source = 'bookmarks';
        note = '章节来自 PDF 自带书签，页码按 PDF 页序。';
      }
    }

    if (!chapters.length && front && front.toc && front.toc.ok) {
      chapters = chaptersFromOcrToc(front.toc, book.pageCount, pages);
      if (chapters.length) {
        source = 'ocr';
        note = `${front.toc.note}。文字层不可读，正文改用本机 Windows OCR。`;
      }
    }

    if (!chapters.length) {
      const built = buildStructure({
        pages,
        pageCount: book.pageCount,
        outlineItems: book.outlineItems || [],
      });
      chapters = built.chapters;
      source = built.source;
      note = built.note;
    }

    // 文字层只坏了一部分时，先尝试普通目录解析；如果只剩按页分段，
    // 再回头用本机 OCR 补一次目录，避免整本书被切成毫无意义的大段。
    if (source === 'chunks' && !front && quality.quality !== 'ok' && book.hasFile) {
      try {
        front = await ocrFrontPages(book, {
          onProgress: async ({ done, total, stageTotal }) => {
            book.statusMessage = `目录不好认，正在用本机 OCR 补识别…（${done}/${total} 页，已覆盖到第 ${stageTotal} 页）`;
            await db.put('textbooks', book);
          },
        });
        pages = await db.readTextbookPages(bookId);
        quality = ocr.assessTextQuality(pages);
        if (front.toc && front.toc.ok) {
          const ocrChapters = chaptersFromOcrToc(front.toc, book.pageCount, pages);
          if (ocrChapters.length) {
            chapters = ocrChapters;
            source = 'ocr';
            note = `${front.toc.note}。文字层不可读，正文改用本机 Windows OCR。`;
          }
        }
        if (source !== 'ocr') {
          const built = buildStructure({
            pages,
            pageCount: book.pageCount,
            outlineItems: book.outlineItems || [],
          });
          chapters = built.chapters;
          source = built.source;
          note = built.note;
        }
      } catch (ocrErr) {
        // 目录补识别失败不阻断阅读：原来的按页分段仍然可用
        console.warn('[教材 OCR] 补识别目录失败：', ocrErr.message);
      }
    }

    if (!chapters.length) throw new Error('没有整理出可用章节');

    // 书签路径的章节在生成时还没带页面文字，这里统一按新规则配一次演示。
    const demoBook = { chapters, guide: null };
    refreshDemos(demoBook, pages);
    chapters = demoBook.chapters;

    const analysisProvider = settings.aiProvider === 'mock'
      ? 'local'
      : settings.aiProvider;
    const guide = await buildGuide({ settings, book, chapters, pages });

    const readablePages = pages.filter((p) => isPageReadable(p));
    const ocrReadable = readablePages.filter((p) => p.source === 'ocr');
    const pdfReadable = readablePages.filter((p) => p.source !== 'ocr');
    const textSource = ocrReadable.length && pdfReadable.length
      ? 'mixed'
      : ocrReadable.length ? 'ocr' : 'pdf';

    book.chapters = chapters;
    refreshProgress(book);
    book.status = 'ready';
    book.statusMessage = '';
    book.structureSource = source;
    book.structureNote = note;
    book.analysisProvider = analysisProvider;
    book.guide = guide;
    book.demoPolicyVersion = DEMO_POLICY_VERSION;
    book.textQuality = { ...quality, checkedAt: db.nowIso() };
    book.textSource = textSource;
    book.ocr = front && (front.applied || needsOcr)
      ? {
          engine: 'windows-ocr',
          used: true,
          frontPages: front.readUntil,
          appliedPages: front.applied,
          note: '正文由本机 Windows OCR 识别，公式、符号和分栏可能失真；重要内容请对照 PDF 原页。',
          lastRunAt: db.nowIso(),
        }
      : null;
    const termSample = stripRunningHeaders(pages.slice(0, 12))
      .filter((p) => isPageReadable(p))
      .map((p) => p.text)
      .join('\n')
      .slice(0, 12000);
    book.terms = glossary.bookTerms(book, { limit: 10, sampleText: termSample });
    await db.put('textbooks', book);
    return book;
  } catch (err) {
    book.status = 'error';
    book.statusMessage = err.message || String(err);
    if (!err.status) err.status = 422;
    await db.put('textbooks', book);
    throw err;
  }
}

function publicBook(book) {
  const { outlineItems, ...rest } = book;
  const summary = bookSummary(book);
  return {
    ...rest,
    ...summary,
    chats: book.chats || {},
  };
}

async function sectionPayload(book, sectionId) {
  const hit = findSection(book, sectionId);
  if (!hit) throw Object.assign(new Error('找不到这一节'), { status: 404 });

  let pages = await db.readTextbookPages(book.id);
  let slice = pages.filter((p) => p.page >= hit.section.pageStart && p.page <= hit.section.pageEnd);

  const needOcr = slice
    .filter((p) => pageNeedsOcr(p))
    .map((p) => p.page)
    .slice(0, OCR_SECTION_MAX_PAGES);
  let ocrJustApplied = 0;
  let ocrError = '';

  if (needOcr.length) {
    if (!book.hasFile) {
      ocrError = '原始 PDF 没有保存在本机，这几页无法做 OCR。';
    } else {
      try {
        const result = await runOcrForPages(book, needOcr, { column: false });
        ocrJustApplied = result.applied;
        if (result.applied) {
          pages = await db.readTextbookPages(book.id);
          slice = pages.filter((p) => p.page >= hit.section.pageStart && p.page <= hit.section.pageEnd);
        }
      } catch (err) {
        ocrError = err.message || String(err);
      }
    }
  }

  const cleanedSlice = stripRunningHeaders(slice);
  const readablePages = cleanedSlice.filter((p) => isPageReadable(p));
  const unreadablePages = cleanedSlice.filter((p) => !isPageReadable(p)).map((p) => p.page);
  const text = readablePages.map((p) => p.text).join('\n\n');
  const ocrPages = readablePages.filter((p) => p.source === 'ocr').map((p) => p.page);
  const pdfPages = readablePages.filter((p) => p.source !== 'ocr');
  const source = ocrPages.length && pdfPages.length
    ? 'mixed'
    : ocrPages.length ? 'ocr' : pdfPages.length ? 'pdf' : 'none';

  const noteParts = [];
  if (source === 'ocr' || source === 'mixed') {
    noteParts.push(
      source === 'ocr'
        ? '本节正文由本机 Windows OCR 识别，公式、符号和分栏可能失真，重要内容请对照 PDF 原页。'
        : `本节有 ${ocrPages.length} 页由本机 OCR 识别，公式和符号可能失真，请对照 PDF 原页。`
    );
  }
  if (unreadablePages.length) {
    noteParts.push(`${unreadablePages.length} 页没有可靠文字，已从讲义依据中排除。`);
  }
  if (ocrError) noteParts.push(`本机 OCR 没有完成：${ocrError}`);

  const textInfo = {
    source,
    totalPages: slice.length,
    textPages: readablePages.length,
    ocrPages,
    unreadablePages,
    ocrJustApplied,
    usable: isUsableText(text),
    note: noteParts.join(' '),
  };

  return {
    chapter: {
      id: hit.chapter.id,
      title: hit.chapter.title,
      pageStart: hit.chapter.pageStart,
      pageEnd: hit.chapter.pageEnd,
    },
    section: hit.section,
    pages: cleanedSlice.map((p) => ({
      page: p.page,
      text: isPageReadable(p) ? p.text : '',
      source: p.source || 'pdf',
      readable: isPageReadable(p),
    })),
    text,
    textInfo,
    terms: glossary.matchTerms(`${hit.section.title}\n${text}`, { limit: 4 }),
    next: nextSection(book, sectionId)
      ? { sectionId: nextSection(book, sectionId).section.id, title: nextSection(book, sectionId).section.title }
      : null,
  };
}

module.exports = {
  MAX_PAGES,
  MAX_CHAT_MESSAGES,
  normalizeText,
  toParagraphs,
  parseTocLine,
  parseTocPages,
  scanHeadings,
  chaptersFromItems,
  chunkChapters,
  buildStructure,
  detectDemos,
  titleDemoId,
  refreshDemos,
  DEMO_POLICY_VERSION,
  localLesson,
  validateLesson,
  localChatAnswer,
  stripRunningHeaders,
  sanitizePages,
  newBookRecord,
  bookSummary,
  publicBook,
  findSection,
  firstSection,
  nextSection,
  countSections,
  refreshProgress,
  analyze,
  generateLesson,
  answerWithModel,
  buildGuide,
  sectionPayload,
  providerLabel,
  DEMO_RULES,
};
