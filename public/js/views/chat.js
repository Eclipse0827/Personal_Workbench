/**
 * 页面三：AI 整理空间（对话）
 * ---------------------------------------------------------------
 * 这一页的目标是「像在聊天」，而不是「填一句、吐一张卡」。
 *
 * 所以做的几件事：
 *   · AI 的回复不带气泡、不带边框 —— 就是一段话，一段一个气泡，读起来像连着说了几句
 *   · 「问题梳理」收起来，变成一个可以点开的小标题，不再是一张镶边的卡
 *   · 「建议」直接长在对话里，一行一句，右边一个「加入待办」；不喊「方案卡」
 *   · 每条回复后面给两三个快捷回话，让对话能接下去
 *   · 输入框 Enter 发送、Shift+Enter 换行
 *   · 正在输入显示三个跳动的点
 *
 * 产品约束照旧（PRD 2.4 / 8.3 / 8.4）：
 *   · 不需要先选情绪类型；不强制填感受/事实/猜测/担忧
 *   · 梳理内容只呈现真正需要的栏目，且每一项都能改、能删
 *   · 建议必须由用户确认才创建任务；可只选部分；重复确认不重复创建
 *   · 只想倾诉时不推计划
 *   · 每条回复都如实标注是哪个引擎说的
 */

import { api } from '../api.js';
import {
  h, toast, toastError, modal, confirmDialog,
  fmtDateTime, fmtRelative, truncate,
} from '../ui.js';
import { state } from '../state.js';

export default async function renderChat(root, ctx) {
  const convId = ctx.args.id;
  let conversation;
  try {
    conversation = await api.getConversation(convId);
  } catch (err) {
    root.appendChild(h('div.page', {}, [
      h('div.empty', {}, [
        h('div.big', {}, '◌'),
        h('div', {}, '找不到这个对话。'),
        h('div.mt2', {}, [h('button.btn', { onclick: () => ctx.navigate('/chat') }, '← 回到对话列表')]),
      ]),
    ]));
    return;
  }

  let sending = false;
  let sendError = null;
  let sendErrorText = '';

  const thread = h('div.chat-thread');
  const composerWrap = h('div.chat-composer-wrap');

  function scrollToBottom() {
    requestAnimationFrame(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    });
  }

  // ---------------------------------------------------------------- 问题梳理（可折叠，不是卡片）

  function problemBlock(msg) {
    const card = msg.problemCard;
    if (!card) return null;

    async function save(field, value) {
      const payload = {};
      payload[field] = value;
      try {
        await api.patchProblemCard(conversation.id, msg.id, payload);
        toast('记下了，以你改的为准。');
      } catch (err) { toastError(err); }
    }

    function editableList(field, items, placeholder) {
      const list = items.slice();
      const ul = h('ul.card-list');

      function paint() {
        ul.replaceChildren(
          ...list.map((text, i) =>
            h('li', {}, [
              h('span.txt', {
                contenteditable: 'true',
                spellcheck: 'false',
                onblur: (e) => {
                  const v = e.target.textContent.trim();
                  if (!v) { e.target.textContent = text; return; }
                  if (v === text) return;
                  list[i] = v;
                  save(field, list);
                },
                onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
              }, text),
              h('button.icon-btn.danger', {
                title: '删掉这一条',
                onclick: () => { list.splice(i, 1); paint(); save(field, list); },
              }, '×'),
            ])
          )
        );
        if (!list.length) ul.appendChild(h('li.placeholder', {}, [h('span.txt', {}, placeholder)]));
      }
      paint();

      const input = h('input', {
        type: 'text',
        placeholder: '补充一条…',
        onkeydown: (e) => {
          if (e.key !== 'Enter') return;
          const v = e.target.value.trim();
          if (!v) return;
          list.push(v);
          e.target.value = '';
          paint();
          save(field, list);
        },
      });

      return h('div.card-block', {}, [
        ul,
        h('div.add-row', {}, [input, h('span.tiny.muted.nowrap', { style: { alignSelf: 'center' } }, '回车添加')]),
      ]);
    }

    const body = h('div.problem-body.collapsed');

    // 内容：只在真的有内容时才出现，空栏目不硬塞
    if (card.summary) {
      body.appendChild(h('div.card-summary', {
        contenteditable: 'true',
        spellcheck: 'false',
        onblur: (e) => {
          const v = e.target.textContent.trim();
          if (!v || v === card.summary) return;
          save('summary', v);
        },
      }, card.summary));
    }
    body.appendChild(h('div.card-section', {}, [
      h('div.card-label', {}, '你说的困难'),
      editableList('expressed', card.expressed || [], '还没有识别出来，可以自己补一条'),
    ]));
    if ((card.unknowns || []).length) {
      body.appendChild(h('div.card-section', {}, [
        h('div.card-label', {}, '还没确定的信息'),
        editableList('unknowns', card.unknowns, ''),
      ]));
    }
    if ((card.directions || []).length) {
      body.appendChild(h('div.card-section', {}, [
        h('div.card-label', {}, '可以想想的方向'),
        editableList('directions', card.directions, ''),
      ]));
    }
    if (card.emotion) {
      body.appendChild(h('div.card-section', {}, [
        h('div.card-label', {}, '情绪和身体'),
        h('p.small.muted', { style: { margin: '0 0 6px' } }, card.emotion.notice),
        h('ul.card-list', {}, (card.emotion.items || []).map((x) =>
          h('li', {}, [h('span.txt.small', {}, x)]))),
        h('button.btn.small.ghost.mt1', {
          onclick: async () => {
            try {
              await api.patchProblemCard(conversation.id, msg.id, { emotion: null });
              toast('去掉了这一栏。');
              await repaint();
            } catch (err) { toastError(err); }
          },
        }, '我不是在说情绪，去掉这一栏'),
      ]));
    }

    const chev = h('span.chev', {}, '▶');
    const toggle = h('button.problem-toggle', {
      type: 'button',
      onclick: () => {
        const open = body.classList.toggle('collapsed') === false;
        toggle.classList.toggle('open', open);
      },
    }, [chev, '问题梳理（可以点开改）']);

    return h('div.problem-card', {}, [toggle, body]);
  }

  // ---------------------------------------------------------------- 建议（长在对话里）

  function suggestionBlock(prop) {
    if (!prop) return null;
    const isPending = prop.status === 'pending';
    const selected = new Set(prop.actions.filter((a) => !a.createdTaskId).map((a) => a.id));
    let planId = '';

    const actionsEl = h('div.proposal-actions');

    async function saveAction(actionId, patch) {
      if (!isPending) return;
      try {
        const updated = await api.patchProposal(conversation.id, prop.id, {
          actions: [{ id: actionId, ...patch }],
        });
        const fresh = updated.proposals.find((p) => p.id === prop.id);
        if (fresh) Object.assign(prop, fresh);
      } catch (err) { toastError(err); }
    }

    function actionRow(a) {
      const already = Boolean(a.createdTaskId);
      const check = h(`button.check-mini${selected.has(a.id) && !already ? '.on' : ''}${already ? '.done' : ''}`, {
        type: 'button',
        disabled: !isPending || already,
        title: already ? '这一条已经在待办里了' : '选择 / 取消选择',
        onclick: () => {
          if (already) return;
          if (selected.has(a.id)) selected.delete(a.id); else selected.add(a.id);
          paintActions();
        },
      }, already || selected.has(a.id) ? '✓' : '');

      const titleInput = h('input.proposal-title', {
        type: 'text',
        value: a.title,
        disabled: !isPending,
        onblur: () => saveAction(a.id, { title: titleInput.value }),
      });
      const detailInput = h('textarea.proposal-detail', {
        rows: 1,
        value: a.detail || '',
        placeholder: '可以改成你自己会去做的说法',
        disabled: !isPending,
        onblur: () => saveAction(a.id, { detail: detailInput.value }),
      });
      const dateInput = h('input', {
        type: 'date',
        value: a.scheduledDate || '',
        disabled: !isPending,
        onchange: () => saveAction(a.id, { scheduledDate: dateInput.value || null }),
      });

      return h('div.proposal-action', {}, [
        check,
        h('div.proposal-action-body', {}, [
          titleInput,
          detailInput,
          h('div.proposal-action-meta', {}, [
            h('label.inline-field', {}, [h('span.tiny.muted', {}, '哪天做'), dateInput]),
            a.estimateMinutes ? h('span.tag.tiny', {}, `约 ${a.estimateMinutes} 分钟`) : null,
            already ? h('span.tag.accent.tiny', {}, '已在待办里') : null,
          ]),
        ]),
      ]);
    }

    function paintActions() {
      actionsEl.replaceChildren(...prop.actions.map(actionRow));
    }
    paintActions();

    const planSelect = isPending
      ? h('select', { onchange: (e) => { planId = e.target.value; } }, [
          h('option', { value: '' }, '不关联计划'),
          ...state.plans.filter((p) => p.status === 'active').map((p) => h('option', { value: p.id }, p.title)),
        ])
      : null;

    async function confirmSelected(ids) {
      const chosen = ids || [...selected];
      if (!chosen.length) {
        toast('至少选一条。也可以整块跳过。', 'warn');
        return;
      }
      try {
        const r = await api.confirmProposal(conversation.id, prop.id, { actionIds: chosen, planId: planId || null });
        const created = r.created || [];
        const skipped = r.skipped || [];
        if (created.length) {
          toast(`加进待办了：${created.length} 条${skipped.length ? `，跳过 ${skipped.length} 条已有的` : ''}。`);
        } else {
          toast(skipped.length ? '这些都已经在待办里了，没有重复添加。' : '没有添加。', 'warn');
        }
        const fresh = r.conversation.proposals.find((p) => p.id === prop.id);
        if (fresh) Object.assign(prop, fresh);
        await ctx.refresh();
        await repaint();
      } catch (err) { toastError(err); }
    }

    async function dismiss() {
      const ok = await confirmDialog('这次先不做？', '不会创建任何任务，这段对话还在。', '先不用');
      if (!ok) return;
      try {
        const updated = await api.dismissProposal(conversation.id, prop.id);
        const fresh = updated.proposals.find((p) => p.id === prop.id);
        if (fresh) Object.assign(prop, fresh);
        toast('好，那就先放着。');
        await repaint();
      } catch (err) { toastError(err); }
    }

    const foot = isPending
      ? h('div.proposal-foot', {}, [
          planSelect ? h('div.proposal-plan', {}, [
            h('span.tiny.muted', {}, '放进计划：'),
            planSelect,
          ]) : null,
          h('div.btn-row', {}, [
            h('button.btn.small.primary', { onclick: () => confirmSelected() }, '加入待办'),
            h('button.btn.small.ghost', { onclick: dismiss }, '先不用'),
            h('span.tiny.muted', { style: { alignSelf: 'center' } }, '可以只勾其中几条，也可以改标题'),
          ]),
          h('div.tiny.muted', {}, '只有你确认之后才会进入待办。'),
        ])
      : h('div.proposal-foot', {}, [
          h('span.tag', {}, prop.status === 'confirmed' ? '已加入待办' : '已跳过'),
          prop.confirmedAt ? h('span.tiny.muted', {}, ` · ${fmtDateTime(prop.confirmedAt)}`) : null,
          prop.status === 'confirmed'
            ? h('button.btn.small.ghost.ml1', { onclick: () => ctx.navigate('/tasks?filter=open') }, '去看待办')
            : null,
        ]);

    return h('div.proposal-card', {}, [
      h('div.proposal-head', {}, [
        h('h4', {}, '我建议可以试试这几步'),
        isPending ? h('span.tag.tiny', {}, '待你确认') : null,
      ]),
      actionsEl,
      prop.pendingItems && prop.pendingItems.length
        ? h('div.pending-block', {}, [
            h('div.card-label', {}, '还没确定，所以先不安排'),
            h('ul.card-list', {}, prop.pendingItems.map((x) => h('li', {}, [h('span.txt.small', {}, x)]))),
            h('div.tiny.muted.mt1', {}, '这些不会进今天的待办。等你确定了再说。'),
          ])
        : null,
      foot,
    ]);
  }

  // ---------------------------------------------------------------- 单条消息

  function providerBadge(msg) {
    if (msg.provider === 'ollama') {
      return h('span.badge-ollama', {
        title: msg.meta && msg.meta.model ? `本机 Ollama 模型：${msg.meta.model}` : '本机 Ollama 生成',
      }, 'Ollama 本地');
    }
    if (msg.provider === 'real') return h('span.badge-real', { title: '远程模型生成' }, '远程模型');
    return h('span.badge-mock', { title: '本地规则引擎生成，不联网' }, '规则引擎');
  }

  function messageNode(msg) {
    if (msg.role === 'user') {
      return h('div.msg.msg-user', {}, [
        h('div.bubble', {}, msg.content),
        h('div.msg-time', {}, fmtRelative(msg.createdAt)),
      ]);
    }

    const prop = msg.proposalId ? (conversation.proposals || []).find((p) => p.id === msg.proposalId) : null;

    // 一段一个气泡：像连续说了几句话，而不是「一条回复 = 一大块」
    const paragraphs = String(msg.content || '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);

    return h('div.msg.msg-ai', {}, [
      h('div.msg-ai-head', {}, [
        h('span.msg-avatar', {}, '缓'),
        h('span.msg-who', {}, 'AI'),
        providerBadge(msg),
        msg.meta && msg.meta.durationMs
          ? h('span.tiny.muted', {}, `${(msg.meta.durationMs / 1000).toFixed(1)}s`)
          : null,
      ]),
      ...paragraphs.map((p) => h('div.bubble', {}, p)),
      problemBlock(msg),
      suggestionBlock(prop),
      h('div.msg-foot', {}, [
        h('span.msg-time', {}, fmtRelative(msg.createdAt)),
        h('button.btn.small.ghost', { onclick: () => openSaveSummary(msg) }, '保存为摘要'),
      ]),
    ]);
  }

  // ---------------------------------------------------------------- 快捷回话

  /**
   * 让对话能接下去。根据最后一轮的状态给不同的选项：
   * 有建议 → 确认/跳过；问了问题 → 直接给几个可能的回答；倾诉 → 继续聊或转成行动。
   */
  function quickReplies() {
    const msgs = conversation.messages || [];
    const last = [...msgs].reverse().find((m) => m.role === 'assistant');
    if (!last || sending) return null;

    const prop = last.proposalId
      ? (conversation.proposals || []).find((p) => p.id === last.proposalId)
      : null;
    const items = [];

    if (prop && prop.status === 'pending') {
      const pendingIds = prop.actions.filter((a) => !a.createdTaskId).map((a) => a.id);
      if (pendingIds.length) {
        items.push({ label: '好，加进待办', primary: true, onclick: () => confirmQuick(prop, pendingIds) });
        items.push({ label: '只想先做第一条', onclick: () => confirmQuick(prop, [pendingIds[0]]) });
      }
      items.push({ label: '这次先不用', onclick: () => dismissQuick(prop) });
      items.push({ label: '我还想说说', onclick: () => focusComposer('我还想说说：') });
    } else {
      const askedModules = /哪几科/.test(last.content);
      const askedType = /什么类型/.test(last.content);
      if (askedModules) {
        items.push({ label: '数学和英语', onclick: () => sendText('我现在主要准备数学和英语。') });
        items.push({ label: '还都没定', onclick: () => sendText('科目还没定，我也不知道该先准备什么。') });
      } else if (askedType) {
        items.push({ label: '是要交的东西', onclick: () => sendText('是一件要交的东西，有截止日期。') });
        items.push({ label: '是学习上的事', onclick: () => sendText('是学习上的事，需要安排时间。') });
      } else {
        items.push({ label: '帮我拆成几件事', onclick: () => sendText('帮我把它拆成几件现在能做的事。') });
        items.push({ label: '我还想多说说', onclick: () => focusComposer('') });
      }
    }

    return h('div.quick-replies', {}, items.map((it) =>
      h(`button.quick-reply${it.primary ? '.primary' : ''}`, { type: 'button', onclick: it.onclick }, it.label)
    ));
  }

  async function confirmQuick(prop, ids) {
    try {
      const r = await api.confirmProposal(conversation.id, prop.id, { actionIds: ids, planId: null });
      const created = r.created || [];
      const skipped = r.skipped || [];
      if (created.length) {
        toast(`加进待办了：${created.length} 条${skipped.length ? `，跳过 ${skipped.length} 条已有的` : ''}。`);
      } else {
        toast(skipped.length ? '这些都已经在待办里了，没有重复添加。' : '没有添加。', 'warn');
      }
      const fresh = r.conversation.proposals.find((p) => p.id === prop.id);
      if (fresh) Object.assign(prop, fresh);
      await ctx.refresh();
      await repaint();
    } catch (err) { toastError(err); }
  }

  async function dismissQuick(prop) {
    try {
      const updated = await api.dismissProposal(conversation.id, prop.id);
      const fresh = updated.proposals.find((p) => p.id === prop.id);
      if (fresh) Object.assign(prop, fresh);
      toast('好，那就先放着。');
      await repaint();
    } catch (err) { toastError(err); }
  }

  function focusComposer(prefix) {
    const ta = composerWrap.querySelector('textarea');
    if (!ta) return;
    ta.focus();
    if (prefix) ta.value = prefix;
  }

  // ---------------------------------------------------------------- 保存摘要

  function openSaveSummary(msg) {
    const card = msg.problemCard;
    const defaultTitle = (conversation.title || '对话摘要').slice(0, 40);
    const lines = [];
    if (card && card.summary) lines.push(card.summary);
    if (card && (card.expressed || []).length) {
      lines.push('');
      lines.push('困难：');
      for (const x of card.expressed) lines.push(`- ${x}`);
    }
    if (card && (card.unknowns || []).length) {
      lines.push('');
      lines.push('还没确定：');
      for (const x of card.unknowns) lines.push(`- ${x}`);
    }
    lines.push('');
    lines.push('AI 的回复：');
    lines.push(msg.content);

    const title = h('input', { type: 'text', value: defaultTitle });
    const content = h('textarea', { rows: 12, value: lines.join('\n') });

    modal({
      title: '保存到我的档案',
      wide: true,
      body: h('div', {}, [
        h('div.notice.quiet', {}, [
          h('strong', {}, '保存的是摘要，不是整段对话。'),
          ' 原始对话会原样留在这里；之后改摘要也不会影响它。',
        ]),
        h('label.field', {}, [h('span.label-text', {}, '标题'), title]),
        h('label.field.mb0', {}, [
          h('span.label-text', {}, '内容'),
          h('span.label-hint', {}, '保存前可以先改。'),
          content,
        ]),
      ]),
      actions: [
        { label: '取消' },
        {
          label: '保存到档案', primary: true,
          onClick: async () => {
            if (!title.value.trim()) { toast('给它起个名字吧。', 'warn'); return false; }
            if (!content.value.trim()) { toast('内容是空的。', 'warn'); return false; }
            try {
              await api.createArchive({
                title: title.value,
                content: content.value,
                type: 'summary',
                sourceConversationId: conversation.id,
              });
              toast('已保存到「我的档案」。');
            } catch (err) {
              toastError(err);
              return false;
            }
          },
        },
      ],
    });
  }

  // ---------------------------------------------------------------- 重绘

  function paintThread() {
    const msgs = conversation.messages || [];
    const ai = state.ai || {};
    const provider = (state.settings && state.settings.aiProvider) || 'mock';

    const smallHint = provider === 'ollama' && ai.ollama && ai.ollama.smallModel
      ? h('div.notice.quiet', {}, [
          h('strong', {}, `当前选的是小模型（${ai.ollama.parameterSize || '—'}）。`),
          ' 它经常写不出合格的措辞，这时回复会退回规则引擎生成，并标注为「规则引擎」——这不是故障。',
        ])
      : null;

    if (!msgs.length) {
      thread.replaceChildren(...[
        smallHint,
        h('div.chat-empty', {}, [
          h('div.chat-empty-icon', {}, '◔'),
          h('div', {}, '想说什么就说什么。'),
          h('div.tiny.muted.mt1', {}, '不用组织语言，也不用先想清楚。'),
        ]),
      ].filter(Boolean));
      return;
    }

    thread.replaceChildren(...[
      smallHint,
      ...msgs.map(messageNode),
      quickReplies(),
    ].filter(Boolean));
  }

  async function repaint() {
    try {
      conversation = await api.getConversation(convId);
    } catch (err) {
      toastError(err);
      return;
    }
    paintThread();
    paintComposer();
  }

  // ---------------------------------------------------------------- 输入框

  function paintComposer() {
    const textarea = h('textarea', {
      rows: 1,
      placeholder: sending ? '正在回…' : '说点什么…（Enter 发送，Shift+Enter 换行）',
      disabled: sending,
      oninput: (e) => {
        e.target.style.height = 'auto';
        e.target.style.height = `${Math.min(200, e.target.scrollHeight)}px`;
      },
      onkeydown: (e) => {
        // 聊天框的直觉：Enter 就发出去，要换行按 Shift
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.isComposing) {
          e.preventDefault();
          send(textarea);
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          send(textarea);
        }
      },
    });

    const btn = h('button.btn.primary', {
      disabled: sending,
      onclick: () => send(textarea),
    }, sending ? '正在回…' : '发送');

    const composerParts = [];
    if (sendError) {
      composerParts.push(h('div.notice.alert', {}, [
        h('strong', {}, '这条没有发出去。'),
        h('div.small.mt1', {}, sendError),
        h('div.tiny.mt1', {}, '你写的内容还在下面的输入框里，可以直接重试。'),
      ]));
    }
    composerParts.push(h('div.chat-composer', {}, [textarea, btn]));
    composerWrap.replaceChildren(...composerParts);
    if (sendError) textarea.value = sendErrorText;
    setTimeout(() => { if (!sending) textarea.focus(); }, 30);
  }

  function sendText(text) {
    const ta = composerWrap.querySelector('textarea');
    if (!ta) return;
    ta.value = text;
    send(ta);
  }

  async function send(textarea) {
    const text = (textarea.value || '').trim();
    if (!text) { toast('写一句就行。', 'warn'); return; }
    if (sending) return;

    sending = true;
    sendError = null;
    sendErrorText = text;
    textarea.value = '';
    paintComposer();

    // 乐观显示用户这句
    conversation.messages = conversation.messages || [];
    conversation.messages.push({
      id: `tmp-${Date.now()}`, role: 'user', content: text,
      createdAt: new Date().toISOString(), provider: 'mock',
    });
    thread.appendChild(messageNode(conversation.messages[conversation.messages.length - 1]));
    thread.appendChild(h('div.msg.msg-ai.thinking', {}, [
      h('div.msg-ai-head', {}, [
        h('span.msg-avatar', {}, '缓'),
        h('span.msg-who', {}, 'AI'),
      ]),
      h('div.bubble.thinking', {}, [
        h('span.typing', {}, [h('i'), h('i'), h('i')]),
      ]),
    ]));
    scrollToBottom();

    try {
      const res = await api.sendMessage(convId, text);
      conversation = res.conversation;
      sending = false;
      sendError = null;
      await ctx.refresh();
      paintThread();
      paintComposer();
      scrollToBottom();
      if (res.warning) toast(res.warning, 'warn');
    } catch (err) {
      sending = false;
      sendError = err.message || String(err);
      conversation.messages = conversation.messages.filter((m) => !String(m.id).startsWith('tmp-'));
      paintThread();
      paintComposer();
      scrollToBottom();
    }
  }

  // ---------------------------------------------------------------- 头部

  async function rename() {
    const input = h('input', { type: 'text', value: conversation.title });
    modal({
      title: '给这个对话改个名字',
      body: h('label.field.mb0', {}, [h('span.label-text', {}, '对话名称'), input]),
      actions: [
        { label: '取消' },
        {
          label: '保存', primary: true,
          onClick: async () => {
            try {
              conversation = await api.patchConversation(convId, { title: input.value });
              await ctx.refresh();
              ctx.rerender();
            } catch (err) { toastError(err); return false; }
          },
        },
      ],
    });
  }

  root.appendChild(
    h('div.page.chat-page', {}, [
      h('div.page-head.chat-head', {}, [
        h('div.page-head-main', {}, [
          h('h1.title-sm', {}, [
            conversation.title,
            h('button.icon-btn', { title: '改个名字', onclick: rename }, '✎'),
          ]),
          h('div.page-sub', {}, [
            `开始于 ${fmtDateTime(conversation.createdAt)}`,
            ' · ',
            `${(conversation.messages || []).length} 条消息`,
          ].join('')),
        ]),
      ]),

      h('div.chat-shell', {}, [thread, composerWrap]),

      h('div.btn-row.mt3', {}, [
        h('button.btn.ghost', { onclick: () => ctx.navigate('/') }, '← 回到工作台'),
        h('button.btn.ghost', { onclick: () => ctx.navigate('/tasks?filter=open') }, '去看待办'),
        h('button.btn.ghost', { onclick: () => ctx.navigate('/chat') }, '全部对话'),
      ]),
    ])
  );

  paintThread();
  paintComposer();
  if ((conversation.messages || []).length) scrollToBottom();
}
