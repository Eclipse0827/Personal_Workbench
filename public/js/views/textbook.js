/**
 * 教材阅读器
 * ---------------------------------------------------------------
 * 一张页面里放三件事：
 *   1. 左边目录：章 → 节，随时跳转，读完的打勾；
 *   2. 中间讲义：按节生成，可以切到「教材原文 / PDF 原页」核对；
 *   3. 右边问答：只围绕当前这一节，历史存在本地。
 *
 * 讲义没生成过时才会调用模型；模型失败会退回本地原文整理，并明确标注。
 * 所有模型输出都当成纯文本 / markdown 渲染，不拼 HTML。
 */

import { api } from '../api.js';
import {
  h, clear, toast, toastError, pageHead, emptyState, chip,
  fmtDateTime, fmtRelative,
} from '../ui.js';
import { state } from '../state.js';
import { renderMarkdown } from '../markdown.js';
import { mountDemo, demoInfo } from '../demos/index.js';

const ENGINE_LABEL = {
  local: '本地原文整理',
  mock: '本地原文整理',
  ollama: 'Ollama 本机模型',
  real: '远程模型',
};

const TEXT_SOURCE_LABEL = {
  pdf: 'PDF 文字层',
  ocr: '本机 Windows OCR',
  mixed: 'PDF 文字 + 本机 OCR',
  none: '没有可用文字',
};

const BILIBILI_SEARCH = 'https://search.bilibili.com/all?keyword=';
const XHS_SEARCH = 'https://www.xiaohongshu.com/search_result?keyword=';

function engineLabel(provider) {
  return ENGINE_LABEL[provider] || '本地原文整理';
}

/**
 * 把一句提问压成适合站内搜索的短句。
 * 这里只做确定性的词面清理，不假装是模型「总结」；问题原文仍保留在对话里。
 */
const SEARCH_STOP_WORDS = /(请问|帮我|给我|我想|想知道|能不能|可不可以|可以|如何|怎么|怎样|为什么|到底|究竟|有什么|什么|哪些|哪个|多少|是否|什么是|是什么意思|什么意思|解释一下|解释|讲讲|说说|讲一遍|展开|一下|一个|这个|那个|这一节|本节|具体|应该|需要|是|的|了|吗|呢|啊|吧|和|与|及|在|中|对|把|被|让|给|这|那|它|我们|你|我)/g;

function cleanSearchWords(text) {
  return String(text || '')
    .replace(/[？?！!。，,、；;：:（）()「」“”"']/g, ' ')
    .replace(SEARCH_STOP_WORDS, ' ')
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((word) => word.replace(/^[是的有在和与及对把被让给]+|[是的有了吗呢啊吧]+$/g, ''))
    .filter((word) => word.length >= 2)
    .join(' ')
    .trim();
}

export function studySearchQuery(question, sectionTitle) {
  const core = cleanSearchWords(question);
  const title = String(sectionTitle || '').trim();
  const titleCore = cleanSearchWords(title);
  const titleWords = titleCore.split(' ').filter((word) => word.length >= 3);
  const titleCovered = titleWords.some((word) => core.includes(word));
  const parts = titleCovered ? [core] : [title || titleCore, core];
  return parts.filter(Boolean).join(' ').slice(0, 64).trim() || title.slice(0, 64);
}

function flattenSections(book) {
  const out = [];
  for (const chapter of book.chapters || []) {
    for (const section of chapter.sections || []) out.push({ chapter, section });
  }
  return out;
}

function findSectionById(book, sectionId) {
  return flattenSections(book).find((x) => x.section.id === sectionId) || null;
}

// 题目里常见的「1、… 2、…」如果挤在一行，按编号拆成多行显示；原文保持不变。
const QUESTION_MARKER_RE = /(?:\d{1,2}(?:[.)．](?!\d)|、)|[（(]\d{1,2}[）)]|[①-⑳])/g;
const QUESTION_BREAK_PUNCT = /[\s。；;，,：:！!？?、]/;

export function splitQuestionLines(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  const out = [];
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    const hits = [...line.matchAll(QUESTION_MARKER_RE)].filter((m) => {
      const before = m.index > 0 ? line[m.index - 1] : '';
      return !(/^\d/.test(m[0]) && /[\dA-Za-z]/.test(before));
    });
    if (hits.length < 2) {
      out.push(line);
      continue;
    }
    const first = hits[0];
    const lead = first.index > 0 ? line[first.index - 1] : '';
    if (first.index > 0 && !QUESTION_BREAK_PUNCT.test(lead)) {
      out.push(line);
      continue;
    }
    let last = 0;
    for (const hit of hits) {
      if (hit.index > last) {
        const part = line.slice(last, hit.index).trim();
        if (part) out.push(part);
      }
      last = hit.index;
    }
    const tail = line.slice(last).trim();
    if (tail) out.push(tail);
  }
  return out;
}

function providerOfState() {
  return (state.settings && state.settings.aiProvider) || 'mock';
}

function generationHint(ocrUsed) {
  const provider = providerOfState();
  const ocr = ocrUsed ? '如果这一节还没识别过，会先用本机 Windows OCR 读取页面，可能要几十秒到几分钟。' : '';
  if (provider === 'ollama') return `正在让本机模型读这一节的原文。第一次整理可能要一两分钟，可以先去右边提问。${ocr}`;
  if (provider === 'real') return `正在让远程模型读这一节的原文。这一节的文字会发送到设置里的接口，时间取决于网络。${ocr}`;
  return `正在按原文整理这一节的讲义，只在本机处理，不会联网。${ocr}`;
}

function pdfUrl(book, page) {
  const base = `/api/textbooks/${encodeURIComponent(book.id)}/file`;
  return page ? `${base}#page=${page}&zoom=page-width` : base;
}

// ================================================================ 目录

function buildToc(book, activeSectionId, { onNavigate, onClose }) {
  const total = book.sectionCount || 0;
  const done = book.progress ? book.progress.done || 0 : 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  const list = h('div.reader-toc-chapters');
  for (const [ci, chapter] of (book.chapters || []).entries()) {
    const active = (chapter.sections || []).some((s) => s.id === activeSectionId);
    const doneInChapter = (chapter.sections || []).filter((s) => s.done).length;
    const details = h('details.reader-toc-chapter', { open: active || ci === 0 }, [
      h('summary.reader-toc-chapter-head', {}, [
        h('span.reader-toc-chapter-no', {}, String(ci + 1)),
        h('span.reader-toc-chapter-title', {}, chapter.title),
        h('span.reader-toc-chapter-count', {},
          chapter.sections.length ? `${doneInChapter}/${chapter.sections.length}` : '—'),
      ]),
      h('div.reader-toc-sections', {}, (chapter.sections || []).map((section) =>
        h(`button.reader-toc-section${section.done ? '.done' : ''}${section.id === activeSectionId ? '.active' : ''}`, {
          type: 'button',
          onclick: () => onNavigate(section.id),
          title: `第 ${section.pageStart}–${section.pageEnd} 页`,
        }, [
          h('span.reader-toc-check', {}, section.done ? '✓' : ''),
          h('span.reader-toc-section-title', {}, section.title),
          section.demos && section.demos.length
            ? h('span.reader-toc-demo', { title: '这一节有辅助动画（放在讲义之后，可选）' }, '◉')
            : null,
        ])
      )),
    ]);
    list.appendChild(details);
  }

  return h('aside.reader-toc', {}, [
    h('div.reader-toc-top', {}, [
      h('div.reader-toc-label', {}, '目录'),
      onClose ? h('button.reader-toc-close', { type: 'button', onclick: onClose, 'aria-label': '收起目录' }, '×') : null,
    ]),
    h('div.reader-toc-progress', {}, [
      h('div.reader-toc-progress-row', {}, [
        h('span', {}, '已读'),
        h('b', {}, total ? `${done} / ${total}` : '—'),
      ]),
      h('div.progress', {}, [h('i', { style: { width: `${pct}%` } })]),
    ]),
    list,
  ]);
}

// ================================================================ 未就绪

function renderNotReady(root, ctx, book) {
  const status = book.status || 'imported';
  const title = status === 'analyzing'
    ? '这本书正在整理'
    : status === 'error'
      ? '上次没有整理完'
      : '还没有整理目录';

  const retry = async (btn) => {
    btn.disabled = true;
    btn.textContent = '整理中…';
    try {
      await api.analyzeTextbook(book.id);
      toast('整理好了，可以开始读。');
      await ctx.rerender();
    } catch (err) {
      toastError(err);
      btn.disabled = false;
      btn.textContent = '重试分析';
    }
  };

  root.appendChild(h('div.page', {}, [
    pageHead({
      kicker: '教材精读',
      title: book.title,
      sub: status === 'analyzing' ? '正在整理目录和章节框架…' : '文字已经保存在本地，还差一步。',
      actions: [
        h('button.btn.small.ghost', { onclick: () => ctx.navigate('/textbooks') }, '← 我的书架'),
      ],
    }),
    h('div.card', {}, [
      h('h3.mb1', {}, title),
      h('p.small.muted', {}, status === 'error'
        ? (book.statusMessage || '这次没有整理出章节框架。')
        : status === 'analyzing'
          ? '刷新一下页面就能看到最新状态。如果一直停在这里，可以重试分析。'
          : '教材的逐页文字已经提取并保存在本机。整理会把目录变成「章 → 节」的框架，之后就能按节阅读。'),
      status === 'error' && book.statusMessage
        ? h('div.notice.warm.mb2', {}, book.statusMessage)
        : null,
      h('div.btn-row.mt2', {}, [
        h('button.btn.primary', {
          onclick: (e) => retry(e.currentTarget),
        }, status === 'error' ? '重试分析' : '开始整理'),
      ]),
    ]),
  ]));
}

// ================================================================ 思维导图与术语

function mergeTerms(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const item of list || []) {
      const term = String(item && item.term || '').trim();
      const plain = String(item && item.plain || '').trim();
      if (!term || !plain) continue;
      const key = term.toLowerCase();
      const prev = map.get(key);
      if (prev) {
        if (!prev.example && item.example) prev.example = String(item.example).trim();
        if (!prev.subject && item.subject) prev.subject = String(item.subject).trim();
      } else {
        map.set(key, {
          term,
          plain,
          example: String(item.example || '').trim(),
          subject: String(item.subject || '').trim(),
        });
      }
    }
  }
  return [...map.values()].slice(0, 6);
}

function termCard(term) {
  return h('article.term-card', {}, [
    h('div.term-card-head', {}, [
      h('strong.term-card-title', {}, term.term),
      term.subject ? h('span.term-card-subject', {}, term.subject) : null,
    ]),
    h('p.term-card-plain', {}, term.plain),
    term.example
      ? h('div.term-card-example', {}, [
          h('span.term-card-example-label', {}, '生活里'),
          h('span', {}, term.example),
        ])
      : null,
  ]);
}

function termCards(terms, title = '先把这几个词弄懂') {
  if (!terms || !terms.length) return null;
  return h('div.reader-terms', {}, [
    h('div.reader-terms-head', {}, [
      h('h2', {}, title),
      h('span.count', {}, `${terms.length} 个`),
    ]),
    h('div.term-grid', {}, terms.map(termCard)),
  ]);
}

function renderMindMap(book, ctx) {
  const go = (sectionId) => ctx.navigate(`/textbook/${book.id}?sid=${encodeURIComponent(sectionId)}`);
  const root = h('div.mindmap-root', {}, [
    h('span.mindmap-root-kicker', {}, '全书脉络'),
    h('strong.mindmap-root-title', {}, book.title),
    h('span.mindmap-root-meta', {},
      `${book.pageCount || 0} 页 · ${book.chapterCount || 0} 章 · ${book.sectionCount || 0} 节`),
  ]);

  const branches = h('div.mindmap-branches');
  (book.chapters || []).forEach((chapter, ci) => {
    const sections = chapter.sections || [];
    const first = sections[0] || null;
    const doneCount = sections.filter((s) => s.done).length;
    const chapterBtn = h('button.mindmap-chapter', {
      type: 'button',
      disabled: first ? undefined : true,
      title: first ? `进入「${chapter.title}」` : '这一章没有可读小节',
      onclick: () => first && go(first.id),
    }, [
      h('span.mindmap-chapter-no', {}, String(ci + 1).padStart(2, '0')),
      h('span.mindmap-chapter-body', {}, [
        h('span.mindmap-chapter-title', {}, chapter.title),
        h('span.mindmap-chapter-meta', {},
          `第 ${chapter.pageStart}–${chapter.pageEnd} 页 · ${sections.length} 节`
          + (doneCount ? ` · 已读 ${doneCount}` : '')),
      ]),
      h('span.mindmap-chapter-go', {}, '→'),
    ]);

    branches.appendChild(h('div.mindmap-branch', {}, [
      h('span.mindmap-branch-dot'),
      h('div.mindmap-chapter-row', {}, [
        chapterBtn,
        book.hasFile
          ? h('a.mindmap-page-link', {
              href: pdfUrl(book, chapter.pageStart),
              target: '_blank',
              rel: 'noopener',
              title: `打开 PDF 第 ${chapter.pageStart} 页`,
            }, `P${chapter.pageStart}`)
          : null,
      ]),
      h('div.mindmap-sections', {}, sections.map((section) =>
        h(`button.mindmap-section${section.done ? '.done' : ''}`, {
          type: 'button',
          title: `第 ${section.pageStart}–${section.pageEnd} 页`,
          onclick: () => go(section.id),
        }, [
          h('span.mindmap-section-node'),
          h('span.mindmap-section-title', {}, section.title),
          section.done ? h('span.mindmap-section-done', {}, '✓') : null,
          section.demos && section.demos.length
            ? h('span.mindmap-section-demo', { title: '这一节有辅助动画' }, '◉')
            : null,
          h('span.mindmap-section-pages', {}, `${section.pageStart}–${section.pageEnd}`),
        ])
      )),
    ]));
  });

  return h('div.card.reader-mindmap-card', {}, [
    h('div.reader-mindmap-head', {}, [
      h('div', {}, [
        h('div.focus-kicker', {}, '这本书怎么展开'),
        h('h2', {}, '全书脉络'),
      ]),
      h('span.tiny.muted', {}, '点章节或小节，直接进入对应内容'),
    ]),
    h('div.mindmap', {}, [
      root,
      h('span.mindmap-trunk'),
      branches,
    ]),
  ]);
}

// ================================================================ 全书导览

function renderOverview(root, ctx, book) {
  const flat = flattenSections(book);
  const last = book.lastSectionId ? findSectionById(book, book.lastSectionId) : null;
  let shell = null;

  const closeToc = () => shell && shell.classList.remove('toc-open');
  const toc = buildToc(book, null, {
    onNavigate: (sid) => ctx.navigate(`/textbook/${book.id}?sid=${encodeURIComponent(sid)}`),
    onClose: closeToc,
  });

  const actions = [
    h('button.btn.small.ghost.reader-toc-toggle', {
      onclick: () => shell && shell.classList.toggle('toc-open'),
    }, '☰ 目录'),
  ];
  if (book.hasFile) {
    actions.push(h('a.btn.small.ghost', {
      href: pdfUrl(book), target: '_blank', rel: 'noopener',
    }, '打开 PDF'));
  }
  actions.push(h('button.btn.small.ghost', {
    onclick: () => ctx.navigate('/textbooks'),
  }, '我的书架'));
  if (last) {
    actions.push(h('button.btn.primary', {
      onclick: () => ctx.navigate(`/textbook/${book.id}?sid=${encodeURIComponent(last.section.id)}`),
    }, '继续上次阅读'));
  } else if (flat.length) {
    actions.push(h('button.btn.primary', {
      onclick: () => ctx.navigate(`/textbook/${book.id}?sid=${encodeURIComponent(flat[0].section.id)}`),
    }, '从第一节开始'));
  }

  const ocrNotice = book.ocrUsed
    ? h('div.notice.quiet.reader-ocr-notice', {}, [
        h('strong', {}, '正文由本机 Windows OCR 识别。'),
        h('span', {}, '公式、符号和分栏可能失真，讲义不会硬凑看不清的公式；重要内容请对照 PDF 原页。'),
      ])
    : null;

  const resumeCard = last ? h('div.card.reader-resume', {}, [
    h('div.reader-resume-mark', {}, '↳'),
    h('div.reader-resume-info', {}, [
      h('div.tiny.muted', {}, `上次读到 · ${fmtRelative(book.lastReadAt)}`),
      h('div.reader-resume-title', {}, last.section.title),
      h('div.tiny.muted', {}, last.chapter.title),
    ]),
    h('button.btn.small.primary', {
      onclick: () => ctx.navigate(`/textbook/${book.id}?sid=${encodeURIComponent(last.section.id)}`),
    }, '接着读 →'),
  ]) : null;

  const mindMap = renderMindMap(book, ctx);
  const terms = termCards(mergeTerms(book.terms || []), '这本书里值得先弄懂的词');

  shell = h('div.reader-shell.reader-overview-shell', {}, [
    toc,
    h('div.reader-main.reader-overview-main', {}, [
      resumeCard,
      ocrNotice,
      mindMap,
      terms,
    ]),
    h('div.reader-scrim', { onclick: closeToc }),
  ]);

  root.appendChild(h('div.page.reader-page', {}, [
    pageHead({
      kicker: '教材精读',
      title: book.title,
      sub: `${book.pageCount} 页 · ${book.chapterCount} 章 · ${book.sectionCount} 节`
        + (book.progress ? ` · 已读 ${book.progress.done || 0}/${book.progress.total || 0}` : ''),
      actions,
    }),
    shell,
  ]));
}

// ================================================================ 章节知识地图

function fallbackChapterMap(chapter) {
  return {
    provider: 'local',
    overview: '',
    thread: [],
    note: '这一章还没有生成知识地图，先按小节标题阅读。',
    nodes: (chapter.sections || []).map((section) => ({
      sectionId: section.id,
      title: section.title,
      pages: `${section.pageStart}–${section.pageEnd}`,
      points: (section.lesson && section.lesson.keyPoints || []).slice(0, 3)
        .concat((section.subsections || []).slice(0, 3).map((x) => x.title))
        .slice(0, 3),
    })),
  };
}

function chapterMapFor(book, chapter) {
  const map = book.chapterGuides && book.chapterGuides[chapter.id];
  return map && Array.isArray(map.nodes) ? map : fallbackChapterMap(chapter);
}

function renderChapterMap(book, chapter, activeSectionId, { onNavigate, open }) {
  const map = chapterMapFor(book, chapter);
  const chapterIndex = (book.chapters || []).findIndex((c) => c.id === chapter.id);
  const nodes = map.nodes || [];
  const pointCount = nodes.reduce((n, node) => n + (node.points || []).length, 0);
  const first = (chapter.sections || [])[0];

  const body = h('div.chapter-map-body', {}, [
    map.overview ? h('p.chapter-map-overview', {}, map.overview) : null,
    map.thread && map.thread.length
      ? h('div.chapter-map-thread', {}, [
          h('span.chapter-map-thread-label', {}, '本章主线'),
          h('span', {}, map.thread.slice(0, 3).join('；')),
        ])
      : null,
    h('div.chapter-map-layout', {}, [
      h('div.chapter-map-root', {}, [
        h('span.chapter-map-root-kicker', {}, 'CHAPTER'),
        h('strong', {}, chapter.title),
        h('span.chapter-map-root-meta', {},
          `第 ${chapter.pageStart}–${chapter.pageEnd} 页 · ${nodes.length} 节`),
        first
          ? h('button.chapter-map-root-go', {
              type: 'button',
              onclick: () => onNavigate(first.id),
            }, '从第一节开始 →')
          : null,
      ]),
      h('div.chapter-map-branches', {}, nodes.map((node, i) => {
        const active = node.sectionId === activeSectionId;
        const points = node.points || [];
        return h(`button.chapter-map-node${active ? '.active' : ''}`, {
          type: 'button',
          onclick: () => onNavigate(node.sectionId),
          title: `进入「${node.title}」`,
        }, [
          h('span.chapter-map-node-head', {}, [
            h('span.chapter-map-node-no', {}, String(i + 1).padStart(2, '0')),
            h('span.chapter-map-node-title', {}, node.title),
            h('span.chapter-map-node-pages', {}, node.pages),
          ]),
          points.length
            ? h('ul.chapter-map-points', {}, points.map((point) => h('li', {}, point)))
            : h('span.chapter-map-empty', {}, '这一节以原文图示为主'),
          h('span.chapter-map-node-go', {}, active ? '正在读这一节' : '读这一节 →'),
        ]);
      })),
    ]),
    h('div.chapter-map-note', {}, [
      map.note || '',
      map.provider && map.provider !== 'local' ? ` · ${engineLabel(map.provider)}` : '',
    ].join('')),
  ]);

  return h('details.chapter-map-card', { open: open || undefined }, [
    h('summary.chapter-map-summary', {}, [
      h('span.chapter-map-summary-main', {}, [
        h('span.chapter-map-kicker', {}, `第 ${chapterIndex + 1} 章 · 本章知识地图`),
        h('strong.chapter-map-summary-title', {}, chapter.title),
      ]),
      h('span.chapter-map-summary-meta', {}, `${nodes.length} 节 · ${pointCount} 个知识点`),
    ]),
    body,
  ]);
}

// ================================================================ 单节阅读

function renderSection(root, ctx, book, hit, flat, index) {
  const { chapter, section } = hit;
  const next = flat[index + 1] || null;
  const prev = flat[index - 1] || null;
  let chatMessages = [];
  let currentLesson = section.lesson || null;
  let sectionTextInfo = null;
  let sectionTerms = [];
  let alive = true;
  const demoCleanups = [];
  let shell = null;
  let pdfLoaded = false;
  let lessonBusy = false;

  const closeToc = () => shell && shell.classList.remove('toc-open');
  const go = (sid) => {
    if (!alive) return;
    ctx.navigate(`/textbook/${book.id}?sid=${encodeURIComponent(sid)}`);
  };
  const goOverview = () => ctx.navigate(`/textbook/${book.id}`);

  // ---------------------------------------------------------------- 目录与框架

  const toc = buildToc(book, section.id, { onNavigate: go, onClose: closeToc });
  const tocProgressBar = toc.querySelector('.reader-toc-progress .progress > i');
  const tocProgressText = toc.querySelector('.reader-toc-progress b');
  const tocSectionButton = toc.querySelector(`.reader-toc-section.active`);
  const tocCheck = tocSectionButton ? tocSectionButton.querySelector('.reader-toc-check') : null;

  // ---------------------------------------------------------------- 头部操作

  const doneBtn = h(`button.btn.small${section.done ? '.ghost' : '.primary'}`, {
    onclick: async () => {
      if (doneBtn.disabled) return;
      const nextDone = !section.done;
      doneBtn.disabled = true;
      try {
        const res = await api.patchTextbookSection(book.id, section.id, { done: nextDone });
        if (!alive) return;
        section.done = res.section.done;
        paintDoneState(res.book);
        toast(nextDone ? '这一节读完了。' : '已经改回未读。');
      } catch (err) {
        if (alive) toastError(err);
      } finally {
        if (alive) doneBtn.disabled = false;
      }
    },
  }, section.done ? '✓ 已读' : '标记为已读');

  function paintDoneState(summary) {
    doneBtn.textContent = section.done ? '✓ 已读' : '标记为已读';
    doneBtn.classList.toggle('primary', !section.done);
    doneBtn.classList.toggle('ghost', section.done);
    if (tocSectionButton) tocSectionButton.classList.toggle('done', section.done);
    if (tocCheck) tocCheck.textContent = section.done ? '✓' : '';
    const chapterNodes = toc.querySelectorAll('.reader-toc-chapter');
    (book.chapters || []).forEach((chapter, i) => {
      const countEl = chapterNodes[i] && chapterNodes[i].querySelector('.reader-toc-chapter-count');
      if (!countEl) return;
      const doneInChapter = (chapter.sections || []).filter((s) => s.done).length;
      countEl.textContent = `${doneInChapter}/${chapter.sections.length}`;
    });
    if (summary) {
      const total = summary.progress.total || 0;
      const d = summary.progress.done || 0;
      const pct = total ? Math.round((d / total) * 100) : 0;
      if (tocProgressBar) tocProgressBar.style.width = `${pct}%`;
      if (tocProgressText) tocProgressText.textContent = total ? `${d} / ${total}` : '—';
    }
    if (nextBtn) {
      nextBtn.classList.toggle('primary', Boolean(section.done && next));
      nextBtn.classList.toggle('ghost', !(section.done && next));
    }
  }

  const actions = [
    h('button.btn.small.ghost.reader-toc-toggle', {
      onclick: () => shell && shell.classList.toggle('toc-open'),
    }, '☰ 目录'),
    doneBtn,
  ];
  if (book.hasFile) {
    actions.push(h('a.btn.small.ghost', {
      href: pdfUrl(book, section.pageStart), target: '_blank', rel: 'noopener',
    }, '打开 PDF'));
  }
  actions.push(h('button.btn.small.ghost.reader-chat-jump', {
    type: 'button',
    onclick: () => {
      const panel = root.querySelector('.reader-chat');
      if (!panel) return;
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      chatInput.focus({ preventScroll: true });
    },
  }, '问这一节 →'));

  // ---------------------------------------------------------------- 动画（讲义之后的辅助）

  const demoEntries = [];
  for (const demoId of section.demos || []) {
    const info = demoInfo(demoId);
    if (!info) continue;
    const demoHost = h('div.reader-demo-stage');
    const card = h('div.card.reader-demo', {}, [
      h('div.reader-demo-head', {}, [
        h('div', {}, [
          h('div.focus-kicker', {}, '辅助理解 · 可选'),
          h('h3', {}, info.title),
          info.description ? h('p.small.muted.mb0', {}, info.description) : null,
          info.concept ? h('div.reader-demo-concept', {}, `只对应本节的一个点：${info.concept}`) : null,
        ]),
        h('span.reader-demo-tag', {}, '文字讲义为主'),
      ]),
      demoHost,
      info.hint ? h('div.tiny.muted.mt2', {}, info.hint) : null,
    ]);
    demoEntries.push({ id: demoId, host: demoHost, card });
  }

  // 动画默认不加载：讲义和原文才是主体，只有用户主动展开时才挂载。
  let demosMounted = false;
  function mountDemos() {
    if (demosMounted) return;
    demosMounted = true;
    for (const entry of demoEntries) {
      try {
        const cleanup = mountDemo(entry.id, entry.host);
        if (typeof cleanup === 'function') demoCleanups.push(cleanup);
      } catch (err) {
        console.error('动画演示加载失败', err);
        entry.host.appendChild(h('div.notice.warm', {}, `这个演示没能加载：${err.message || err}`));
      }
    }
  }

  const demoDetails = demoEntries.length
    ? h('details.reader-demo-details', {}, [
        h('summary.reader-demo-summary', {}, [
          h('span.reader-demo-summary-text', {}, [
            h('span.reader-demo-summary-kicker', {}, '辅助理解 · 可选'),
            h('span.reader-demo-summary-title', {},
              demoEntries.map((entry) => demoInfo(entry.id).title).join(' / ')),
          ]),
          h('span.reader-demo-summary-note', {}, '先读讲义；动画只补充一个概念'),
        ]),
        h('div.reader-demos', {}, demoEntries.map((entry) => entry.card)),
      ])
    : null;
  if (demoDetails) {
    demoDetails.addEventListener('toggle', () => {
      if (demoDetails.open) mountDemos();
    });
  }

  // ---------------------------------------------------------------- 讲义 / 原文 / PDF

  const providerChipHost = h('span');
  const sourceChipHost = h('span');
  const refreshBtn = h('button.btn.small.ghost', {
    onclick: () => loadLesson(true),
    title: '重新生成这一节的讲义',
  }, '重新生成');

  const textInfoHost = h('div.reader-textinfo');
  const lessonHost = h('div.reader-lesson-body');
  const termHost = h('div.reader-lesson-terms');
  const textHost = h('div.reader-text-body');
  const pdfHost = h('div.reader-pdf-body');

  const lessonPanel = h('div.reader-panel', {}, [lessonHost, termHost]);
  const textPanel = h('div.reader-panel', { hidden: true }, [textHost]);
  const pdfPanel = h('div.reader-panel', { hidden: true }, [pdfHost]);

  const tabs = [
    { id: 'lesson', label: '讲义' },
    { id: 'text', label: '教材原文' },
  ];
  if (book.hasFile) tabs.push({ id: 'pdf', label: 'PDF 原页' });
  const tabButtons = new Map();

  const tabBar = h('div.reader-tabs', { role: 'tablist' }, tabs.map((t) => {
    const btn = h(`button.reader-tab${t.id === 'lesson' ? '.active' : ''}`, {
      type: 'button',
      role: 'tab',
      'aria-selected': t.id === 'lesson' ? 'true' : 'false',
      onclick: () => switchTab(t.id),
    }, t.label);
    tabButtons.set(t.id, btn);
    return btn;
  }));

  function switchTab(id) {
    for (const [key, btn] of tabButtons) {
      btn.classList.toggle('active', key === id);
      btn.setAttribute('aria-selected', key === id ? 'true' : 'false');
    }
    lessonPanel.hidden = id !== 'lesson';
    textPanel.hidden = id !== 'text';
    pdfPanel.hidden = id !== 'pdf';
    if (id === 'pdf' && !pdfLoaded) loadPdf();
  }

  function providerBadge(provider) {
    return chip(engineLabel(provider), { tone: provider === 'local' ? '' : 'accent' });
  }

  function paintProvider() {
    clear(providerChipHost);
    if (currentLesson) providerChipHost.appendChild(providerBadge(currentLesson.provider));
  }

  function paintTextInfo(info) {
    if (info) sectionTextInfo = info;
    const current = sectionTextInfo;
    clear(textInfoHost);
    clear(sourceChipHost);
    if (!current) return;

    const ocr = current.source === 'ocr' || current.source === 'mixed';
    const unreadable = (current.unreadablePages || []).length;
    if (current.source === 'none' || ocr || unreadable) {
      const tone = current.source === 'none' || unreadable ? 'warm' : 'quiet';
      textInfoHost.appendChild(h(`div.notice.${tone}.reader-ocr-banner`, {}, [
        h('strong', {}, current.source === 'none'
          ? '这一节没有可靠的原文'
          : ocr ? '这一节用了本机 OCR' : '部分页面没有可靠文字'),
        current.note ? h('div.small.mt1', {}, current.note) : null,
      ]));
    }
    if (ocr || current.source === 'none') {
      sourceChipHost.appendChild(chip(
        TEXT_SOURCE_LABEL[current.source],
        { tone: ocr ? 'accent' : 'warm', title: current.note || '' }
      ));
    }
  }

  function paintTerms() {
    clear(termHost);
    const merged = mergeTerms(sectionTerms, currentLesson && currentLesson.terms);
    const node = termCards(merged, '这一节的词，用大白话讲');
    if (node) termHost.appendChild(node);
  }

  function lessonLoading() {
    clear(lessonHost);
    lessonHost.appendChild(h('div.reader-lesson-loading', {}, [
      h('div.reader-lesson-spinner'),
      h('div', {}, [
        h('strong', {}, '正在整理这一节的讲义'),
        h('p.small.muted.mb0', {}, generationHint(book.ocrUsed)),
      ]),
    ]));
  }

  function paintLesson(lesson) {
    clear(lessonHost);
    if (!lesson) {
      lessonHost.appendChild(h('div.notice.warm', {}, '这一节还没有讲义。可以点「重新生成」再试一次。'));
      return;
    }

    if (lesson.position) {
      lessonHost.appendChild(h('div.reader-position', {}, [
        h('span.reader-position-label', {}, '在整章里的位置'),
        h('div.reader-position-text', {}, renderMarkdown(lesson.position)),
      ]));
    }

    if (lesson.overview) {
      lessonHost.appendChild(h('div.reader-lesson-overview', {}, renderMarkdown(lesson.overview)));
    }

    const thread = Array.isArray(lesson.thread) ? lesson.thread : [];
    if (thread.length) {
      lessonHost.appendChild(h('div.reader-thread-block', {}, [
        h('div.reader-thread-head', {}, [
          h('span', {}, '顺着这条线读'),
          h('span.count', {}, `${thread.length} 步`),
        ]),
        h('ol.reader-thread', {}, thread.map((step, i) => h('li.reader-thread-step', {}, [
          h('span.reader-thread-no', {}, String(i + 1).padStart(2, '0')),
          h('div.reader-thread-body', {}, [
            h('h3.reader-thread-title', {}, step.title),
            h('div.reader-thread-prose', {}, renderMarkdown(step.body)),
          ]),
        ]))),
      ]));
    }

    const threadText = thread
      .map((step) => `${step.title} ${step.body}`)
      .join(' ')
      .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
    const extraKeyPoints = (lesson.keyPoints || []).filter((point) => {
      const key = String(point || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
      if (!key || key.length < 8 || !threadText) return Boolean(key);
      const head = key.slice(0, Math.min(key.length, 14));
      return !threadText.includes(head);
    });
    if (extraKeyPoints.length) {
      lessonHost.appendChild(h('div.reader-lesson-section.reader-keypoint-block', {}, [
        h('h4', {}, extraKeyPoints.length > 1 ? '读完要能说出这几句' : '再多记一句'),
        h('ul.reader-keypoints', {}, extraKeyPoints.map((k) => h('li', {}, renderMarkdown(k)))),
      ]));
    }

    const threadTitles = new Set(thread.map((step) => step.title));
    for (const block of lesson.blocks || []) {
      if (block.heading && threadTitles.has(block.heading)) continue;
      lessonHost.appendChild(h('div.reader-lesson-section', {}, [
        block.heading ? h('h4', {}, block.heading) : null,
        h('div.reader-lesson-prose', {}, renderMarkdown(block.body)),
      ]));
    }

    if (lesson.example) {
      lessonHost.appendChild(h('div.reader-example', {}, [
        h('div.reader-example-label', {}, '例子'),
        h('div', {}, renderMarkdown(lesson.example)),
      ]));
    }

    if (lesson.pitfalls && lesson.pitfalls.length) {
      lessonHost.appendChild(h('div.reader-lesson-section.reader-pitfalls', {}, [
        h('h4', {}, '容易卡住的地方'),
        h('ul', {}, lesson.pitfalls.map((p) => h('li', {}, p))),
      ]));
    }

    if (lesson.summary) {
      lessonHost.appendChild(h('div.reader-summary', {}, [
        h('span', {}, '一句话'),
        h('div', {}, renderMarkdown(lesson.summary)),
      ]));
    }

    if (lesson.questions && lesson.questions.length) {
      lessonHost.appendChild(h('div.reader-lesson-section', {}, [
        h('h4', {}, '合上讲义，自测一下'),
        h('div.reader-question-list', {}, lesson.questions.map((q) => {
          const parts = splitQuestionLines(q);
          const textNode = h('span.reader-question-text', {}, parts.flatMap((part, i) =>
            (i ? [h('br'), part] : [part])
          ));
          return h('button.reader-question', {
            type: 'button',
            title: '把这个问题发给本节 AI 助教',
            onclick: () => askQuestion(q),
          }, [textNode, h('span.reader-question-go', {}, '问 AI →')]);
        })),
      ]));
    }

    if (lesson.warning) {
      lessonHost.appendChild(h('div.notice.quiet.mt3.mb0', {}, lesson.warning));
    }

    lessonHost.appendChild(h('div.reader-lesson-meta', {}, [
      h('span', {}, `${engineLabel(lesson.provider)}${lesson.model ? ` · ${lesson.model}` : ''}`),
      h('span', {}, lesson.generatedAt ? `生成于 ${fmtDateTime(lesson.generatedAt)}` : ''),
    ]));
    paintProvider();
    paintTerms();
  }

  async function loadLesson(refresh) {
    if (lessonBusy) return;
    lessonBusy = true;
    refreshBtn.disabled = true;
    refreshBtn.textContent = refresh ? '生成中…' : '整理中…';
    if (!currentLesson) lessonLoading();
    try {
      const res = await api.explainTextbookSection(book.id, section.id, Boolean(refresh));
      if (!alive) return;
      currentLesson = res.lesson;
      if (res.textInfo) paintTextInfo(res.textInfo);
      if (res.terms) sectionTerms = res.terms;
      paintLesson(currentLesson);
      if (refresh) toast('讲义已经重新整理好了。');
    } catch (err) {
      if (!alive) return;
      clear(lessonHost);
      lessonHost.appendChild(h('div.reader-lesson-error', {}, [
        h('div.notice.warm', {}, [
          h('strong', {}, '这次没有生成讲义。'),
          h('div.small.mt1', {}, err.message || String(err)),
        ]),
        h('div.btn-row', {}, [
          h('button.btn.primary.small', { onclick: () => loadLesson(true) }, '再试一次'),
          h('button.btn.small.ghost', { onclick: () => switchTab('text') }, '先读原文'),
        ]),
      ]));
      if (refresh) toastError(err);
    } finally {
      lessonBusy = false;
      refreshBtn.disabled = false;
      refreshBtn.textContent = '重新生成';
    }
  }

  // ---------------------------------------------------------------- 原文

  function paintText(pages, info) {
    clear(textHost);
    if (!pages.length) {
      textHost.appendChild(h('div.notice.quiet', {}, '这一节的页码范围内没有提取到文字。'));
      return;
    }
    const current = info || sectionTextInfo;
    const unreadable = pages.filter((p) => p.readable === false).length;
    const ocrCount = pages.filter((p) => p.source === 'ocr').length;
    textHost.appendChild(h('div.reader-text-note', {}, [
      h('span', {}, `第 ${section.pageStart}–${section.pageEnd} 页 · ${pages.length} 页`),
      ocrCount ? h('span.tiny.muted', {}, `其中 ${ocrCount} 页由本机 OCR 识别`) : null,
      unreadable ? h('span.tiny.muted', {}, `其中 ${unreadable} 页没有可靠文字`) : null,
      current && current.usable === false ? h('span.tiny.reader-text-warn', {}, '本节没有可用于讲义的原文') : null,
      book.hasFile
        ? h('a.tiny.reader-inline-link', {
            href: pdfUrl(book, section.pageStart), target: '_blank', rel: 'noopener',
          }, '对照 PDF 原页 →')
        : null,
    ]));
    for (const page of pages) {
      const text = String(page.text || '').trim();
      const readable = page.readable !== false;
      textHost.appendChild(h(`div.reader-text-page${readable ? '' : '.unreadable'}`, {}, [
        h('div.reader-text-page-no', {}, [
          `第 ${page.page} 页`,
          page.source === 'ocr' ? h('span.reader-page-source', {}, '本机 OCR') : null,
        ]),
        text && readable
          ? h('div.reader-text-content', {}, page.text)
          : h('div.reader-text-empty', {}, readable
              ? '这一页没有提取到文字（可能是整页图片或图表）。'
              : '这一页没有可靠文字（可能是扫描图、整页公式或页码区间偏了），没有用于生成讲义。可以对照 PDF 原页阅读。'),
      ]));
    }
    const sourceNote = current && (current.source === 'ocr' || current.source === 'mixed')
      ? '文字由本机 Windows OCR 识别，公式、符号和分栏可能失真。'
      : '文字由 PDF.js 在浏览器里提取，公式、分栏和图表可能失真。';
    textHost.appendChild(h('div.reader-text-foot', {}, [
      `${sourceNote}重要结论请对照 PDF。`,
    ]));
  }

  function loadPdf() {
    pdfLoaded = true;
    clear(pdfHost);
    pdfHost.appendChild(h('iframe.reader-pdf-frame', {
      src: pdfUrl(book, section.pageStart),
      title: `${book.title} 原始 PDF`,
    }));
    pdfHost.appendChild(h('div.tiny.muted.mt1', {}, [
      '浏览器内置的 PDF 阅读器。如果显示空白，说明这份 PDF 没有成功保存在本地，或浏览器禁用了内置阅读器。 ',
      h('a.reader-inline-link', {
        href: pdfUrl(book, section.pageStart), target: '_blank', rel: 'noopener',
      }, '在新标签打开 →'),
    ]));
  }

  // ---------------------------------------------------------------- 问答

  const aiProvider = providerOfState();
  const chatList = h('div.reader-chat-list');
  const chatInput = h('textarea.reader-chat-input', {
    rows: 2,
    placeholder: '问这一节的问题…（Ctrl + Enter 发送）',
    onkeydown: (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        sendChat();
      }
    },
  });
  const chatSendBtn = h('button.btn.primary.small', { onclick: () => sendChat() }, '发送');
  let sending = false;
  let sendError = null;
  let lastQuestion = '';

  const diagramStates = new Map();

  const SUGGESTIONS = [
    '用更简单的话讲一遍这一节',
    '这一节最重要的概念是什么？',
    '给我一个具体的例子',
    '出两道自测题',
  ];

  const suggestionRow = h('div.reader-chat-suggestions', {}, SUGGESTIONS.map((q) =>
    h('button.reader-chat-chip', {
      type: 'button',
      onclick: () => {
        chatInput.value = q;
        chatInput.focus();
      },
    }, q)
  ));

  function scrollChat() {
    requestAnimationFrame(() => {
      chatList.scrollTop = chatList.scrollHeight;
    });
  }

  function diagramCard(diagram) {
    return h('div.reader-diagram', {}, [
      h('div.reader-diagram-head', {}, [
        h('span.reader-diagram-kicker', {}, '图解'),
        h('strong.reader-diagram-title', {}, diagram.title),
      ]),
      h('ol.reader-diagram-flow', {}, diagram.steps.map((step) =>
        h('li.reader-diagram-step', {}, [
          h('span.reader-diagram-label', {}, step.label),
          step.detail ? h('span.reader-diagram-detail', {}, step.detail) : null,
        ])
      )),
      diagram.note ? h('div.reader-diagram-note', {}, diagram.note) : null,
      diagram.warning ? h('div.tiny.reader-msg-warning', {}, diagram.warning) : null,
      h('div.reader-diagram-meta', {},
        `${engineLabel(diagram.provider)}${diagram.model ? ` · ${diagram.model}` : ''}`),
    ]);
  }

  async function loadDiagram(key, question) {
    const current = diagramStates.get(key);
    if (current && current.loading) return;
    diagramStates.set(key, { loading: true });
    paintChat();
    try {
      const res = await api.diagramTextbookSection(book.id, section.id, question || section.title);
      if (!alive) return;
      diagramStates.set(key, { data: res.diagram });
    } catch (err) {
      if (!alive) return;
      diagramStates.set(key, { error: err.message || String(err) });
    }
    paintChat();
  }

  function assistantTools(msg, question, key) {
    if (!msg.id) return null;
    const query = studySearchQuery(question, section.title);
    const biliQuery = `${query} 课程`.trim();
    const xhsQuery = `${query} 学习笔记`.trim();
    const state = diagramStates.get(key) || {};
    const tools = h('div.reader-msg-tools', {}, [
      h('button.reader-msg-tool', {
        type: 'button',
        disabled: Boolean(state.loading),
        title: '把这个问题整理成一张流程图',
        onclick: () => loadDiagram(key, question),
      }, state.loading ? '正在图解…' : '✎ 图解一下'),
      h('a.reader-msg-tool', {
        href: `${BILIBILI_SEARCH}${encodeURIComponent(biliQuery)}`,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: `在新标签打开 B 站搜索：${biliQuery}`,
      }, 'B站找课 ↗'),
      h('a.reader-msg-tool', {
        href: `${XHS_SEARCH}${encodeURIComponent(xhsQuery)}`,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: `在新标签打开小红书搜索：${xhsQuery}`,
      }, '小红书搜笔记 ↗'),
    ]);

    const extra = [];
    if (state.loading) {
      extra.push(h('div.reader-diagram-loading', {}, '正在把这个问题画成一步一步的流程图…'));
    } else if (state.error) {
      extra.push(h('div.reader-diagram-error', {}, `图解没有生成：${state.error}`));
    } else if (state.data) {
      extra.push(diagramCard(state.data));
    }
    return h('div.reader-msg-tools-wrap', {}, [tools, ...extra]);
  }

  function chatMessageNode(msg, question = '', key = '') {
    if (msg.role === 'user') {
      return h('div.reader-msg.user', {}, [
        h('div.reader-msg-bubble', {}, String(msg.content || '')),
      ]);
    }
    return h('div.reader-msg.assistant', {}, [
      h('div.reader-msg-meta', {}, [
        h('span.reader-msg-engine', {}, engineLabel(msg.provider)),
        msg.createdAt ? h('span.tiny.muted', {}, fmtRelative(msg.createdAt)) : null,
      ]),
      h('div.reader-msg-bubble', {}, renderMarkdown(msg.content)),
      msg.warning ? h('div.tiny.reader-msg-warning', {}, msg.warning) : null,
      assistantTools(msg, question, key),
    ]);
  }

  function paintChat() {
    clear(chatList);
    if (!chatMessages.length && !sending) {
      chatList.appendChild(h('div.reader-chat-empty', {}, [
        h('div.reader-chat-empty-mark', {}, '◌'),
        h('div', {}, '这一节还没有提问。'),
        h('div.tiny.muted', {}, '问题只会带上这一节相关的原文，不会把整本书发出去。'),
      ]));
    }
    let promptQuestion = '';
    chatMessages.forEach((msg, i) => {
      if (msg.role === 'user') promptQuestion = String(msg.content || '');
      const key = msg.role === 'assistant' ? (msg.id || `assistant-${i}`) : '';
      chatList.appendChild(chatMessageNode(msg, promptQuestion, key));
    });
    if (sending) {
      chatList.appendChild(h('div.reader-msg.assistant', {}, [
        h('div.reader-msg-meta', {}, [h('span.reader-msg-engine', {}, engineLabel(aiProvider === 'mock' ? 'local' : aiProvider))]),
        h('div.reader-msg-thinking', {}, [h('i'), h('i'), h('i'), h('span', {}, '正在看这一节的原文…')]),
      ]));
    }
    if (sendError) {
      chatList.appendChild(h('div.reader-chat-error', {}, [
        h('span', {}, sendError),
        lastQuestion
          ? h('button.btn.small.ghost', {
              onclick: () => {
                chatInput.value = lastQuestion;
                sendChat();
              },
            }, '重试')
          : null,
      ]));
    }
    scrollChat();
  }

  async function sendChat() {
    const question = chatInput.value.trim();
    if (!question) {
      toast('先写一个问题吧。', 'warn');
      chatInput.focus();
      return;
    }
    if (sending) return;
    sending = true;
    sendError = null;
    lastQuestion = question;
    chatInput.value = '';
    chatSendBtn.disabled = true;
    chatSendBtn.textContent = '思考中…';
    chatMessages = [...chatMessages, { role: 'user', content: question }];
    paintChat();
    try {
      const res = await api.chatTextbookSection(book.id, section.id, question);
      if (!alive) return;
      chatMessages = res.chat || [...chatMessages, res.answer];
      paintChat();
    } catch (err) {
      if (!alive) return;
      sendError = err.message || String(err);
      chatInput.value = question;
      paintChat();
    } finally {
      if (alive) {
        sending = false;
        chatSendBtn.disabled = false;
        chatSendBtn.textContent = '发送';
        paintChat();
      }
    }
  }

  function askQuestion(question) {
    chatInput.value = question;
    chatInput.focus();
    chatInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const chatPanel = h('aside.reader-chat', {}, [
    h('div.reader-chat-head', {}, [
      h('div', {}, [
        h('div.focus-kicker', {}, '本节问答'),
        h('h3', {}, '卡住的地方，直接问'),
      ]),
      chip(ENGINE_LABEL[aiProvider] || '本地原文整理', { tone: aiProvider === 'mock' ? '' : 'accent' }),
    ]),
    chatList,
    suggestionRow,
    h('div.reader-chat-compose', {}, [
      chatInput,
      h('div.reader-chat-actions', {}, [
        h('span.tiny.muted', {}, '只根据这一节回答'),
        chatSendBtn,
      ]),
    ]),
    h('div.reader-chat-foot', {}, aiProvider === 'real'
      ? '问题会连同这一节的相关段落发送到设置里的远程接口。'
      : aiProvider === 'ollama'
        ? '问题会交给本机 Ollama 处理，不会离开这台电脑。'
        : '当前用本地原文检索回答，不会联网。'),
  ]);

  // ---------------------------------------------------------------- 底部导航

  const prevBtn = prev ? h('button.btn.small.ghost', {
    onclick: () => go(prev.section.id),
  }, `← ${prev.section.title}`) : h('span');

  const nextBtn = next ? h(`button.btn.small${section.done ? '.primary' : '.ghost'}`, {
    onclick: () => go(next.section.id),
  }, `${next.section.title} →`) : null;

  const foot = h('div.reader-nav-foot', {}, [
    prevBtn,
    h('div.reader-nav-mid', {}, [
      h('button.btn.small.ghost', { onclick: goOverview }, '回到目录导览'),
    ]),
    nextBtn || h('span.tiny.muted', {}, '这是最后一节了。'),
  ]);

  // ---------------------------------------------------------------- 组装

  const chapterMap = renderChapterMap(book, chapter, section.id, {
    onNavigate: go,
    open: Boolean(((chapter.sections || [])[0] || {}).id === section.id),
  });

  shell = h('div.reader-shell', {}, [
    toc,
    h('div.reader-main.reader-section-main', {}, [
      chapterMap,
      h('div.card.reader-lesson-card', {}, [
        h('div.reader-lesson-head', {}, [
          h('div', {}, [
            h('div.focus-kicker', {}, '本节精读'),
            h('div.reader-lesson-sub', {}, [
              `第 ${section.pageStart}–${section.pageEnd} 页`,
              section.wholeChapter ? ' · 整章作为一个阅读单元' : '',
              (section.subsections || []).length
                ? ` · 含 ${section.subsections.length} 个小标题`
                : '',
            ]),
          ]),
          h('div.reader-lesson-tools', {}, [sourceChipHost, providerChipHost, refreshBtn]),
        ]),
        textInfoHost,
        tabBar,
        lessonPanel,
        textPanel,
        pdfPanel,
      ]),
      demoDetails,
      foot,
    ]),
    chatPanel,
    h('div.reader-scrim', { onclick: closeToc }),
  ]);

  root.appendChild(h('div.page.reader-page', {}, [
    pageHead({
      kicker: book.title,
      title: section.title,
      sub: `${chapter.title} · 第 ${section.pageStart}–${section.pageEnd} 页`,
      compact: true,
      actions,
    }),
    shell,
  ]));

  // ---------------------------------------------------------------- 首屏数据

  paintChat();
  if (currentLesson) paintLesson(currentLesson);
  else loadLesson(false);

  api.getTextbookSection(book.id, section.id).then((payload) => {
    if (!alive) return;
    if (payload.textInfo) paintTextInfo(payload.textInfo);
    if (payload.terms) sectionTerms = payload.terms;
    paintText(payload.pages || [], payload.textInfo);
    if (payload.lesson && !currentLesson) {
      currentLesson = payload.lesson;
      paintLesson(currentLesson);
    } else if (sectionTerms.length) {
      paintTerms();
    }
    chatMessages = payload.chat || [];
    paintChat();
  }).catch((err) => {
    if (!alive) return;
    clear(textHost);
    textHost.appendChild(h('div.notice.warm', {}, `原文没有读出来：${err.message || err}`));
  });

  return () => {
    alive = false;
    for (const cleanup of demoCleanups) {
      try { cleanup(); } catch (err) { console.error('清理动画失败', err); }
    }
  };
}

// ================================================================ 入口

export default async function renderTextbook(root, ctx) {
  const bookId = ctx.args.id;
  let book;
  try {
    book = await api.getTextbook(bookId);
  } catch (err) {
    root.appendChild(h('div.page', {}, [
      pageHead({
        kicker: '教材精读',
        title: '这本书打不开',
        sub: err.message || String(err),
        actions: [h('button.btn.small.ghost', { onclick: () => ctx.navigate('/textbooks') }, '← 我的书架')],
      }),
      emptyState({
        icon: '▤',
        title: '教材可能已经被删除了',
        hint: '回到书架看看还在不在。',
        actionLabel: '回到书架',
        onAction: () => ctx.navigate('/textbooks'),
      }),
    ]));
    return;
  }

  if (book.status !== 'ready' || !book.chapters || !book.chapters.length) {
    renderNotReady(root, ctx, book);
    return;
  }

  const flat = flattenSections(book);
  const sid = ctx.args.sid;
  let hit = sid ? findSectionById(book, sid) : null;
  if (sid && !hit) toast('没找到这一节，先看全书导览。', 'warn');

  if (!hit) {
    renderOverview(root, ctx, book);
    return;
  }

  const index = flat.findIndex((x) => x.section.id === hit.section.id);
  return renderSection(root, ctx, book, hit, flat, index);
}
