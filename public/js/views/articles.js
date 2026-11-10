/**
 * 外刊书架
 * ---------------------------------------------------------------
 * 与教材书架分开：这里放的是短文，重点是阅读、高亮、查词和文章内问答。
 *
 * 导入只做文字层读取：txt / md 直接读，PDF 用本机 PDF.js 提取文字。
 * 扫描版 PDF 不在这一版做 OCR，读不到文字时明确说明，不生成空文章。
 */

import { api } from '../api.js';
import {
  h, toast, toastError, confirmDialog, emptyState, modal,
  pageHead, fmtRelative, PROVIDER_LABEL,
} from '../ui.js';
import { formatBytes } from '../pdf-import.js';
import { prepareArticleFile, textFromParagraphs } from '../article-import.js';
import { dictionaryLinks } from '../dictionaries.js';

const FORMAT_LABEL = { plain: 'TXT', md: 'MD', pdf: 'PDF' };
const KIND_LABEL = { word: '单词', phrase: '短语', sentence: '句子' };

function providerText(provider) {
  return PROVIDER_LABEL[provider] || '未知来源';
}

export default async function renderArticles(root, ctx) {
  const tab = ctx.args.tab === 'vocabulary' ? 'vocabulary' : 'articles';
  let articles = [];
  let vocabulary = [];
  let loadError = null;
  try {
    const [a, v] = await Promise.all([api.listArticles(), api.listVocabulary()]);
    articles = a;
    vocabulary = v;
  } catch (err) {
    loadError = err;
  }

  const page = h('div.page.articles-page', {
    ondragover: (e) => {
      e.preventDefault();
      page.classList.add('dragging');
    },
    ondragleave: (e) => {
      if (!e.relatedTarget || (page.contains && !page.contains(e.relatedTarget))) {
        page.classList.remove('dragging');
      }
    },
    ondrop: (e) => {
      e.preventDefault();
      page.classList.remove('dragging');
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) runFileImport(file);
    },
  });
  root.appendChild(page);

  const fileInput = h('input', {
    type: 'file',
    accept: '.txt,.md,.markdown,.text,.pdf,text/plain,text/markdown,application/pdf',
    style: { display: 'none' },
    onchange: () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (file) runFileImport(file);
    },
  });
  page.appendChild(fileInput);

  const importHost = h('div.article-import-host');
  const contentHost = h('div.articles-content');

  page.appendChild(pageHead({
    kicker: '外刊阅读 · THE READER',
    title: '外刊书架',
    sub: '导入英文外刊，读的时候查词、做批注，也可以就这一篇提问。当前版本不做 OCR。',
    actions: [
      h('button.btn.primary', { onclick: () => openComposer() }, '＋ 粘贴文本'),
      h('button.btn', { onclick: () => fileInput.click() }, '导入文件'),
    ],
  }));

  page.appendChild(h('div.articles-tabs', {}, [
    h(`button.articles-tab${tab === 'articles' ? '.active' : ''}`, {
      onclick: () => ctx.navigate('/articles'),
    }, [h('span', {}, '文章'), h('em', {}, String(articles.length))]),
    h(`button.articles-tab${tab === 'vocabulary' ? '.active' : ''}`, {
      onclick: () => ctx.navigate('/articles?tab=vocabulary'),
    }, [h('span', {}, '生词本'), h('em', {}, String(vocabulary.length))]),
  ]));

  page.appendChild(importHost);
  page.appendChild(contentHost);

  page.appendChild(h('details.card.article-notes', {}, [
    h('summary', {}, '关于这个模块'),
    h('ul.small.muted.mb0.mt2', {}, [
      h('li', {}, '正文和批注都保存在本机 data/articles/ 里，删除文章会把这些一起删掉。'),
      h('li', {}, '支持 .txt、.md 和带文字层的 .pdf。扫描版 PDF 需要 OCR，这一版没有做，会明确提示读不到文字。'),
      h('li', {}, '查词和文章问答只把选中的文字、所在段落和附近原文发给当前引擎；本地规则引擎没有释义能力，会直接说明。'),
      h('li', {}, '文章内容只作为这一次阅读会话的上下文，不会自动写进 AI 整理空间的长期记忆，也不会创建待办或改文章。'),
    ]),
  ]));

  paint();

  if (loadError) {
    contentHost.replaceChildren(h('div.notice.alert', {}, [
      '外刊书架没有读出来：', loadError.message || String(loadError),
    ]));
  }

  // ---------------------------------------------------------------- 标签页

  function paint() {
    if (loadError) return;
    contentHost.replaceChildren(tab === 'vocabulary' ? renderVocabulary() : renderList());
  }

  function tabCounts() {
    const done = articles.filter((a) => Boolean(a.finishedAt)).length;
    return { done };
  }

  // ---------------------------------------------------------------- 文章列表

  function renderList() {
    if (!articles.length) {
      return emptyState({
        icon: '▤',
        title: '还没有文章',
        hint: '把一段外刊文字粘贴进来，或者导入 .txt / .md / 带文字层的 PDF。',
        actionLabel: '粘贴第一篇',
        onAction: () => openComposer(),
      });
    }
    const { done } = tabCounts();
    return h('div.article-list', {}, [
      h('div.article-list-head', {}, [
        h('span', {}, `共 ${articles.length} 篇`),
        h('span', {}, done ? `${done} 篇已读完` : '还没有标记读完的文章'),
      ]),
      ...articles.map(renderArticleRow),
    ]);
  }

  function renderArticleRow(article) {
    const pct = article.progress ? article.progress.percent || 0 : 0;
    const finished = Boolean(article.finishedAt);
    const words = Number(article.wordCount) || 0;
    const meta = [
      article.source,
      article.author,
      article.issue,
      `${words} 词`,
      `导入于 ${fmtRelative(article.createdAt)}`,
    ].filter(Boolean).join(' · ');

    function open() {
      ctx.navigate(`/article/${article.id}`);
    }

    return h('div.article-row', {
      role: 'button',
      tabindex: '0',
      title: article.title,
      onclick: open,
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      },
    }, [
      h('div.article-row-mark', {}, [
        h('span.article-row-format', {}, FORMAT_LABEL[article.format] || 'TXT'),
        h('span.article-row-pct', {}, finished ? '已读完' : pct ? `${pct}%` : '未读'),
      ]),
      h('div.article-row-main', {}, [
        h('h3.article-row-title', {}, article.title),
        h('p.article-row-meta', {}, meta || '还没有来源信息'),
        article.excerpt ? h('p.article-row-excerpt', {}, article.excerpt) : null,
        pct
          ? h('div.article-row-progress', {}, [
              h('div.progress', {}, [h('i', { style: { width: `${pct}%` } })]),
              h('span.tiny.muted', {}, article.progress.lastReadAt
                ? `上次读于 ${fmtRelative(article.progress.lastReadAt)}`
                : '继续阅读'),
            ])
          : null,
      ]),
      h('div.article-row-actions', {}, [
        h('button.btn.small.primary', {
          onclick: (e) => { e.stopPropagation(); open(); },
        }, finished ? '再看一遍' : pct ? '继续阅读' : '开始阅读'),
        h('button.btn.small.ghost', {
          onclick: async (e) => {
            e.stopPropagation();
            try {
              const full = await api.getArticle(article.id);
              openComposer({ mode: 'edit', article: article, paragraphs: full.paragraphs });
            } catch (err) { toastError(err); }
          },
        }, '编辑'),
        h('button.icon-btn.danger.article-row-delete', {
          title: '删除这篇文章',
          onclick: async (e) => {
            e.stopPropagation();
            const ok = await confirmDialog(
              '删掉这篇文章？',
              `《${article.title}》的正文、高亮、批注和文章内对话都会删除，无法恢复。加入生词本的词会保留。`,
              '删掉'
            );
            if (!ok) return;
            try {
              await api.deleteArticle(article.id);
              toast('文章已删除。');
              await ctx.rerender();
            } catch (err) { toastError(err); }
          },
        }, '×'),
      ]),
    ]);
  }

  // ---------------------------------------------------------------- 生词本

  function renderVocabulary() {
    if (!vocabulary.length) {
      return emptyState({
        icon: '◎',
        title: '生词本还是空的',
        hint: '在阅读器里选中单词或短语，解释之后点「加入生词本」。',
        actionLabel: '去文章列表',
        onAction: () => ctx.navigate('/articles'),
      });
    }

    const search = h('input.article-vocab-search', {
      type: 'search',
      placeholder: '在生词本里找…',
      oninput: () => paintVocabulary(listHost, search.value),
    });
    const listHost = h('div.vocab-list');
    paintVocabulary(listHost, '');

    return h('div.vocab-panel', {}, [
      h('div.vocab-toolbar', {}, [
        search,
        h('span.tiny.muted', {}, '按更新时间排序 · 同一个词再次加入会累加次数'),
      ]),
      listHost,
    ]);
  }

  function renderVocabExample(ex) {
    return h('div.vocab-example', {}, [
      ex.en ? h('p.vocab-example-en', {}, ex.en) : null,
      ex.zh ? h('p.vocab-example-zh', {}, ex.zh) : null,
    ]);
  }

  function dictLinksRow(term, kind) {
    if (kind === 'sentence') return null;
    const links = dictionaryLinks(term);
    if (!links) return null;
    return h('div.vocab-links', {}, [
      h('a.link-btn', { href: links.oxford, target: '_blank', rel: 'noopener' }, '牛津词典 ↗'),
      h('a.link-btn', { href: links.eudic, target: '_blank', rel: 'noopener' }, '欧路词典 ↗'),
    ]);
  }

  function wordGroup(label, items) {
    if (!items || !items.length) return null;
    return h('div.vocab-word-group', {}, [
      h('span.tiny.muted', {}, label),
      h('div.lookup-chips', {}, items.map((item) => h('span.lookup-chip', {
        title: item.meaningZh || '',
      }, item.meaningZh ? `${item.word} · ${item.meaningZh}` : item.word))),
    ]);
  }

  function paintVocabulary(host, keyword) {
    const q = String(keyword || '').trim().toLowerCase();
    const list = vocabulary.filter((entry) => {
      if (!q) return true;
      const extra = [...(entry.derivatives || []), ...(entry.relatedWords || [])]
        .map((item) => `${item.word} ${item.meaningZh}`);
      return [entry.term, entry.definitionZh, entry.definitionEn, entry.articleTitle, ...extra]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });

    if (!list.length) {
      host.replaceChildren(h('p.small.muted', {}, `没有找到包含「${keyword}」的生词。`));
      return;
    }

    host.replaceChildren(...list.map((entry) => h('div.vocab-card', {}, [
      h('div.vocab-card-head', {}, [
        h('div.vocab-term', {}, [
          h('strong', {}, entry.term),
          h('span.vocab-kind', {}, KIND_LABEL[entry.kind] || '词'),
          entry.seenCount > 1 ? h('span.vocab-seen', {}, `收录 ${entry.seenCount} 次`) : null,
        ]),
        h('div.vocab-card-actions', {}, [
          h('button.btn.small.ghost', {
            onclick: () => openNote(entry),
          }, entry.note ? '改备注' : '写备注'),
          h('button.icon-btn.danger', {
            title: '从生词本删除',
            onclick: async () => {
              const ok = await confirmDialog('删掉这个词？', `「${entry.term}」会从生词本移除。`, '删掉');
              if (!ok) return;
              try {
                await api.deleteVocabulary(entry.id);
                toast('已从生词本移除。');
                await ctx.rerender();
              } catch (err) { toastError(err); }
            },
          }, '×'),
        ]),
      ]),
      entry.partOfSpeech ? h('p.vocab-pos', {}, entry.partOfSpeech) : null,
      entry.definitionZh ? h('p.vocab-zh', {}, entry.definitionZh) : null,
      entry.definitionEn ? h('p.vocab-en', {}, entry.definitionEn) : null,
      entry.examples && entry.examples.length
        ? h('div.vocab-examples', {}, [
            h('span.tiny.muted', {}, '例句'),
            ...entry.examples.map(renderVocabExample),
          ])
        : null,
      entry.oxford && entry.oxford.examples && entry.oxford.examples.length
        ? h('div.vocab-examples', {}, [
            h('span.tiny.muted', {}, '牛津词典例句'),
            ...entry.oxford.examples.map(renderVocabExample),
          ])
        : null,
      wordGroup('派生词', entry.derivatives),
      wordGroup('衍生词', entry.relatedWords),
      entry.contextMeaning
        ? h('div.vocab-context', {}, [h('span.tiny.muted', {}, '在这篇文章里'), h('p', {}, entry.contextMeaning)])
        : null,
      entry.note ? h('p.vocab-note', {}, [`备注：`, entry.note]) : null,
      h('div.vocab-foot', {}, [
        entry.articleTitle
          ? h('button.link-btn', {
              onclick: () => ctx.navigate(`/article/${entry.articleId}`),
            }, `来自《${entry.articleTitle}》`)
          : h('span.tiny.muted', {}, '没有关联文章'),
        entry.dictionarySource === 'oxford'
          ? h('span.tiny.muted', {}, '英文释义与例句：牛津词典')
          : (entry.entryProvider
            ? h('span.tiny.muted', {}, `释义：${providerText(entry.entryProvider)}`)
            : null),
      ]),
      dictLinksRow(entry.term, entry.kind),
    ])));
  }

  function openNote(entry) {
    const input = h('textarea', { rows: 5, value: entry.note || '', placeholder: '记下这个词为什么值得记，或自己的例句。' });
    modal({
      title: `备注 · ${entry.term}`,
      body: h('div', {}, [
        h('p.small.muted.mt0', {}, entry.definitionZh || entry.definitionEn || ''),
        input,
      ]),
      actions: [
        { label: '取消' },
        {
          label: '保存',
          primary: true,
          onClick: async () => {
            try {
              await api.patchVocabulary(entry.id, { note: input.value });
              entry.note = input.value.trim();
              toast('备注已保存。');
              await ctx.rerender();
            } catch (err) { toastError(err); return false; }
          },
        },
      ],
    });
  }

  // ---------------------------------------------------------------- 导入

  function showImportProgress(file, stage) {
    const pct = stage.step === 'extract' ? stage.pct : null;
    importHost.replaceChildren(h('div.card.article-import-progress', {}, [
      h('div.article-import-head', {}, [
        h('div', {}, [
          h('div.focus-kicker', {}, '正在读取文件'),
          h('h3', {}, stage.label || '处理中'),
        ]),
        pct !== null && pct !== undefined
          ? h('span.article-import-pct', {}, `${pct}%`)
          : h('span.import-spinner'),
      ]),
      h('p.tiny.muted.mb0', {}, `${file.name} · ${formatBytes(file.size)}${stage.detail ? ` · ${stage.detail}` : ''}`),
      pct !== null && pct !== undefined
        ? h('div.progress.import-bar', {}, [h('i', { style: { width: `${pct}%` } })])
        : null,
      h('p.tiny.muted.mb0.mt1', {}, '文字提取在这台电脑上完成，不会上传到外部服务。'),
    ]));
  }

  function showImportError(err) {
    importHost.replaceChildren(h('div.card.article-import-error', {}, [
      h('div.focus-kicker', {}, '没有读进来'),
      h('h3.mb1', {}, err.code === 'pdf-no-text' ? '这份 PDF 读不到文字' : '这个文件暂时不支持'),
      h('p.small.muted', {}, err.message || String(err)),
      h('div.btn-row.mt2', {}, [
        h('button.btn.small.primary', { onclick: () => fileInput.click() }, '换一个文件'),
        h('button.btn.small.ghost', { onclick: () => importHost.replaceChildren() }, '收起'),
      ]),
    ]));
  }

  async function runFileImport(file) {
    importHost.replaceChildren();
    showImportProgress(file, { step: 'read', label: '读取文件' });
    try {
      const prepared = await prepareArticleFile(file, { onProgress: (stage) => showImportProgress(file, stage) });
      importHost.replaceChildren();
      openComposer({ preset: prepared });
    } catch (err) {
      importHost.replaceChildren();
      showImportError(err);
    }
  }

  // ---------------------------------------------------------------- 新建 / 编辑

  function openComposer(options = {}) {
    const mode = options.mode === 'edit' ? 'edit' : 'create';
    const preset = options.preset || null;
    const article = options.article || null;
    const isPdf = preset ? preset.format === 'pdf' : mode === 'edit' && article && article.format === 'pdf';
    const originalText = mode === 'edit' ? textFromParagraphs(options.paragraphs || []) : '';

    const titleInput = h('input', {
      type: 'text',
      value: (preset && preset.title) || (article && article.title) || '',
      placeholder: '例如：The Quiet Power of Doing Less',
    });
    const sourceInput = h('input', {
      type: 'text',
      value: (article && article.source) || '',
      placeholder: '刊物或网站，例如 The Economist',
    });
    const authorInput = h('input', {
      type: 'text',
      value: (article && article.author) || '',
      placeholder: '作者（可以不填）',
    });
    const issueInput = h('input', {
      type: 'text',
      value: (article && article.issue) || '',
      placeholder: '期号 / 日期（可以不填）',
    });
    const urlInput = h('input', {
      type: 'url',
      value: (article && article.url) || '',
      placeholder: '原文链接（https://…，可以不填）',
    });

    const formatSelect = h('select', {}, [
      h('option', { value: 'plain' }, '纯文本'),
      h('option', { value: 'md' }, 'Markdown'),
    ]);
    if (preset && preset.format === 'md') formatSelect.value = 'md';

    const textArea = h('textarea.article-composer-text', {
      rows: 14,
      value: preset ? preset.text : originalText,
      placeholder: '把外刊正文粘贴到这里。段落之间留一个空行，阅读时更好分。',
    });

    const body = h('div.article-composer', {}, [
      h('div.article-composer-grid', {}, [
        h('label.field', {}, [h('span.label-text', {}, '标题'), titleInput]),
        h('label.field', {}, [h('span.label-text', {}, '来源'), sourceInput]),
        h('label.field', {}, [h('span.label-text', {}, '作者'), authorInput]),
        h('label.field', {}, [h('span.label-text', {}, '期号 / 日期'), issueInput]),
      ]),
      h('label.field', {}, [h('span.label-text', {}, '原文链接'), urlInput]),
    ]);

    if (isPdf) {
      body.appendChild(h('div.notice.quiet.article-pdf-note', {}, [
        h('strong', {}, '已从 PDF 提取文字'),
        h('div.small.mt1', {}, `${preset ? preset.text.length : '已保存'} 个字符。正文已经存进文章里，导入后可以在阅读器里继续对照。`),
        preset && preset.meta && preset.meta.pageCount
          ? h('div.tiny.muted', {}, `共 ${preset.meta.pageCount} 页 · 不做 OCR，图片里的文字读不到。`)
          : null,
      ]));
    } else {
      body.appendChild(h('label.field', {}, [
        h('span.label-text', {}, '正文'),
        mode === 'create' && !preset ? formatSelect : null,
        textArea,
        mode === 'edit'
          ? h('span.tiny.muted', {}, '如果改动了正文，保存后会清空这篇文章的高亮、批注和阅读位置。')
          : h('span.tiny.muted', {}, '支持 Markdown 的标题、引用和列表；HTML 标签会被当作普通文字剥掉。'),
      ]));
    }

    if (preset && preset.warnings && preset.warnings.length) {
      body.appendChild(h('div.notice.warm', {}, preset.warnings.join(' ')));
    }

    const dialog = modal({
      title: mode === 'edit' ? '编辑文章信息' : '放进书架',
      wide: true,
      body,
      actions: [
        { label: '取消' },
        {
          label: mode === 'edit' ? '保存' : '保存并阅读',
          primary: true,
          onClick: async () => {
            const title = titleInput.value.trim();
            if (!title) { toast('给这篇文章起个名字吧。', 'warn'); return false; }
            const url = urlInput.value.trim();
            if (url && !/^https?:\/\//i.test(url)) {
              toast('原文链接需要以 http:// 或 https:// 开头。', 'warn');
              return false;
            }

            const meta = {
              title,
              source: sourceInput.value.trim(),
              author: authorInput.value.trim(),
              issue: issueInput.value.trim(),
              url,
            };

            if (mode === 'edit') {
              try {
                await api.patchArticle(article.id, meta);
                const nextText = textArea.value.trim();
                if (!isPdf && nextText !== originalText.trim()) {
                  if (!nextText) { toast('正文不能是空的。', 'warn'); return false; }
                  const ok = await confirmDialog(
                    '替换正文？',
                    '正文改了以后，旧的高亮、批注和阅读位置会对不上，会被清空。确定要替换吗？',
                    '替换正文'
                  );
                  if (!ok) return false;
                  await api.replaceArticleContent(article.id, { text: nextText, format: formatSelect.value });
                }
                toast('文章信息已更新。');
                await ctx.rerender();
              } catch (err) { toastError(err); return false; }
              return;
            }

            const text = isPdf ? preset.text : textArea.value.trim();
            if (!text) { toast('还没有正文。', 'warn'); return false; }
            try {
              const created = await api.createArticle({
                ...meta,
                text,
                format: preset ? preset.format : formatSelect.value,
                fileName: preset ? preset.fileName : '',
              });
              toast('已经放进书架。');
              dialog.close();
              ctx.navigate(`/article/${created.id}`);
            } catch (err) { toastError(err); return false; }
          },
        },
      ],
    });
  }

  return async function cleanup() {
    if (importHost && importHost.parentNode) importHost.replaceChildren();
  };
}
