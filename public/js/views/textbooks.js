/**
 * 教材书架
 * ---------------------------------------------------------------
 * 导入在浏览器里完成文字提取，服务端保存并整理框架。
 * 文字层不可读时，服务端用 Windows 本机 OCR 识别目录和正文，并如实标注来源。
 *
 * 版式按图书馆卡片目录收敛：大标题、细线分隔、深色表头，
 * 每本教材是一行目录记录；导入按钮和拖拽入口都收在页头附近。
 */

import { api } from '../api.js';
import {
  h, toast, toastError, confirmDialog, emptyState, fmtRelative,
} from '../ui.js';
import { state } from '../state.js';
import { importTextbookFromFile, formatBytes } from '../pdf-import.js';

const STATUS_LABEL = {
  imported: '待整理',
  analyzing: '整理中',
  ready: '可阅读',
  error: '整理失败',
};

const OCR_ERROR_TITLE = {
  'ocr-no-pdf': '文字层不可读，也找不到原始 PDF',
  'ocr-empty': '本机 OCR 没有识别出文字',
};

const STEPS = [
  { key: 'read', label: '读取 PDF' },
  { key: 'extract', label: '提取文字' },
  { key: 'save', label: '保存教材' },
  { key: 'upload', label: '保存原始 PDF' },
  { key: 'analyze', label: '整理目录 / OCR' },
];

function providerNote() {
  const provider = (state.settings && state.settings.aiProvider) || 'mock';
  if (provider === 'ollama') return '本机模型会写一段阅读导览，可能需要一两分钟；章节框架仍由本地规则整理，不会乱编目录。文字层不可读时，会用本机 Windows OCR 识别前几页目录。';
  if (provider === 'real') return '远程模型会写一段阅读导览，时间取决于网络；章节框架仍由本地规则整理。文字层不可读时，会先用本机 OCR 识别目录。';
  return '目录和章节由本地规则整理；文字层不可读时，会用本机 Windows OCR 识别目录，不会联网。识别只在打开相关章节时逐节进行。';
}

export default async function renderTextbooks(root, ctx) {
  let books = [];
  let loadError = null;
  try {
    books = await api.listTextbooks();
  } catch (err) {
    loadError = err;
  }

  const page = h('div.page.textbooks-page', {
    ondragover: (e) => {
      e.preventDefault();
      page.classList.add('dragging');
    },
    ondragleave: (e) => {
      if (!e.relatedTarget || !page.contains(e.relatedTarget)) page.classList.remove('dragging');
    },
    ondrop: (e) => {
      e.preventDefault();
      page.classList.remove('dragging');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) runImport(file);
    },
  });
  root.appendChild(page);
  let progressHost = null;

  const fileInput = h('input', {
    type: 'file',
    accept: 'application/pdf,.pdf',
    style: { display: 'none' },
    onchange: () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (file) runImport(file);
    },
  });
  page.appendChild(fileInput);

  page.appendChild(renderCatalogHero());
  progressHost = h('div.textbook-import-progress-wrap');
  page.appendChild(progressHost);

  page.appendChild(renderCatalog());

  page.appendChild(h('details.card.catalog-notes', {}, [
    h('summary', {}, '导入前，先了解这几件事'),
    h('ul.small.muted.mb0.mt2', {}, [
      h('li', {}, '教材正文会保存在本机 data/textbooks/，原始 PDF 也会留一份，方便对照原页。'),
      h('li', {}, '章节框架优先用 PDF 书签；没有书签时会尝试识别目录页和正文标题，仍认不出来就按页分段，并如实告诉你来源。'),
      h('li', {}, '文字层是乱码或空白时，服务端会用 Windows 本机 OCR 识别目录；正文只在你打开某一节时识别那几页，不会一上来 OCR 整本书。'),
      h('li', {}, 'OCR 不是模型解读，公式、符号和分栏可能失真；讲义会标注文字来源，重要内容请对照 PDF 原页。'),
      h('li', {}, '每一节的讲义和问答，只有在你打开那一节时才会生成，不会一上来把整本书都发给模型。'),
      h('li', {}, '如果设置里选的是远程模型，教材原文的相关段落会发送到那个接口；本地规则引擎和本机 Ollama 都不会把内容发到外部。'),
    ]),
  ]));

  // ---------------------------------------------------------------- 目录页头

  function catalogStats() {
    const ready = books.filter((b) => b.status === 'ready').length;
    const chapters = books.reduce((n, b) => n + (Number(b.chapterCount) || 0), 0);
    const sections = books.reduce((n, b) => n + (Number(b.sectionCount) || 0), 0);
    return { ready, chapters, sections };
  }

  function renderCatalogHero() {
    const { ready, chapters, sections } = catalogStats();
    const intro = loadError
      ? '书架的目录记录没有读出来。可以刷新页面再试一次。'
      : books.length
        ? `共 ${books.length} 本教材，${chapters} 个章节，${sections} 个知识小节；其中 ${ready} 本可以阅读。每一行是一本教材的目录记录，点开就能继续。`
        : '书架还是空的。把一本 PDF 教材拖进这个页面，或者用右上角的按钮选一本。';

    return h('div.catalog-hero', {}, [
      h('div.catalog-head', {}, [
        h('div.catalog-head-main', {}, [
          h('div.catalog-kicker', {}, '教材精读 · THE STACKS'),
          h('h1.catalog-title', {}, '教材目录'),
          h('p.catalog-sub', {}, '选一本教材，查看它的整理记录，或继续上次的阅读。'),
        ]),
        h('div.catalog-actions', {}, [
          h('button.btn.primary.catalog-import-btn', {
            onclick: () => fileInput.click(),
          }, '＋ 导入 PDF 教材'),
          h('div.catalog-import-hint', {}, [
            h('span', {}, '支持 PDF · 单本最多 3000 页 / 200MB'),
            h('span', {}, '扫描版会尝试本机 OCR · 也可以把文件拖进页面'),
          ]),
        ]),
      ]),
      h('div.catalog-rule', {}, [h('span', {}, '❦')]),
      h('p.catalog-intro', {}, intro),
    ]);
  }

  // ---------------------------------------------------------------- 目录表

  function renderCatalog() {
    if (loadError) {
      return h('div.notice.alert', {}, ['书架没读出来：', loadError.message || String(loadError)]);
    }
    if (!books.length) {
      return emptyState({
        icon: '▤',
        title: '书架还是空的',
        hint: '导入一本 PDF 教材。文字层不可读的扫描版会尝试用本机 Windows OCR 识别。',
        actionLabel: '选择 PDF 文件',
        onAction: () => fileInput.click(),
      });
    }

    return h('div.catalog-table', {}, [
      h('div.catalog-head-row', {}, [
        h('span', {}, '编号'),
        h('span', {}, '教材'),
        h('span', {}, '结构'),
        h('span', {}, '状态'),
        h('span', { 'aria-hidden': 'true' }),
      ]),
      ...books.map(renderCatalogRow),
    ]);
  }

  function paintProgress(host, current) {
    const stepIndex = STEPS.findIndex((s) => s.key === current.step);
    const list = STEPS.map((s, i) => {
      const done = stepIndex >= 0 && i < stepIndex;
      const active = i === stepIndex;
      return h(`div.import-step${done ? '.done' : ''}${active ? '.active' : ''}`, {}, [
        h('span.import-step-dot', {}, done ? '✓' : String(i + 1)),
        h('span.import-step-label', {}, s.label),
        active && current.detail ? h('span.import-step-detail', {}, current.detail) : null,
      ]);
    });
    const pct = current.step === 'extract' ? current.pct : null;
    host.replaceChildren(h('div.card.import-progress', {}, [
      h('div.import-progress-head', {}, [
        h('div', {}, [
          h('div.focus-kicker', {}, '正在导入'),
          h('h3', {}, current.label || '处理中'),
        ]),
        pct !== null && pct !== undefined
          ? h('div.import-pct', {}, `${pct}%`)
          : h('span.import-spinner'),
      ]),
      pct !== null && pct !== undefined
        ? h('div.progress.import-bar', {}, [h('i', { style: { width: `${pct}%` } })])
        : null,
      h('div.import-steps', {}, list),
      h('p.tiny.muted.mb0.mt2', {}, current.step === 'analyze'
        ? `${providerNote()} 整理期间不要关闭这个页面。`
        : current.step === 'extract'
          ? '不要关闭页面。文字提取在浏览器里完成，不会上传到外部服务。'
          : '教材文字先保存在本机，再整理章节。'),
    ]));
  }

  async function runImport(file) {
    if (!/\.pdf$/i.test(file.name || '')) {
      toast('请选择一个 PDF 文件。', 'warn');
      return;
    }
    progressHost.replaceChildren(
      h('div.card.import-progress', {}, [
        h('div.import-progress-head', {}, [
          h('div', {}, [h('div.focus-kicker', {}, '正在导入'), h('h3', {}, '读取 PDF')]),
          h('span.import-spinner'),
        ]),
        h('p.tiny.muted.mb0', {}, `${file.name} · ${formatBytes(file.size)}`),
      ])
    );
    progressHost.scrollIntoView({ behavior: 'smooth', block: 'center' });

    try {
      const result = await importTextbookFromFile(file, {
        onProgress: (stage) => {
          if (!root.isConnected) return;
          paintProgress(progressHost, stage);
        },
      });
      if (!root.isConnected) return;
      for (const w of result.warnings || []) toast(w, 'warn');
      toast('教材整理好了，开始读吧。');
      ctx.navigate(`/textbook/${result.book.id}`);
    } catch (err) {
      if (!root.isConnected) return;
      progressHost.replaceChildren(h('div.card.import-error', {}, [
        h('div.focus-kicker', {}, '没有导入成功'),
        h('h3.mb1', {}, OCR_ERROR_TITLE[err.code] || '这次没能整理完'),
        h('p.small.muted', {}, err.message || String(err)),
        err.bookId
          ? h('p.small.muted', {}, '教材文字已经保存在书架里，可以在书架里重试分析，不需要重新导入。')
          : null,
        h('div.btn-row', {}, [
          err.bookId
            ? h('button.btn.primary.small', {
                onclick: async () => {
                  try {
                    await api.analyzeTextbook(err.bookId);
                    toast('整理好了。');
                    ctx.rerender();
                  } catch (retryErr) {
                    toastError(retryErr);
                  }
                },
              }, '重试分析')
            : h('button.btn.primary.small', { onclick: () => fileInput.click() }, '换一个文件'),
          h('button.btn.small.ghost', { onclick: () => progressHost.replaceChildren() }, '收起'),
        ]),
      ]));
    }
  }

  // ---------------------------------------------------------------- 目录条目

  function renderCatalogRow(book, index) {
    const ready = book.status === 'ready';
    const status = STATUS_LABEL[book.status] || book.status;
    const pct = book.progress ? book.progress.pct : 0;

    const metaBits = [];
    if (book.pageCount) metaBits.push(`${book.pageCount} 页`);
    if (book.chapterCount) metaBits.push(`${book.chapterCount} 章 · ${book.sectionCount} 节`);

    const note = book.status === 'error' && book.statusMessage
      ? book.statusMessage
      : book.structureNote
        || (ready ? '可以按章节阅读讲义、对照原文，并在阅读时提问。' : '导入完成后再整理章节框架。');

    function openBook() {
      if (book.status === 'analyzing') toast('这本教材还在整理中，稍等一下。', 'warn');
      else ctx.navigate(`/textbook/${book.id}`);
    }

    return h(`div.catalog-row${ready ? '.ready' : ''}${book.status === 'error' ? '.error' : ''}`, {
      role: 'button',
      tabindex: '0',
      title: book.title,
      onclick: openBook,
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBook(); }
      },
    }, [
      h('div.catalog-call', {}, [
        h('span', {}, `TXT-${String(index + 1).padStart(2, '0')}`),
        h('small', {}, 'PDF'),
      ]),
      h('div.catalog-book', {}, [
        h('h3.catalog-book-title', {}, book.title),
        h('p.catalog-book-sub', {}, note),
      ]),
      h('div.catalog-structure', {}, [
        h('span.catalog-structure-main', {}, metaBits.join(' · ') || '还没有章节'),
        h('span.catalog-structure-sub', {}, book.lastReadAt
          ? `上次读于 ${fmtRelative(book.lastReadAt)}`
          : ready ? '还没有开始读' : `导入于 ${fmtRelative(book.createdAt)}`),
        ready
          ? h('div.catalog-progress', {}, [
              h('div.progress', {}, [h('i', { style: { width: `${pct}%` } })]),
              h('em', {}, `${pct}%`),
            ])
          : null,
      ]),
      h('div.catalog-status', {}, [
        h(`span.catalog-status-text.${book.status}`, {}, status),
        book.ocrUsed
          ? h('span.catalog-ocr', { title: '正文由本机 Windows OCR 识别，公式和符号可能失真' }, '本机 OCR')
          : null,
        ready
          ? h('button.catalog-link', {
              onclick: (e) => { e.stopPropagation(); ctx.navigate(`/textbook/${book.id}`); },
            }, ['继续阅读', h('span', {}, '→')])
          : book.status === 'error' || book.status === 'imported'
            ? h('button.catalog-link.warm', {
                onclick: async (e) => {
                  e.stopPropagation();
                  const btn = e.currentTarget;
                  btn.disabled = true;
                  btn.textContent = '整理中…';
                  try {
                    await api.analyzeTextbook(book.id);
                    toast('整理好了。');
                    await ctx.rerender();
                  } catch (err) {
                    toastError(err);
                    btn.disabled = false;
                    btn.textContent = '重试分析';
                  }
                },
              }, book.status === 'imported' ? '开始整理' : '重试分析')
            : null,
      ]),
      h('button.icon-btn.danger.catalog-delete', {
        title: '删除这本教材',
        onclick: async (e) => {
          e.stopPropagation();
          const ok = await confirmDialog(
            '删掉这本教材？',
            `《${book.title}》的框架、讲义、问答和原始 PDF 都会删除，无法恢复。`,
            '删掉'
          );
          if (!ok) return;
          try {
            await api.deleteTextbook(book.id);
            toast('教材已删除。');
            await ctx.rerender();
          } catch (err) { toastError(err); }
        },
      }, '×'),
    ]);
  }
}
