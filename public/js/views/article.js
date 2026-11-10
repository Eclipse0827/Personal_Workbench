/**
 * 外刊阅读器
 * ---------------------------------------------------------------
 * 左边是文章正文，右边是词汇 / 批注 / 文章问答 / 题目四个面板。
 * 高亮和批注只记录段落内字符偏移，改字号不会错位。
 *
 * 查词和问答只把选中内容和附近原文发给当前引擎；
 * 当前是本地规则引擎时明确说没有释义能力，不伪造词典内容。
 * 选择题只在本机解析和保存，不经过任何模型。
 */

import { api } from '../api.js';
import {
  h, toast, toastError, confirmDialog, modal, fmtRelative, PROVIDER_LABEL,
} from '../ui.js';
import { state } from '../state.js';
import { renderMarkdown } from '../markdown.js';
import {
  HIGHLIGHT_COLORS, highlightColor,
  renderArticleParagraph, selectionOffsets, caretOffset,
  wordRangeAt, sentenceRangeAt, setSelectionRangeInParagraph,
} from '../article-text.js';
import { parseQuizText } from '../article-quiz.js';
import { dictionaryLinks } from '../dictionaries.js';

const FONT_MIN = 16;
const FONT_MAX = 26;
const KIND_LABEL = { word: '单词', phrase: '短语', sentence: '句子' };
const HIGHLIGHT_COLOR_LABEL = {
  yellow: '黄色',
  green: '绿色',
  blue: '蓝色',
  purple: '紫色',
};

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
  let activeHighlightId = null;
  let lastHighlightColor = 'yellow';
  let readingMode = false;
  let lookupResult = null;
  let lookupSelectionRef = null;
  let lookupError = null;
  let lookupBusy = false;
  let lookupSeq = 0;
  let lookupStartedAt = 0;
  let lookupClock = null;
  let lookupClockText = null;
  let chatDraft = '';
  let chatError = null;
  let chatBusy = false;
  let quiz = detail.quiz || null;
  let quizAnswerBusy = false;
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

  const readingToggle = h('button.btn.small.ghost.article-reading-toggle', {
    title: '阅读模式下不响应选词、查词、高亮、批注和加生词本',
    onclick: () => setReadingMode(!readingMode),
  }, '阅读模式');

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
      readingToggle,
      railToggle,
    ]),
  ]);

  const paragraphHost = h('div.article-text');
  const finishHost = h('section.article-finish');
  let finishedAt = detail.finishedAt || null;
  let finishBusy = false;
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
    finishHost,
    h('footer.article-foot', {}, [
      h('span.tiny.muted', {}, '选中文字可以高亮、批注或查词；高亮可选黄 / 绿 / 蓝 / 紫，批注只用赭色下划线、鼠标悬停显示内容。点已高亮的词也会查词，批注在右侧查看。想安静读书时可以切到「阅读模式」。当前文章只作为这次阅读的上下文，不会写进长期 AI 记忆。'),
    ]),
  ]);

  const rail = h('aside.article-rail');
  const body = h('div.article-body', {}, [read, rail]);
  shell.appendChild(bar);
  shell.appendChild(body);

  // ---------------------------------------------------------------- 选区工具条

  const highlightToolDot = h(`span.article-tool-dot.hl-${lastHighlightColor}`);

  function rememberHighlightColor(color) {
    lastHighlightColor = highlightColor(color);
    highlightToolDot.className = `article-tool-dot hl-${lastHighlightColor}`;
  }

  const selectionTools = h('div.selection-tools.is-hidden', { onmousedown: (e) => e.preventDefault() }, [
    h('button.article-tool', { onclick: () => lookupSelection(activeSelection) }, '解释'),
    h('button.article-tool', { onclick: () => openAnnotate() }, '批注'),
    h('button.article-tool', {
      title: '用当前颜色高亮，也可以在右边直接选颜色',
      onclick: () => createHighlight(''),
    }, ['高亮', highlightToolDot]),
    h('div.selection-colors', {}, HIGHLIGHT_COLORS.map((color) => h(`button.article-color.hl-${color}`, {
      type: 'button',
      title: `${HIGHLIGHT_COLOR_LABEL[color]}高亮`,
      'aria-label': `${HIGHLIGHT_COLOR_LABEL[color]}高亮`,
      onclick: () => createHighlight('', color),
    }))),
    h('button.article-tool', { onclick: () => addSelectionToVocabulary() }, '＋ 生词本'),
  ]);
  shell.appendChild(selectionTools);

  const noteTipText = h('p.article-note-tip-text');
  const noteTip = h('div.article-note-tip.is-hidden', { role: 'tooltip' }, [
    h('div.article-note-tip-label', {}, '批注'),
    noteTipText,
  ]);
  shell.appendChild(noteTip);
  let noteTipTimer = null;

  // ---------------------------------------------------------------- 正文事件

  paragraphHost.onmouseup = (e) => {
    if (readingMode) return;
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

  paragraphHost.onmousedown = () => {
    if (readingMode) {
      hideNoteTip();
      return;
    }
    activeHighlightId = null;
    hideSelectionTools();
  };

  paragraphHost.onclick = (e) => {
    if (readingMode) return;
    const el = paragraphElementOf(e.target);
    if (!el) return;
    if (selectionOffsets(el)) return;
    activeHighlightId = highlightIdOf(e.target);
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
    if (readingMode) return;
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

  paragraphHost.addEventListener('mouseover', (e) => {
    const mark = noteMarkOf(e.target);
    if (!mark) return;
    clearTimeout(noteTipTimer);
    noteTipTimer = setTimeout(() => {
      if (!disposed) showNoteTip(mark);
    }, 160);
  });

  paragraphHost.addEventListener('mouseout', (e) => {
    if (!noteMarkOf(e.target)) return;
    clearTimeout(noteTipTimer);
    hideNoteTip();
  });

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
    hideNoteTip();
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

  // ---------------------------------------------------------------- 读完标记

  function paintFinish() {
    const done = Boolean(finishedAt);
    finishHost.replaceChildren(
      h('div.article-finish-copy', {}, [
        h('div.article-finish-title', {}, done ? '这篇已经读完了' : '读到这里了吗？'),
        h('p.small.muted', {}, done
          ? `标记于 ${fmtRelative(finishedAt)}。整篇文章记为已读完，阅读位置不受影响。`
          : '点下面的按钮，把整篇文章记为已读完。书架里会显示「已读完」，也可以随时撤销。'),
      ]),
      h(`button.btn.article-finish-btn${done ? '' : '.primary'}`, {
        disabled: finishBusy,
        onclick: () => setFinished(!done),
      }, finishBusy ? '正在保存…' : (done ? '撤销已读' : '已阅读完毕'))
    );
  }

  async function setFinished(next) {
    if (finishBusy) return;
    finishBusy = true;
    paintFinish();
    try {
      const value = await api.setArticleFinished(detail.id, next);
      finishedAt = value || null;
      detail.finishedAt = finishedAt;
      toast(finishedAt ? '这篇已经标记为读完了。' : '已撤销「读完」标记。');
    } catch (err) {
      toastError(err);
    } finally {
      finishBusy = false;
      if (!disposed) paintFinish();
    }
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
      byParagraph.get(paragraph.id) || []
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
        tabButton('quiz', quizCount() ? `题目 ${quizCount()}` : '题目'),
      ]),
      h('button.article-rail-close', {
        title: '收起侧栏',
        onclick: () => shell.classList.remove('rail-open'),
      }, '×'),
    ]);

    let panel;
    if (railTab === 'notes') panel = renderNotesPanel();
    else if (railTab === 'chat') panel = renderChatPanel();
    else if (railTab === 'quiz') panel = renderQuizPanel();
    else panel = renderLookupPanel();

    rail.replaceChildren(head, h('div.article-rail-body', {}, panel));
  }

  // ---------------------------------------------------------------- 查词

  function renderWordLine(item) {
    return h('div.lookup-word', {}, [
      h('span.lookup-word-term', {}, item.word),
      item.partOfSpeech ? h('span.lookup-word-pos', {}, item.partOfSpeech) : null,
      item.meaningZh ? h('span.lookup-word-meaning', {}, item.meaningZh) : null,
    ]);
  }

  function activeHighlight() {
    if (!activeHighlightId) return null;
    return (detail.highlights || []).find((hl) => hl.id === activeHighlightId) || null;
  }

  function activeHighlightLine() {
    const highlight = activeHighlight();
    if (!highlight) return null;
    const annotated = Boolean(highlight.note);
    return h('div.lookup-line.lookup-highlight-line', {}, [
      h('span.lookup-label', {}, annotated ? '批注' : '高亮'),
      annotated
        ? h('span.lookup-note-mark', { title: '批注使用赭色下划线' })
        : h('span.lookup-hl-swatch', {
            class: `hl-${highlightColor(highlight.color)}`,
            title: HIGHLIGHT_COLOR_LABEL[highlightColor(highlight.color)],
          }),
      h('button.link-btn', {
        onclick: () => openHighlight(highlight.id),
      }, annotated ? `悬停可看批注：${short(highlight.note, 24)}` : '还没有批注，点这里写一条'),
    ]);
  }

  function lookupElapsedText() {
    const seconds = Math.max(0, Math.round((Date.now() - lookupStartedAt) / 1000));
    const provider = (state.settings && state.settings.aiProvider) || 'mock';
    if (provider === 'ollama') {
      return seconds < 5
        ? '本机模型正在读这段文章，第一次可能要等一两分钟…'
        : `已等待 ${seconds} 秒，本机模型仍在生成，可以先做别的。`;
    }
    if (seconds < 5) return '远程模型通常要 10–60 秒，正在生成…';
    if (seconds < 60) return `已等待 ${seconds} 秒，模型还在生成，请再等等。`;
    return `已等待 ${seconds} 秒还没返回。可以换用更快的 Flash 模型，或稍后重试。`;
  }

  function stopLookupClock() {
    if (lookupClock) {
      clearInterval(lookupClock);
      lookupClock = null;
    }
    lookupClockText = null;
  }

  function startLookupClock() {
    stopLookupClock();
    lookupClock = setInterval(() => {
      if (lookupClockText) lookupClockText.textContent = lookupElapsedText();
    }, 1000);
  }

  function renderLookupPanel() {
    if (lookupBusy) {
      lookupClockText = h('p.small.muted.lookup-clock', {}, lookupElapsedText());
      return h('div.lookup-empty', {}, [
        h('span.import-spinner'),
        lookupClockText,
        activeHighlightLine(),
        providerHint(),
      ]);
    }
    if (lookupError) {
      return h('div.lookup-empty', {}, [
        h('div.notice.alert', {}, [
          h('strong', {}, '这次没有解释出来'),
          h('div.small.mt1', {}, lookupError.message || String(lookupError)),
        ]),
        (lookupError.code === 'ai-unavailable' || lookupError.status === 502)
          ? h('button.btn.small.primary', { onclick: () => ctx.navigate('/settings') }, '去设置里检查模型')
          : null,
        activeHighlightLine(),
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
    const links = entry.kind === 'sentence' ? null : dictionaryLinks(term);

    const exampleRows = (entry.examples || []).map((ex) => h('div.lookup-example', {}, [
      ex.en ? h('p.lookup-example-en', {}, ex.en) : null,
      ex.zh ? h('p.lookup-example-zh', {}, ex.zh) : null,
    ]));
    const oxfordExampleRows = ((entry.oxford && entry.oxford.examples) || []).map((ex) => h('div.lookup-example', {}, [
      ex.en ? h('p.lookup-example-en', {}, ex.en) : null,
      ex.zh ? h('p.lookup-example-zh', {}, ex.zh) : null,
    ]));

    return h('div.lookup-panel', {}, [
      h('div.lookup-head', {}, [
        h('h2.lookup-term', {}, term),
        h('span.lookup-kind', {}, KIND_LABEL[entry.kind] || '词'),
      ]),
      activeHighlightLine(),
      entry.partOfSpeech ? h('div.lookup-line', {}, [h('span.lookup-label', {}, '词性'), h('span', {}, entry.partOfSpeech)]) : null,
      entry.structure ? h('div.lookup-line', {}, [h('span.lookup-label', {}, '句子结构'), h('span', {}, entry.structure)]) : null,
      entry.definitionEn ? h('section.lookup-section', {}, [
        h('div.lookup-label', {}, entry.dictionarySource === 'oxford' ? '英文解释 · 牛津词典' : '英文解释'),
        h('p.lookup-en', {}, entry.definitionEn),
      ]) : null,
      entry.definitionZh ? h('section.lookup-section', {}, [
        h('div.lookup-label', {}, '中文解释'),
        h('p.lookup-zh', {}, entry.definitionZh),
      ]) : null,
      oxfordExampleRows.length ? h('section.lookup-section', {}, [
        h('div.lookup-label', {}, '牛津词典例句'),
        ...oxfordExampleRows,
      ]) : null,
      (entry.collocations || []).length ? h('section.lookup-section', {}, [
        h('div.lookup-label', {}, '常见搭配'),
        h('div.lookup-chips', {}, entry.collocations.map((item) => h('span.lookup-chip', {}, item))),
      ]) : null,
      (entry.derivatives || []).length ? h('section.lookup-section', {}, [
        h('div.lookup-label', {}, '派生词'),
        h('div.lookup-word-list', {}, entry.derivatives.map(renderWordLine)),
      ]) : null,
      (entry.relatedWords || []).length ? h('section.lookup-section', {}, [
        h('div.lookup-label', {}, '衍生词'),
        h('div.lookup-word-list', {}, entry.relatedWords.map(renderWordLine)),
      ]) : null,
      exampleRows.length ? h('section.lookup-section', {}, [
        h('div.lookup-label', {}, '例句 · 常见用法'),
        h('p.small.muted', {}, '另写的常见用法例句，不摘自这篇文章。'),
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
      links ? h('div.lookup-dict-links', {}, [
        h('a.link-btn', { href: links.oxford, target: '_blank', rel: 'noopener' }, '在牛津词典查看 ↗'),
        h('a.link-btn', { href: links.eudic, target: '_blank', rel: 'noopener' }, '在欧路词典查看 ↗'),
      ]) : null,
      entry.dictionaryError ? h('p.lookup-disclaimer.warn', {}, entry.dictionaryError) : null,
      h('p.lookup-disclaimer', {}, [
        entry.dictionarySource === 'oxford'
          ? `英文释义与例句来自牛津词典（Oxford Dictionaries API）；中文解释、搭配和语境含义由${providerLabel(lookupResult.provider || entry.provider)}补充。`
          : `由${providerLabel(lookupResult.provider || entry.provider)}根据当前文章上下文生成，不是牛津 / 朗文等词典的官方释义。`,
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
      return h('p.lookup-hint', {}, '当前是远程模型：选中的文字和附近原文会发送到设置里的接口。带思考过程的模型会慢很多，查词一般要 10–60 秒。');
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
    const seq = ++lookupSeq;
    lookupSelectionRef = selection;
    lookupBusy = true;
    lookupError = null;
    lookupStartedAt = Date.now();
    startLookupClock();
    paintRail();
    try {
      const result = await api.lookupArticleText(detail.id, selection);
      if (disposed || seq !== lookupSeq) return null;
      lookupResult = result;
      return result;
    } catch (err) {
      if (disposed || seq !== lookupSeq) return null;
      lookupError = err;
      return null;
    } finally {
      // 只让最新一次请求收尾，旧请求晚回来不能覆盖新结果或关掉等待状态
      if (seq === lookupSeq) {
        lookupBusy = false;
        stopLookupClock();
        if (!disposed) paintRail();
      }
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

  function colorPicker(initial) {
    let current = highlightColor(initial);
    const buttons = [];
    const node = h('div.article-color-row', {}, [
      h('span.article-color-label', {}, '高亮颜色'),
      ...HIGHLIGHT_COLORS.map((color) => {
        const button = h(`button.article-color.hl-${color}${color === current ? '.active' : ''}`, {
          type: 'button',
          title: HIGHLIGHT_COLOR_LABEL[color],
          'aria-label': `${HIGHLIGHT_COLOR_LABEL[color]}高亮`,
          onclick: () => {
            current = color;
            for (const item of buttons) item.classList.toggle('active', item === button);
          },
        });
        buttons.push(button);
        return button;
      }),
    ]);
    return { node, get color() { return current; } };
  }

  async function createHighlight(note, color = lastHighlightColor) {
    const selection = activeSelection;
    if (!selection) {
      toast('先选中一段文字。', 'warn');
      return false;
    }
    const chosen = note ? 'yellow' : highlightColor(color);
    try {
      const highlight = await api.addHighlight(detail.id, {
        paragraphId: selection.paragraphId,
        start: selection.start,
        end: selection.end,
        note,
        color: chosen,
      });
      detail.highlights = [...(detail.highlights || []), highlight];
      if (!note) rememberHighlightColor(chosen);
      paintParagraphs();
      paintRail();
      hideSelectionTools();
      toast(note ? '批注已保存。' : `已用${HIGHLIGHT_COLOR_LABEL[chosen]}高亮。`);
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
        h('p.tiny.muted', {}, '批注只加赭色下划线，不再铺高亮底色；鼠标悬停就能看到批注内容。'),
        input,
      ]),
      actions: [
        { label: '取消' },
        {
          label: '保存批注',
          primary: true,
          onClick: async () => {
            const note = input.value.trim();
            if (!note) {
              toast('写点内容再保存批注。', 'warn');
              return false;
            }
            const ok = await createHighlight(note);
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
    const picker = highlight.note ? null : colorPicker(highlight.color);
    modal({
      title: highlight.note ? '这条批注' : '这条高亮',
      body: h('div', {}, [
        h('blockquote.article-quote', {}, highlight.quote),
        picker ? picker.node : null,
        input,
        h('p.tiny.muted.mb0', {}, highlight.note
          ? '批注只用赭色下划线显示；把内容清空并保存，就会变回普通高亮。'
          : `上次修改于 ${fmtRelative(highlight.updatedAt || highlight.createdAt)}`),
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
              const note = input.value.trim();
              const color = picker ? picker.color : highlight.color;
              const updated = await api.patchHighlight(detail.id, highlight.id, { note, color });
              Object.assign(highlight, updated);
              if (!note) rememberHighlightColor(color);
              paintParagraphs();
              paintRail();
              toast(note ? '批注已保存。' : '已改回普通高亮。');
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

    return h('div.notes-list', {}, [
      h('p.notes-legend', {}, [
        h('span', {}, '圆点颜色代表高亮颜色'),
        h('span', {}, '赭色下划线是批注，悬停正文可看'),
      ]),
      ...list.map((hl) => {
        const paragraphIndex = (order.get(hl.paragraphId) || 0) + 1;
        const color = highlightColor(hl.color);
        return h(`div.note-card${hl.note ? '.is-annotation' : `.hl-${color}`}`, {
          role: 'button',
          tabindex: '0',
          onclick: () => openHighlight(hl.id),
          onkeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openHighlight(hl.id); }
          },
        }, [
          h('div.note-card-head', {}, [
            hl.note
              ? h('span.note-underline-mark', { title: '批注使用赭色下划线' })
              : h(`span.note-swatch.hl-${color}`, { title: `${HIGHLIGHT_COLOR_LABEL[color]}高亮` }),
            h(`span.note-kind${hl.note ? '.has-note' : ''}`, {}, hl.note ? '批注' : '仅高亮'),
          ]),
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
      }),
    ]);
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

  // ---------------------------------------------------------------- 选择题

  function quizQuestions() {
    return quiz && Array.isArray(quiz.questions) ? quiz.questions : [];
  }

  function quizCount() {
    return quizQuestions().length;
  }

  function quizStats() {
    const list = quizQuestions();
    let answered = 0;
    let withKey = 0;
    let correct = 0;
    for (const question of list) {
      if (question.answer) withKey += 1;
      if (question.selected) {
        answered += 1;
        if (question.answer && question.selected === question.answer) correct += 1;
      }
    }
    return { total: list.length, answered, withKey, correct };
  }

  function renderQuizOption(question, option) {
    const selected = question.selected || '';
    const keyed = Boolean(question.answer);
    const revealed = Boolean(selected && keyed);
    const isSelected = option.key === selected;
    const isAnswer = keyed && option.key === question.answer;
    let modifier = '';
    if (revealed && isAnswer) modifier = '.correct';
    else if (revealed && isSelected) modifier = '.wrong';
    else if (isSelected) modifier = '.selected';
    return h(`button.article-quiz-option${modifier}`, {
      type: 'button',
      'aria-pressed': isSelected ? 'true' : 'false',
      disabled: quizAnswerBusy,
      onclick: () => selectQuizOption(question, option.key),
    }, [
      h('span.article-quiz-key', {}, option.key),
      h('span.article-quiz-text', {}, option.text),
    ]);
  }

  function renderQuizCard(question, index) {
    const selected = question.selected || '';
    const keyed = Boolean(question.answer);
    const revealed = Boolean(selected && keyed);
    const correct = revealed && selected === question.answer;
    let statusText = '待选择';
    let statusClass = '';
    if (!keyed) {
      statusText = selected ? '已选择' : '没有答案';
    } else if (selected) {
      statusText = correct ? '答对' : '答错';
      statusClass = correct ? '.is-ok' : '.is-bad';
    }

    return h('section.article-quiz-card', {}, [
      h('div.article-quiz-meta', {}, [
        h('span.article-quiz-no', {}, `第 ${index + 1} 题`),
        h(`span.article-quiz-status${statusClass}`, {}, statusText),
      ]),
      h('p.article-quiz-stem', {}, question.stem),
      h('div.article-quiz-options', {}, question.options.map((option) => renderQuizOption(question, option))),
      keyed && revealed
        ? h('p.article-quiz-result', { class: correct ? 'is-ok' : 'is-bad' }, correct
          ? '选对了。'
          : `正确答案是 ${question.answer}。`)
        : null,
      question.explanation && revealed
        ? h('div.article-quiz-explanation', {}, [
            h('div.lookup-label', {}, '解析'),
            h('p', {}, question.explanation),
          ])
        : null,
      !keyed
        ? h('p.tiny.muted.article-quiz-note', {}, '这组题没有提供答案，你的选择会保存，但不会判对错。')
        : null,
      selected
        ? h('div.article-quiz-card-actions', {}, [
            h('button.link-btn', {
              disabled: quizAnswerBusy,
              onclick: () => selectQuizOption(question, ''),
            }, '重做本题'),
          ])
        : null,
    ]);
  }

  function renderQuizPanel() {
    const list = quizQuestions();

    if (!list.length) {
      return h('div.lookup-empty', {}, [
        h('div.lookup-intro-icon', {}, 'A/B'),
        h('h3', {}, '还没有导入题目'),
        h('p.small.muted', {}, '把复制来的选择题粘贴进来，会拆成题干、选项和答案，变成可以直接点的题目。'),
        h('p.small.muted', {}, '支持「1. 题干」加 A–D 选项；「答案：B」和解析可以一起粘贴。'),
        h('div.article-quiz-actions', {}, [
          h('button.btn.small.primary', { onclick: openQuizImport }, '导入选择题'),
        ]),
        h('p.lookup-hint', {}, '解析和保存都在本地完成，不会把题目发给任何模型。'),
      ]);
    }

    const stats = quizStats();
    return h('div.article-quiz', {}, [
      h('div.article-quiz-head', {}, [
        h('div.article-quiz-count', {}, [
          h('strong', {}, `共 ${stats.total} 题`),
          h('span.small.muted', {}, ` · 已答 ${stats.answered}`),
          stats.withKey ? h('span.small.muted', {}, ` · 答对 ${stats.correct}`) : null,
        ]),
        quiz.importedAt
          ? h('span.tiny.muted', {}, `导入于 ${fmtRelative(quiz.importedAt)}`)
          : null,
        h('div.article-quiz-actions', {}, [
          h('button.btn.small.ghost', { onclick: openQuizImport }, '重新导入'),
          h('button.btn.small.ghost', { onclick: clearQuizQuestions }, '清空'),
        ]),
      ]),
      ...list.map(renderQuizCard),
    ]);
  }

  function repaintQuizPreservingScroll() {
    const bodyEl = rail.querySelector('.article-rail-body');
    const top = bodyEl ? Number(bodyEl.scrollTop) || 0 : 0;
    paintRail();
    if (!top) return;
    const next = rail.querySelector('.article-rail-body');
    if (next) next.scrollTop = top;
  }

  async function selectQuizOption(question, key) {
    if (quizAnswerBusy) return;
    const previous = question.selected || '';
    if (previous === key) return;
    quizAnswerBusy = true;
    question.selected = key;
    repaintQuizPreservingScroll();
    try {
      const next = await api.saveQuizAnswer(detail.id, question.id, key);
      if (disposed) return;
      if (next) quiz = next;
    } catch (err) {
      question.selected = previous;
      toastError(err);
    } finally {
      quizAnswerBusy = false;
      if (!disposed) repaintQuizPreservingScroll();
    }
  }

  function openQuizImport() {
    const hasQuiz = quizCount() > 0;
    const input = h('textarea.article-quiz-input', {
      rows: 12,
      placeholder: '1. The author mentions the study mainly to…\nA. explain the cause\nB. question a common belief\nC. describe a new policy\nD. compare two countries\n答案：B\n解析：第二段用转折引出不同看法。',
    });
    const preview = h('p.tiny.muted.article-quiz-preview', {}, '粘贴后会在本机自动识别题干、选项和答案。');
    const error = h('p.article-quiz-error');

    const updatePreview = () => {
      if (!input.value.trim()) {
        preview.textContent = '粘贴后会在本机自动识别题干、选项和答案。';
        return;
      }
      try {
        const parsed = parseQuizText(input.value);
        const notes = [];
        if (parsed.skipped) notes.push(`跳过 ${parsed.skipped} 段`);
        if (parsed.truncated) notes.push('只保留前 50 道题');
        preview.textContent = `识别到 ${parsed.questions.length} 道题${notes.length ? `，${notes.join('，')}` : ''}。`;
      } catch {
        preview.textContent = '还没有识别到完整的题目，继续粘贴或检查选项是不是分行的。';
      }
    };
    input.oninput = updatePreview;

    modal({
      title: hasQuiz ? '重新导入选择题' : '导入选择题',
      wide: true,
      body: h('div.article-quiz-import', {}, [
        input,
        preview,
        error,
        h('p.tiny.muted.mb0', {}, '答案写在选项后面或单独一行都可以。重新导入会替换这组题，之前的选择记录会清掉。'),
      ]),
      actions: [
        { label: '取消' },
        {
          label: '识别并保存',
          primary: true,
          onClick: async () => {
            let parsed;
            try {
              parsed = parseQuizText(input.value);
            } catch (err) {
              error.textContent = err.message || String(err);
              return false;
            }
            error.textContent = '';
            try {
              const saved = await api.saveArticleQuiz(detail.id, parsed.questions);
              quiz = saved;
              railTab = 'quiz';
              paintRail();
              const notes = [];
              if (parsed.skipped) notes.push(`跳过 ${parsed.skipped} 段不完整的文字`);
              if (parsed.truncated) notes.push('只保留了前 50 道题');
              toast(`已导入 ${parsed.questions.length} 道题。${notes.length ? `${notes.join('，')}。` : ''}`);
            } catch (err) {
              error.textContent = err.message || String(err);
              return false;
            }
          },
        },
      ],
    });
  }

  async function clearQuizQuestions() {
    if (!quizCount()) return;
    const ok = await confirmDialog(
      '清空这篇文章的选择题？',
      '只会删除导入的题目和这次的选择记录，文章、高亮和生词本都不受影响。',
      '清空'
    );
    if (!ok) return;
    try {
      await api.clearArticleQuiz(detail.id);
      quiz = null;
      paintRail();
      toast('题目已清空。');
    } catch (err) {
      toastError(err);
    }
  }

  // ---------------------------------------------------------------- 小工具

  function noteMarkOf(node) {
    let el = node && node.nodeType === 3 ? node.parentNode : node;
    while (el && el.nodeType === 1) {
      if (el.dataset && el.dataset.noteId) return el;
      el = el.parentNode;
    }
    return null;
  }

  function showNoteTip(mark) {
    const highlight = (detail.highlights || []).find((hl) => hl.id === mark.dataset.noteId);
    if (!highlight || !highlight.note) {
      hideNoteTip();
      return;
    }
    noteTipText.textContent = highlight.note;
    noteTip.classList.remove('is-hidden');
    const rect = typeof mark.getBoundingClientRect === 'function' ? mark.getBoundingClientRect() : null;
    const viewportWidth = Number(window.innerWidth) || 960;
    const viewportHeight = Number(window.innerHeight) || 720;
    const tipWidth = Number(noteTip.offsetWidth) || 280;
    const tipHeight = Number(noteTip.offsetHeight) || 96;
    let left = rect ? rect.left + rect.width / 2 - tipWidth / 2 : 24;
    left = Math.max(12, Math.min(left, viewportWidth - tipWidth - 12));
    let top = rect ? rect.bottom + 9 : 90;
    if (rect && top + tipHeight > viewportHeight) top = Math.max(12, rect.top - tipHeight - 9);
    noteTip.style.left = `${left}px`;
    noteTip.style.top = `${top}px`;
  }

  function hideNoteTip() {
    clearTimeout(noteTipTimer);
    noteTip.classList.add('is-hidden');
  }

  function setReadingMode(next) {
    readingMode = Boolean(next);
    shell.classList.toggle('is-reading-mode', readingMode);
    readingToggle.classList.toggle('is-on', readingMode);
    readingToggle.textContent = readingMode ? '退出阅读模式' : '阅读模式';
    shell.classList.remove('rail-open');
    clearTimeout(clickTimer);
    hideSelectionTools();
    hideNoteTip();
    if (readingMode) activeSelection = null;
    toast(readingMode
      ? '已进入阅读模式：选词、查词、高亮、批注和加生词本会暂时停用。'
      : '已退出阅读模式。');
  }

  function paragraphElementOf(node) {
    let el = node && node.nodeType === 3 ? node.parentNode : node;
    while (el && el.nodeType === 1) {
      if (el.dataset && el.dataset.paragraphId) return el;
      el = el.parentNode;
    }
    return null;
  }

  function highlightIdOf(node) {
    let el = node && node.nodeType === 3 ? node.parentNode : node;
    while (el && el.nodeType === 1) {
      if (el.dataset && el.dataset.highlightIds) {
        return el.dataset.highlightIds.split(',')[0] || null;
      }
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
  paintFinish();
  paintRail();
  restoreProgress();
  window.addEventListener('scroll', onScroll, { passive: true });

  return function cleanup() {
    disposed = true;
    clearTimeout(saveTimer);
    clearTimeout(fontTimer);
    clearTimeout(clickTimer);
    clearTimeout(noteTipTimer);
    stopLookupClock();
    if (typeof window.removeEventListener === 'function') window.removeEventListener('scroll', onScroll);
    persistProgress();
  };
}
