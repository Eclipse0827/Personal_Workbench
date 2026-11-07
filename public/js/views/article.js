/**
 * 外刊阅读器
 * ---------------------------------------------------------------
 * 左边是文章正文，右边是词汇 / 批注 / 文章问答三个面板。
 * 高亮和批注只记录段落内字符偏移，改字号不会错位。
 *
 * 查词和问答只把选中内容和附近原文发给当前引擎；
 * 当前是本地规则引擎时明确说没有释义能力，不伪造词典内容。
 */

import { api } from '../api.js';
import {
  h, toast, toastError, confirmDialog, modal, fmtRelative, PROVIDER_LABEL,
} from '../ui.js';
import { state } from '../state.js';
import { renderMarkdown } from '../markdown.js';
import {
  renderArticleParagraph, selectionOffsets, caretOffset,
  wordRangeAt, sentenceRangeAt, setSelectionRangeInParagraph,
} from '../article-text.js';

const FONT_MIN = 16;
const FONT_MAX = 26;
const KIND_LABEL = { word: '单词', phrase: '短语', sentence: '句子' };

function normTerm(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function providerLabel(provider) {
  return PROVIDER_LABEL[provider] || '未知来源';
}

function formatLabel(format) {
  return format === 'pdf' ? 'PDF 文字' : format === 'md' ? 'Markdown' : '纯文本';
}

function short(text, n = 90) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > n ? `${value.slice(0, n)}…` : value;
}

export default async function renderArticle(root, ctx) {
  let data;
  try {
    data = await api.getArticle(ctx.args.id);
  } catch (err) {
    root.appendChild(h('div.page', {}, [
      h('div.notice.alert', {}, ['这篇文章没有打开：', err.message || String(err)]),
      h('div.btn-row.mt2', {}, [
        h('button.btn.primary', { onclick: () => ctx.navigate('/articles') }, '回到外刊书架'),
      ]),
    ]));
    return null;
  }

  const detail = data.article;
  const paragraphs = data.paragraphs || [];
  const [initialChat, vocabulary] = await Promise.all([
    api.getArticleChat(detail.id).catch(() => []),
    api.listVocabulary().catch(() => []),
  ]);

  let chatMessages = initialChat;
  const addedTerms = new Set(vocabulary.map((entry) => entry.normalized || normTerm(entry.term)));
  let fontSize = Number(detail.reader && detail.reader.fontSize) || 19;
  let railTab = 'lookup';
  let activeSelection = null;
  let lookupResult = null;
  let lookupSelectionRef = null;
  let lookupError = null;
  let lookupBusy = false;
  let chatDraft = '';
  let chatError = null;
  let chatBusy = false;
  let remoteConsent = false;
  let disposed = false;
  let saveTimer = null;
  let fontTimer = null;
  let clickTimer = null;

  const shell = h('div.article-reader');
  shell.style['--article-font'] = `${fontSize}px`;
  root.appendChild(shell);

  const progressText = h('span.article-progress-text', {}, `${detail.progress ? detail.progress.percent || 0 : 0}%`);
  const progressFill = h('i', { style: { width: `${detail.progress ? detail.progress.percent || 0 : 0}%` } });
  const railToggle = h('button.btn.small.ghost.article-rail-toggle', {
    onclick: () => shell.classList.toggle('rail-open'),
  }, '侧栏');

  const fontValue = h('span.article-font-value', {}, String(fontSize));
  const fontMinus = h('button.icon-round', {
    title: '减小字号',
    onclick: () => changeFont(-1),
  }, 'A−');
  const fontPlus = h('button.icon-round', {
    title: '增大字号',
    onclick: () => changeFont(1),
  }, 'A+');

  const bar = h('header.article-bar', {}, [
    h('div.article-bar-left', {}, [
      h('button.btn.small.ghost.article-back', {
        onclick: () => ctx.navigate('/articles'),
      }, '← 书架'),
      h('div.article-bar-id', {}, [
        h('div.article-bar-title', {}, detail.title),
        h('div.article-bar-meta', {}, [
          detail.source || '',
          detail.author || '',
          detail.issue || '',
          `${Number(detail.wordCount) || 0} 词`,
        ].filter(Boolean).join(' · ')),
      ]),
    ]),
    h('div.article-bar-right', {}, [
      h('div.article-progress', {}, [
        progressText,
        h('div.progress.article-progress-bar', {}, [progressFill]),
      ]),
      h('div.article-font', {}, [fontMinus, fontValue, fontPlus]),
      railToggle,
    ]),
  ]);

  const paragraphHost = h('div.article-text');
  const read = h('article.article-read', {}, [
    h('header.article-head', {}, [
      h('div.kicker', {}, `外刊阅读 · ${detail.source || '未标注来源'}`),
      h('h1.article-title', {}, detail.title),
      h('div.article-head-meta', {}, [
        detail.author ? `作者 ${detail.author}` : '',
        detail.issue ? `期号 ${detail.issue}` : '',
        formatLabel(detail.format),
        detail.progress && detail.progress.lastReadAt
          ? `上次读于 ${fmtRelative(detail.progress.lastReadAt)}`
          : '还没有开始读',
      ].filter(Boolean).join(' · ')),
      detail.url
        ? h('a.article-source-link', {
            href: detail.url, target: '_blank', rel: 'noopener noreferrer',
          }, '查看原文 ↗')
        : null,
      (detail.tags && detail.tags.length)
        ? h('div.article-tags', {}, detail.tags.map((tag) => h('span.article-tag', {}, tag)))
        : null,
    ]),
    paragraphHost,
    h('footer.article-foot', {}, [
      h('span.tiny.muted', {}, '选中文字可以高亮、批注或查词。当前文章只作为这次阅读的上下文，不会写进长期 AI 记忆。'),
    ]),
  ]);

  const rail = h('aside.article-rail');
  const body = h('div.article-body', {}, [read, rail]);
  shell.appendChild(bar);
  shell.appendChild(body);

  // ---------------------------------------------------------------- 选区工具条

  const selectionTools = h('div.selection-tools.is-hidden', { onmousedown: (e) => e.preventDefault() }, [
    h('button.article-tool', { onclick: () => lookupSelection(activeSelection) }, '解释'),
    h('button.article-tool', { onclick: () => openAnnotate() }, '批注'),
    h('button.article-tool', { onclick: () => createHighlight('') }, '高亮'),
    h('button.article-tool', { onclick: () => addSelectionToVocabulary() }, '＋ 生词本'),
  ]);
  shell.appendChild(selectionTools);

  // ---------------------------------------------------------------- 正文事件

  paragraphHost.onmouseup = (e) => {
    const el = paragraphElementOf(e.target);
    if (!el) return;
    setTimeout(() => {
      if (disposed) return;
      const selection = selectionOffsets(el);
      if (!selection) return;
      activeSelection = selection;
      showSelectionTools(selection, e.clientX, e.clientY);
    }, 0);
  };

  paragraphHost.onmousedown = () => hideSelectionTools();

  paragraphHost.onclick = (e) => {
    const el = paragraphElementOf(e.target);
    if (!el) return;
    if (selectionOffsets(el)) return;
    clearTimeout(clickTimer);
    clickTimer = setTimeout(() => {
      if (disposed) return;
      const offset = caretOffset(el, e.clientX, e.clientY);
      if (offset === null) return;
      const text = paragraphTextOf(el.dataset.paragraphId);
      const range = wordRangeAt(text, offset);
      if (!range) return;
      selectRangeVisual(el, range.start, range.end);
      lookupSelection({
        paragraphId: el.dataset.paragraphId,
        start: range.start,
        end: range.end,
        text: text.slice(range.start, range.end),
        mode: 'word',
      });
    }, 220);
  };

  paragraphHost.ondblclick = (e) => {
    const el = paragraphElementOf(e.target);
    if (!el) return;
    clearTimeout(clickTimer);
    e.preventDefault();
    const offset = caretOffset(el, e.clientX, e.clientY);
    if (offset === null) return;
    const text = paragraphTextOf(el.dataset.paragraphId);
    const range = sentenceRangeAt(text, offset);
    if (!range) return;
    selectRangeVisual(el, range.start, range.end);
    lookupSelection({
      paragraphId: el.dataset.paragraphId,
      start: range.start,
      end: range.end,
      text: text.slice(range.start, range.end),
      mode: 'sentence',
    });
  };

  // ---------------------------------------------------------------- 阅读进度

  function currentAnchor() {
    const blocks = paragraphHost.querySelectorAll('.article-block');
    for (const el of blocks) {
      if (typeof el.getBoundingClientRect !== 'function') return null;
      const rect = el.getBoundingClientRect();
      if (rect.bottom > 140) {
        const ratio = rect.height > 0
          ? Math.min(1, Math.max(0, (140 - rect.top) / rect.height))
          : 0;
        return { paragraphId: el.dataset.paragraphId, ratio: Math.round(ratio * 1000) / 1000 };
      }
    }
    return null;
  }

  async function persistProgress() {
    const anchor = currentAnchor();
    if (!anchor) return;
    try {
      const progress = await api.saveArticleProgress(detail.id, anchor);
      detail.progress = progress;
      const pct = progress.percent || 0;
      progressText.textContent = `${pct}%`;
      progressFill.style.width = `${pct}%`;
    } catch { /* 进度存不上就不打断阅读 */ }
  }

  function onScroll() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { if (!disposed) persistProgress(); }, 900);
  }

  function restoreProgress() {
    const anchor = detail.progress;
    if (!anchor || !anchor.anchorParagraphId) return;
    const el = findParagraphElement(anchor.anchorParagraphId);
    if (!el || typeof el.getBoundingClientRect !== 'function') return;
    if (typeof window.requestAnimationFrame !== 'function') return;
    window.requestAnimationFrame(() => {
      if (disposed) return;
      const rect = el.getBoundingClientRect();
      const ratio = Number(anchor.anchorRatio) || 0;
      window.scrollTo({ top: Math.max(0, (window.scrollY || 0) + rect.top + rect.height * ratio - 140) });
    });
  }

  // ---------------------------------------------------------------- 字号

  function applyFont() {
    if (shell.style.setProperty) shell.style.setProperty('--article-font', `${fontSize}px`);
    else shell.style['--article-font'] = `${fontSize}px`;
    fontValue.textContent = String(fontSize);
  }

  function changeFont(delta) {
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, fontSize + delta));
    if (next === fontSize) return;
    fontSize = next;
    applyFont();
    clearTimeout(fontTimer);
    fontTimer = setTimeout(() => {
      if (disposed) return;
      api.patchArticle(detail.id, { reader: { fontSize } }).catch(() => {});
    }, 700);
  }

  // ---------------------------------------------------------------- 渲染正文与面板

  function paintParagraphs() {
    const byParagraph = new Map();
    for (const hl of detail.highlights || []) {
      const list = byParagraph.get(hl.paragraphId) || [];
      list.push(hl);
      byParagraph.set(hl.paragraphId, list);
    }
    paragraphHost.replaceChildren(...paragraphs.map((paragraph) => renderArticleParagraph(
      paragraph,
      byParagraph.get(paragraph.id) || [],
      { onHighlightClick: (id) => openHighlight(id) }
    )));
  }

  function paintRail() {
    const tabButton = (key, label) => h(`button.article-rail-tab${railTab === key ? '.active' : ''}`, {
      onclick: () => { railTab = key; paintRail(); },
    }, label);

    const head = h('div.article-rail-head', {}, [
      h('div.article-rail-tabs', {}, [
        tabButton('lookup', '词汇'),
        tabButton('notes', `批注 ${(detail.highlights || []).length}`),
        tabButton('chat', '文章问答'),
      ]),
      h('button.article-rail-close', {
        title: '收起侧栏',
        onclick: () => shell.classList.remove('rail-open'),
      }, '×'),
    ]);

    let panel;
    if (railTab === 'notes') panel = renderNotesPanel();
    else if (railTab === 'chat') panel = renderChatPanel();
    else panel = renderLookupPanel();

    rail.replaceChildren(head, h('div.article-rail-body', {}, panel));
  }

  // ---------------------------------------------------------------- 查词

  function renderLookupPanel() {
    if (lookupBusy) {
      return h('div.lookup-empty', {}, [
        h('span.import-spinner'),
        h('p.small.muted', {}, '正在结合当前文章解释…'),
        providerHint(),
      ]);
    }
    if (lookupError) {
      return h('div.lookup-empty', {}, [
        h('div.notice.alert', {}, [
          h('strong', {}, '这次没有解释出来'),
          h('div.small.mt1', {}, lookupError.message || String(lookupError)),
        ]),
        lookupError.code === 'ai-unavailable'
          ? h('button.btn.small.primary', { onclick: () => ctx.navigate('/settings') }, '去设置里连接模型')
          : null,
        providerHint(),
      ]);
    }
    if (!lookupResult) {
      return h('div.lookup-empty', {}, [
        h('div.lookup-intro-icon', {}, 'Aa'),
        h('h3', {}, '点一个词，或选中一句话'),
        h('p.small.muted', {}, '单击单词会直接解释；选中短语或句子后，用浮出的工具条点「解释」。'),
        h('p.small.muted', {}, '也可以双击句子，查看句子结构。'),
        providerHint(),
      ]);
    }

    const entry = lookupResult.entry || {};
    const term = entry.term || (activeSelection ? activeSelection.text : '');
    const added = addedTerms.has(normTerm(term));

    const exampleRows = (entry.examples || []).map((ex) => h('div.lookup-example', {}, [
      ex.en ? h('p.lookup-example-en', {}, ex.en) : null,
      ex.zh ? h('p.lookup-example-zh', {}, ex.zh) : null,
    ]));

    return h('div.lookup-panel', {}, [
      h('div.lookup-head', {}, [
        h('h2.lookup-term', {}, term),
        h('span.lookup-kind', {}, KIND_LABEL[entry.kind] || '词'),
      ]),
      entry.partOfSpeech ? h('div.lookup-line', {}, [h('span.lookup-label', {}, '词性'), h('span', {}, entry.partOfSpeech)]) : null,
      entry.structure ? h('div.lookup-line', {}, [h('span.lookup-label', {}, '句子结构'), h('span', {}, entry.structure)]) : null,
      entry.definitionEn ? h('section.lookup-section', {}, [
        h('div.lookup-label', {}, '英文解释'),
        h('p.lookup-en', {}, entry.definitionEn),
      ]) : null,
      entry.definitionZh ? h('section.lookup-section', {}, [
        h('div.lookup-label', {}, '中文解释'),
        h('p.lookup-zh', {}, entry.definitionZh),
      ]) : null,
      (entry.collocations || []).length ? h('section.lookup-section', {}, [
        h('div.lookup-label', {}, '常见搭配'),
        h('div.lookup-chips', {}, entry.collocations.map((item) => h('span.lookup-chip', {}, item))),
      ]) : null,
      exampleRows.length ? h('section.lookup-section', {}, [
        h('div.lookup-label', {}, '例句'),
        ...exampleRows,
      ]) : null,
      entry.contextMeaning ? h('section.lookup-context', {}, [
        h('div.lookup-label', {}, '在这篇文章里'),
        h('p', {}, entry.contextMeaning),
      ]) : null,
      h('div.lookup-actions', {}, [
        h('button.btn.small.primary', {
          disabled: added,
          onclick: () => saveVocabulary(entry, lookupSelectionRef || activeSelection, lookupResult.provider, lookupResult.model),
        }, added ? '已在生词本' : '加入生词本'),
        h('button.btn.small.ghost', {
          onclick: () => { railTab = 'chat'; paintRail(); },
        }, '就这段提问'),
      ]),
      h('p.lookup-disclaimer', {}, [
        `由${providerLabel(lookupResult.provider || entry.provider)}根据当前文章上下文生成，不是牛津 / 朗文等词典的官方释义。`,
        entry.confidence === 'low' ? '模型对这个解释把握不高，建议对照原文再判断。' : '',
      ].join('')),
    ]);
  }

  function providerHint() {
    const provider = (state.settings && state.settings.aiProvider) || 'mock';
    if (provider === 'ollama') {
      return h('p.lookup-hint', {}, '本机 Ollama 会结合当前段落解释，第一次可能要等一两分钟。');
    }
    if (provider === 'real') {
      return h('p.lookup-hint', {}, '当前是远程模型：选中的文字和附近原文会发送到设置里的接口。');
    }
    return h('p.lookup-hint', {}, '当前是本地规则引擎，没有释义能力。到「设置与数据」里连接 Ollama 或远程模型后再查词。');
  }

  async function allowRemote(reason) {
    const provider = state.settings && state.settings.aiProvider;
    if (provider !== 'real' || remoteConsent) return true;
    const ok = await confirmDialog(
      '把这段内容发给远程模型？',
      `当前设置是远程模型。${reason} 只发送这次需要的内容，不会写入长期 AI 记忆。继续吗？`,
      '继续'
    );
    if (ok) remoteConsent = true;
    return ok;
  }

  async function callLookup(selection) {
    if (!selection) return null;
    if (!(await allowRemote('词汇解析会把选中的文字、所在段落和前后各一段发出去。'))) return null;
    lookupSelectionRef = selection;
    lookupBusy = true;
    lookupError = null;
    paintRail();
    try {
      const result = await api.lookupArticleText(detail.id, selection);
      if (disposed) return null;
      lookupResult = result;
      return result;
    } catch (err) {
      lookupError = err;
      return null;
    } finally {
      lookupBusy = false;
      if (!disposed) paintRail();
    }
  }

  async function lookupSelection(selection) {
    if (!selection) return;
    activeSelection = selection;
    lookupResult = null;
    lookupError = null;
    railTab = 'lookup';
    shell.classList.add('rail-open');
    paintRail();
    await callLookup(selection);
  }

  async function addSelectionToVocabulary() {
    const selection = activeSelection;
    if (!selection) return;
    hideSelectionTools();
    const sameTerm = lookupResult && normTerm(lookupResult.entry && lookupResult.entry.term) === normTerm(selection.text);
    const result = sameTerm ? lookupResult : await callLookup(selection);
    if (!result) return;
    await saveVocabulary(result.entry, selection, result.provider, result.model);
  }

  async function saveVocabulary(entry, selection, provider, model) {
    if (!entry || !selection) {
      toast('先选中一段文字再收进生词本。', 'warn');
      return;
    }
    const term = entry.term || selection.text;
    try {
      const out = await api.addVocabulary({
        articleId: detail.id,
        term,
        kind: entry.kind || selection.mode,
        entry: { ...entry, provider: entry.provider || provider, model: entry.model || model },
        contextText: paragraphTextOf(selection.paragraphId).slice(0, 800),
        selectionText: selection.text,
      });
      addedTerms.add(normTerm(term));
      toast(out.merged ? `「${term}」已经在生词本里，收录次数 +1。` : `「${term}」已经收进生词本。`);
      paintRail();
    } catch (err) {
      toastError(err);
    }
  }

  // ---------------------------------------------------------------- 高亮与批注

  async function createHighlight(note) {
    const selection = activeSelection;
    if (!selection) {
      toast('先选中一段文字。', 'warn');
      return false;
    }
    try {
      const highlight = await api.addHighlight(detail.id, {
        paragraphId: selection.paragraphId,
        start: selection.start,
        end: selection.end,
        note,
      });
      detail.highlights = [...(detail.highlights || []), highlight];
      paintParagraphs();
      paintRail();
      hideSelectionTools();
      toast(note ? '高亮和批注已保存。' : '已高亮。');
      return true;
    } catch (err) {
      toastError(err);
      return false;
    }
  }

  function openAnnotate() {
    const selection = activeSelection;
    if (!selection) {
      toast('先选中一段文字。', 'warn');
      return;
    }
    const input = h('textarea', { rows: 5, placeholder: '写点自己的理解、疑问或翻译。' });
    modal({
      title: '给这一段加批注',
      body: h('div', {}, [
        h('blockquote.article-quote', {}, short(selection.text, 260)),
        h('p.tiny.muted', {}, '保存后会同时保留高亮。'),
        input,
      ]),
      actions: [
        { label: '取消' },
        {
          label: '保存批注',
          primary: true,
          onClick: async () => {
            const ok = await createHighlight(input.value.trim());
            if (!ok) return false;
          },
        },
      ],
    });
  }

  function openHighlight(highlightId) {
    const highlight = (detail.highlights || []).find((hl) => hl.id === highlightId);
    if (!highlight) return;
    const input = h('textarea', { rows: 5, value: highlight.note || '', placeholder: '还没有写批注。' });
    modal({
      title: '这条高亮',
      body: h('div', {}, [
        h('blockquote.article-quote', {}, highlight.quote),
        input,
        h('p.tiny.muted.mb0', {}, `上次修改于 ${fmtRelative(highlight.updatedAt || highlight.createdAt)}`),
      ]),
      actions: [
        {
          label: '删掉高亮',
          danger: true,
          onClick: async () => {
            try {
              await api.deleteHighlight(detail.id, highlight.id);
              detail.highlights = (detail.highlights || []).filter((hl) => hl.id !== highlight.id);
              paintParagraphs();
              paintRail();
              toast('高亮已删除。');
            } catch (err) {
              toastError(err);
              return false;
            }
          },
        },
        { label: '取消' },
        {
          label: '保存',
          primary: true,
          onClick: async () => {
            try {
              const updated = await api.patchHighlight(detail.id, highlight.id, { note: input.value.trim() });
              Object.assign(highlight, updated);
              paintParagraphs();
              paintRail();
              toast('批注已保存。');
            } catch (err) {
              toastError(err);
              return false;
            }
          },
        },
      ],
    });
  }

  function renderNotesPanel() {
    const list = [...(detail.highlights || [])];
    if (!list.length) {
      return h('div.lookup-empty', {}, [
        h('div.lookup-intro-icon', {}, '✎'),
        h('h3', {}, '还没有高亮'),
        h('p.small.muted', {}, '选中文字后点「高亮」或「批注」。高亮位置按字符记录，改字号也不会偏。'),
      ]);
    }
    const order = new Map(paragraphs.map((p, index) => [p.id, index]));
    list.sort((a, b) => (order.get(a.paragraphId) || 0) - (order.get(b.paragraphId) || 0) || a.start - b.start);

    return h('div.notes-list', {}, list.map((hl) => {
      const paragraphIndex = (order.get(hl.paragraphId) || 0) + 1;
      return h('div.note-card', {
        role: 'button',
        tabindex: '0',
        onclick: () => openHighlight(hl.id),
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHighlight(hl.id); }
        },
      }, [
        h('blockquote.note-quote', {}, short(hl.quote, 120)),
        hl.note
          ? h('p.note-text', {}, short(hl.note, 160))
          : h('p.note-text.muted', {}, '只有高亮，还没有写批注'),
        h('div.note-foot', {}, [
          h('span.tiny.muted', {}, `第 ${paragraphIndex} 段 · ${fmtRelative(hl.updatedAt || hl.createdAt)}`),
          h('button.link-btn', {
            onclick: (e) => {
              e.stopPropagation();
              const el = findParagraphElement(hl.paragraphId);
              if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            },
          }, '定位'),
        ]),
      ]);
    }));
  }

  // ---------------------------------------------------------------- 文章问答

  function renderChatPanel() {
    const provider = (state.settings && state.settings.aiProvider) || 'mock';
    const list = h('div.article-chat-list');

    if (!chatMessages.length) {
      list.appendChild(h('div.article-chat-empty', {}, [
        h('p.small.muted', {}, '可以问这一段的主旨、某个说法的语气，或者让 AI 解释上下文。'),
        h('p.tiny.muted', {}, '只会使用这一篇的标题、选中内容和附近原文，不会翻出别的学习记录。'),
      ]));
    }

    for (const msg of chatMessages) {
      const isUser = msg.role !== 'assistant';
      list.appendChild(h(`div.article-msg${isUser ? '.user' : '.assistant'}`, {}, [
        h('div.article-msg-head', {}, [
          h('span', {}, isUser ? '你' : providerLabel(msg.provider)),
          msg.createdAt ? h('span.tiny.muted', {}, fmtRelative(msg.createdAt)) : null,
        ]),
        msg.selection && msg.selection.text
          ? h('blockquote.msg-selection', {}, short(msg.selection.text, 140))
          : null,
        isUser
          ? h('p.article-msg-text', {}, msg.content)
          : h('div.article-msg-md', {}, renderMarkdown(msg.content)),
      ]));
    }

    if (chatBusy) {
      list.appendChild(h('div.article-chat-thinking', {}, [h('span.import-spinner'), '正在读这一段…']));
    }
    if (chatError) {
      list.appendChild(h('div.notice.alert.mt2', {}, [
        h('strong', {}, '这次没有回答出来'),
        h('div.small.mt1', {}, chatError.message || String(chatError)),
        chatError.code === 'ai-unavailable'
          ? h('button.btn.small.mt1', { onclick: () => ctx.navigate('/settings') }, '去设置里连接模型')
          : null,
      ]));
    }

    const sel = activeSelection;
    const selectionChip = sel
      ? h('div.chat-selection-chip', {}, [
          h('span.chat-selection-label', {}, '引用'),
          h('span.chat-selection-text', {}, short(sel.text, 80)),
          h('button.chat-selection-clear', {
            title: '不引用这段',
            onclick: () => { activeSelection = null; paintRail(); },
          }, '×'),
        ])
      : h('p.tiny.muted.chat-selection-none', {}, '没有引用选中文字，会按当前阅读位置附近的原文回答。');

    const input = h('textarea.article-chat-input', {
      rows: 3,
      value: chatDraft,
      placeholder: '问这一篇的问题…',
      oninput: (e) => { chatDraft = e.target.value; },
    });
    const send = h('button.btn.primary.small', {
      disabled: chatBusy,
      onclick: () => sendChat(),
    }, chatBusy ? '回答中…' : '发送');

    return h('div.article-chat', {}, [
      h('div.article-chat-note', {}, [
        h('span', {}, provider === 'real'
          ? '当前是远程模型：这一篇的相关原文会发送到设置里的接口。'
          : provider === 'ollama' ? '当前是本机 Ollama：原文只在这台电脑上处理。' : '当前是本地规则引擎，还没有文章问答能力。'),
        h('span', {}, '不会创建待办，也不会修改文章。'),
      ]),
      list,
      h('div.article-chat-compose', {}, [selectionChip, input, h('div.article-chat-actions', {}, [
        h('button.btn.small.ghost', {
          onclick: async () => {
            if (!chatMessages.length) return;
            const ok = await confirmDialog('清空这篇文章的对话？', '只删除这一篇的问答记录，文章、高亮和生词本都不受影响。', '清空');
            if (!ok) return;
            try {
              await api.clearArticleChat(detail.id);
              chatMessages = [];
              chatError = null;
              paintRail();
              toast('对话已清空。');
            } catch (err) { toastError(err); }
          },
        }, '清空'),
        send,
      ])]),
    ]);
  }

  async function sendChat() {
    const question = chatDraft.trim();
    if (!question || chatBusy) return;
    if (!(await allowRemote('文章问答会把这一篇的相关原文和你的问题发出去。'))) return;
    chatBusy = true;
    chatError = null;
    paintRail();
    try {
      const selection = activeSelection
        ? {
            paragraphId: activeSelection.paragraphId,
            start: activeSelection.start,
            end: activeSelection.end,
            text: activeSelection.text,
            mode: activeSelection.mode,
          }
        : null;
      const result = await api.sendArticleMessage(detail.id, question, selection);
      if (disposed) return;
      chatMessages = result.messages || [];
      chatDraft = '';
    } catch (err) {
      chatError = err;
    } finally {
      chatBusy = false;
      if (!disposed) paintRail();
    }
  }

  // ---------------------------------------------------------------- 小工具

  function paragraphElementOf(node) {
    let el = node && node.nodeType === 3 ? node.parentNode : node;
    while (el && el.nodeType === 1) {
      if (el.dataset && el.dataset.paragraphId) return el;
      el = el.parentNode;
    }
    return null;
  }

  function findParagraphElement(paragraphId) {
    for (const el of paragraphHost.querySelectorAll('.article-block')) {
      if (el.dataset && el.dataset.paragraphId === paragraphId) return el;
    }
    return null;
  }

  function paragraphTextOf(paragraphId) {
    const paragraph = paragraphs.find((p) => p.id === paragraphId);
    return paragraph ? paragraph.text : '';
  }

  function selectRangeVisual(el, start, end) {
    if (typeof document.createTreeWalker !== 'function' || typeof NodeFilter === 'undefined') return;
    try { setSelectionRangeInParagraph(el, start, end); } catch { /* 选不中也不影响查词 */ }
  }

  function showSelectionTools(selection, x, y) {
    const rect = (() => {
      try {
        const sel = window.getSelection && window.getSelection();
        if (sel && sel.rangeCount && sel.getRangeAt(0).getBoundingClientRect) {
          return sel.getRangeAt(0).getBoundingClientRect();
        }
      } catch { /* ignore */ }
      return null;
    })();
    const width = (window.innerWidth || 1200);
    let left = rect ? rect.left : x;
    let top = rect ? rect.bottom + 10 : y - 20;
    left = Math.max(10, Math.min(left, width - 280));
    if (rect && top > (window.innerHeight || 800) - 70) top = rect.top - 52;
    selectionTools.style.left = `${left}px`;
    selectionTools.style.top = `${Math.max(70, top)}px`;
    selectionTools.classList.remove('is-hidden');
    selectionTools.dataset.quote = short(selection.text, 80);
  }

  function hideSelectionTools() {
    selectionTools.classList.add('is-hidden');
  }

  // ---------------------------------------------------------------- 启动

  applyFont();
  paintParagraphs();
  paintRail();
  restoreProgress();
  window.addEventListener('scroll', onScroll, { passive: true });

  return function cleanup() {
    disposed = true;
    clearTimeout(saveTimer);
    clearTimeout(fontTimer);
    clearTimeout(clickTimer);
    if (typeof window.removeEventListener === 'function') window.removeEventListener('scroll', onScroll);
    persistProgress();
  };
}
