/**
 * AI 整理空间 · 主从结构（桌面壳）
 * ---------------------------------------------------------------
 * 这一版和旧版的区别在「怎么渲染」，不在「长什么样」：
 *
 *   · 左列表 + 右对话常驻同一个工作区。换对话只换右栏，列表不动、窗口不动。
 *   · 消息按 id 复用节点，只追加新增的那条；不再整条 replaceChildren。
 *   · 输入框只建一次，发送时不重建、不失焦。
 *   · 只有「本来就在底部」才跟随；用户往回读时，新消息不会把他拽下去。
 *   · 「加入待办」就地更新这一张卡 + 左侧列表角标，不触发整页重绘。
 *
 * 产品约束不变（PRD 2.4 / 8.3 / 8.4）：
 *   · 不强制先选情绪；梳理内容每一项都能改、能删
 *   · 建议必须由用户确认才创建任务，可只选部分，重复确认不重复创建
 *   · 只想倾诉时不推计划；每条回复如实标注引擎
 */

import { api } from '../api.js';
import {
  h, toast, toastError, modal, confirmDialog,
  fmtDateTime, fmtRelative, truncate,
} from '../ui.js';
import { state } from '../state.js';
import { renderMarkdown } from '../markdown.js';
import { chatRun } from '../chat-run.js';

export default async function renderChat(root, ctx) {
  let conversation = null;
  let paintedId = null;          // 已经画出来的对话 id（用来判断要不要重建）
  let sending = false;
  let sendError = '';
  let sendErrorText = '';
  let listSig = '';
  let disposed = false;

  const nodeById = new Map();
  const picking = new Map();     // proposalId -> Set(actionId)

  // ---------------------------------------------------------------- 骨架

  const listBody = h('div.cw-list-body');

  const listPane = h('aside.cw-list', {}, [
    h('div.cw-list-head', {}, [
      h('span.cw-list-title', {}, '对话'),
      h('button.cw-new', { type: 'button', onclick: newConversation }, '＋ 新建'),
    ]),
    listBody,
  ]);

  const titleEl = h('h1');
  const subEl = h('div.cw-head-sub');
  const headActions = h('div.cw-head-actions');
  const listToggle = h('button.btn.small.ghost.cw-list-toggle', {
    type: 'button', title: '对话列表', onclick: toggleList,
  }, '☰');

  const head = h('div.cw-head', {}, [
    listToggle,
    h('div.cw-head-main', {}, [titleEl, subEl]),
    headActions,
  ]);

  const quickEl = h('div.cw-quick');
  const tailEl = h('div.cw-tail');        // 底部那一个「重新生成 / 让它回答」
  const innerEl = h('div.cw-inner', {}, [tailEl, quickEl]);
  const threadEl = h('div.cw-thread', {}, [innerEl]);
  const jumpBtn = h('button.cw-jump', {
    type: 'button', onclick: () => stickToBottom(),
  }, '↓ 回到最新');
  const threadWrap = h('div.cw-thread-wrap', {}, [threadEl, jumpBtn]);

  const textarea = h('textarea', {
    rows: 1,
    placeholder: '说点什么…（Enter 发送，Shift+Enter 换行）',
    oninput: autosize,
    onkeydown: onKeydown,
  });
  const sendBtn = h('button.btn.primary', {
    type: 'button',
    onclick: () => (sending ? stopRun() : send()),
  }, '发送');
  const errorEl = h('div.cw-send-error');
  errorEl.style.display = 'none';

  const composerEl = h('div.cw-composer', {}, [
    h('div.cw-composer-inner', {}, [
      errorEl,
      h('div.chat-composer', {}, [textarea, sendBtn]),
      h('div.cw-composer-meta', {}, [
        h('span', {}, [h('span.cw-kbd', {}, 'Enter'), ' 发送']),
        h('span', {}, [h('span.cw-kbd', {}, 'Shift'), '+', h('span.cw-kbd', {}, 'Enter'), ' 换行']),
        h('span', { style: { marginLeft: 'auto' } }, '只有你确认后才会进待办'),
      ]),
    ]),
  ]);

  const idleEl = h('div.cw-idle', {}, [
    h('div', {}, [
      h('div.cw-idle-icon', {}, '◔'),
      h('p', {}, '想说什么就说什么。不用组织语言，也不用先想清楚。'),
      h('button.btn.primary', { type: 'button', onclick: newConversation }, '开始新的对话'),
    ]),
  ]);
  idleEl.style.display = 'none';

  // 学习记录默认不外发：关着的时候在对话上方留一条，点一下就能开
  const ctxBar = h('div.cw-ctxbar');

  const mainEl = h('section.cw-main', {}, [head, ctxBar, threadWrap, composerEl, idleEl]);
  const scrim = h('div.cw-scrim', { onclick: toggleList });
  const ws = h('div.cw', { id: 'chatWs' }, [listPane, scrim, mainEl]);
  root.appendChild(ws);

  // 后台那一轮开始 / 结束时刷新左侧标记：用户可能正停在列表页，不挂在任何对话上
  const onRunState = () => { if (!disposed) paintList(); };
  window.addEventListener('chat-run-state', onRunState);

  // ---------------------------------------------------------------- 滚动

  const nearBottom = () => threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 56;

  function stickToBottom() {
    // 不用 smooth：平滑滚动会让人看着整屏自己滑一段，正是要消除的那种感觉
    threadEl.scrollTop = threadEl.scrollHeight;
  }

  threadEl.addEventListener('scroll', () => {
    jumpBtn.classList.toggle('on', !nearBottom());
  }, { passive: true });

  // ---------------------------------------------------------------- 输入框

  function autosize() {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(148, textarea.scrollHeight)}px`;
  }

  function onKeydown(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (e.isComposing || e.keyCode === 229) return;   // 中文输入法组字中，不要发出去
    e.preventDefault();
    send();
  }

  function setSending(v) {
    sending = v;
    textarea.disabled = v;
    // 生成中按钮不能变成死的：点它就是「停止」
    sendBtn.disabled = false;
    sendBtn.textContent = v ? '停止' : '发送';
    sendBtn.classList.toggle('ghost', v);
    sendBtn.classList.toggle('primary', !v);
    textarea.placeholder = v
      ? '正在回…（点「停止」可以打断）'
      : '说点什么…（Enter 发送，Shift+Enter 换行）';
  }

  /** 网关有时候回一整页 HTML，界面上只留一句人话 */
  function plainError(text) {
    return String(text || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
  }

  function paintError() {
    if (!sendError) {
      errorEl.style.display = 'none';
      errorEl.textContent = '';
      return;
    }
    errorEl.style.display = '';
    errorEl.replaceChildren(
      h('strong', {}, '这条没有发出去。'),
      h('div', {}, plainError(sendError)),
      h('div', { style: { opacity: '.75', marginTop: '2px' } }, '你写的内容还在输入框里，可以直接重试。')
    );
  }

  // ---------------------------------------------------------------- 消息节点

  function providerBadge(msg) {
    const model = msg.meta && msg.meta.model;
    if (msg.provider === 'ollama') {
      return h('span.badge-ollama', {
        title: model ? `本机 Ollama 模型：${model}` : '本机 Ollama 生成',
      }, model ? `Ollama 本地 · ${model}` : 'Ollama 本地');
    }
    if (msg.provider === 'real') {
      return h('span.badge-real', { title: model ? `模型：${model}` : '远程模型生成' },
        model ? `远程模型 · ${model}` : '远程模型');
    }
    if (msg.provider === 'mock' && msg.meta && msg.meta.safety) return h('span.badge-safe', {}, '安全回复');
    return h('span.badge-mock', { title: '本地规则引擎生成，不联网' }, '规则引擎');
  }

  function messageNode(msg) {
    if (msg.role === 'user') {
      return h('div.msg.msg-user', { 'data-id': msg.id }, [
        h('div.bubble', {}, msg.content),
        h('div.msg-time', {}, fmtRelative(msg.createdAt)),
      ]);
    }

    const prop = msg.proposalId
      ? (conversation.proposals || []).find((p) => p.id === msg.proposalId)
      : null;

    // AI 回复不走气泡：直接是排好版的正文（标题、列表、代码块都能显示）。
    // 气泡只用来分「谁在说话」，而 AI 这边铺开读更省眼睛。
    return h('div.msg.msg-ai', { 'data-id': msg.id }, [
      h('div.msg-ai-head', {}, [
        h('span.msg-avatar', {}, '缓'),
        h('span.msg-who', {}, 'AI'),
        providerBadge(msg),
        msg.meta && msg.meta.durationMs
          ? h('span.msg-time', {}, `${(msg.meta.durationMs / 1000).toFixed(1)}s`)
          : null,
      ]),
      h('div.msg-prose', {}, renderMarkdown(msg.content)),
      actionBlock(msg),
      problemBlock(msg),
      prop ? proposalBlock(prop, msg) : null,
      h('div.msg-foot', {}, [h('span.msg-time', {}, fmtRelative(msg.createdAt))]),
    ]);
  }

  // ---------------------------------------------------------------- 它做过什么

  /** 这一轮智能体真的动手了：查了什么、建了什么，如实列出来 */
  function actionBlock(msg) {
    if (!msg.actions || !msg.actions.length) return null;
    // agent 的 create_tasks 是「用户已经明确说了加进去」，所以直接建、不再要确认。
    // 但必须如实标出来，别让人还在等一张永远不会出现的确认卡。
    const createdCount = msg.actions.reduce((n, a) => n + (Number(a.createdCount) || 0), 0);
    return h('div.msg-actions', {}, [
      h('div.msg-actions-label', {}, '它做的'),
      ...msg.actions.map((a) =>
        h('div.msg-action' + (a.ok === false ? '.fail' : ''), {}, [
          h('span.msg-action-dot', {}, a.ok === false ? '×' : '·'),
          h('span', {}, a.summary || a.tool || ''),
        ])
      ),
      createdCount
        ? h('div.msg-actions-note', {}, [
          h('span.tag.accent.tiny', {}, `已直接建好 ${createdCount} 条待办`),
          h('button.btn.small.ghost', {
            type: 'button', onclick: () => ctx.navigate('/tasks?filter=open'),
          }, '去看待办'),
        ])
        : null,
    ]);
  }

  // ---------------------------------------------------------------- 问题梳理

  function problemBlock(msg) {
    const card = msg.problemCard;
    if (!card) return null;

    // 编辑合批：连着改几栏只写一次库，不再每 blur 一下就整份对话落盘。
    // 合批期间不重绘，否则用户刚输完一条、焦点就被抢走。
    let pendingPatch = null;
    let saveTimer = null;
    let repaintAfter = false;

    function save(field, value, repaint = false) {
      if (!pendingPatch) pendingPatch = {};
      pendingPatch[field] = value;
      repaintAfter = repaintAfter || repaint;
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        const payload = pendingPatch;
        const shouldRepaint = repaintAfter;
        pendingPatch = null;
        repaintAfter = false;
        saveTimer = null;
        try {
          conversation = await api.patchProblemCard(conversation.id, msg.id, payload);
          const fresh = (conversation.messages || []).find((m) => m.id === msg.id);
          if (fresh && fresh.problemCard) Object.assign(card, fresh.problemCard);
          toast('记下了，以你改的为准。');
          if (shouldRepaint) repaintMessage(msg.id);
        } catch (err) { toastError(err); }
      }, 260);
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
          // 连录几条时不用重新点输入框
          input.focus();
        },
      });

      return h('div.card-block', {}, [
        ul,
        h('div.add-row', {}, [input, h('span.tiny.muted.nowrap', { style: { alignSelf: 'center' } }, '回车添加')]),
      ]);
    }

    const body = h('div.problem-body.collapsed');

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
          type: 'button',
          onclick: () => save('emotion', null, true),
        }, '我不是在说情绪，去掉这一栏'),
      ]));
    }

    // 「下一步」是这张卡真正能变成待办的东西：能改、能删、能逐条加进待办。
    // 以前它只存在服务端、前端根本不渲染，梳理和待办因此是两条平行数据。
    const steps = (card.nextSteps || []).filter(Boolean);
    const linkedTitle = (t) => (card.stepTasks || []).some((x) => x && x.title === t && x.taskId);

    async function addSteps(wanted) {
      const todo = wanted.filter((s) => !linkedTitle(s));
      if (!todo.length) { toast('这些已经在待办里了。', 'warn'); return; }
      try {
        const r = await api.confirmNextSteps(conversation.id, msg.id, todo);
        conversation = r.conversation || conversation;
        const fresh = (conversation.messages || []).find((m) => m.id === msg.id);
        if (fresh && fresh.problemCard) Object.assign(card, fresh.problemCard);
        const created = (r.created || []).length;
        toast(created ? `加进待办了：${created} 条。` : '这些已经在待办里了。', created ? undefined : 'warn');
        await ctx.refresh();
        repaintMessage(msg.id);
        paintQuick();
        paintList(true);
      } catch (err) { toastError(err); }
    }

    if (steps.length) {
      const list = steps.slice();
      const ul = h('ul.card-list');

      function paintSteps() {
        ul.replaceChildren(...list.map((text, i) => {
          const done = linkedTitle(text);
          return h('li.nextstep-row', {}, [
            h('span.txt', {
              contenteditable: 'true',
              spellcheck: 'false',
              onblur: (e) => {
                const v = e.target.textContent.trim();
                if (!v) { e.target.textContent = text; return; }
                if (v === text) return;
                list[i] = v;
                save('nextSteps', list);
              },
              onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
            }, text),
            done
              ? h('span.tag.accent.tiny.nowrap', {}, '已在待办里')
              : h('button.btn.small.ghost.nowrap', {
                type: 'button', title: '把这一条加进待办',
                onclick: () => addSteps([text]),
              }, '＋ 待办'),
            h('button.icon-btn.danger', {
              title: '删掉这一条',
              onclick: () => { list.splice(i, 1); paintSteps(); save('nextSteps', list); },
            }, '×'),
          ]);
        }));
      }
      paintSteps();

      const stepInput = h('input', {
        type: 'text',
        placeholder: '补充一条下一步…',
        onkeydown: (e) => {
          if (e.key !== 'Enter') return;
          const v = e.target.value.trim();
          if (!v) return;
          list.push(v);
          e.target.value = '';
          paintSteps();
          save('nextSteps', list);
          stepInput.focus();
        },
      });

      body.appendChild(h('div.card-section', {}, [
        h('div.card-label', {}, '下一步可以先做'),
        ul,
        h('div.add-row', {}, [stepInput, h('span.tiny.muted.nowrap', { style: { alignSelf: 'center' } }, '回车添加')]),
      ]));
    }

    const chev = h('span.chev', {}, '▶');
    const toggle = h('button.problem-toggle', {
      type: 'button',
      onclick: () => {
        const open = body.classList.toggle('collapsed') === false;
        toggle.classList.toggle('open', open);
        chev.textContent = open ? '▼' : '▶';
      },
    }, [chev, '问题梳理（可以点开改）']);

    // 动作放在折叠外：以前「下一步」藏在「问题梳理（可以点开改）」里面，
    // 用户从不点开，能落成待办的内容也就一直没被看见。
    const pendingSteps = steps.filter((s) => !linkedTitle(s));
    const stepsBar = steps.length
      ? h('div.problem-steps-bar', {}, pendingSteps.length
        ? [
          h('span.problem-steps-count', {}, `下一步可以先做 ${pendingSteps.length} 条`),
          h('button.btn.small.primary', {
            type: 'button', onclick: () => addSteps(pendingSteps),
          }, '全部加入待办'),
          h('span.tiny.muted', {}, '也可以展开只挑一条'),
        ]
        : [h('span.tiny.muted', {}, `${steps.length} 条下一步都已在待办里`)])
      : null;

    return h('div.problem-card', {}, [toggle, stepsBar, body]);
  }

  // ---------------------------------------------------------------- 建议

  function proposalBlock(prop, msg) {
    const isPending = prop.status === 'pending';
    let planId = '';

    if (!picking.has(prop.id)) {
      picking.set(prop.id, new Set(prop.actions.filter((a) => !a.createdTaskId).map((a) => a.id)));
    }
    const selected = picking.get(prop.id);

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
        conversation = r.conversation || conversation;
        picking.delete(prop.id);
        await ctx.refresh();
        // 只换这一条消息的节点：其余消息、滚动位置都不动
        repaintMessage(msg.id);
        paintQuick();
        paintList(true);
      } catch (err) { toastError(err); }
    }

    async function dismiss() {
      const ok = await confirmDialog('这次先不做？', '不会创建任何任务，这段对话还在。', '先不用');
      if (!ok) return;
      try {
        conversation = await api.dismissProposal(conversation.id, prop.id);
        picking.delete(prop.id);
        toast('好，那就先放着。');
        repaintMessage(msg.id);
        paintQuick();
        paintList(true);
      } catch (err) { toastError(err); }
    }

    const foot = isPending
      ? h('div.proposal-foot', {}, [
          planSelect ? h('div.proposal-plan', {}, [
            h('span.tiny.muted', {}, '放进计划：'),
            planSelect,
          ]) : null,
          h('div.btn-row', {}, [
            h('button.btn.small.primary', { type: 'button', onclick: () => confirmSelected() }, '加入待办'),
            h('button.btn.small.ghost', { type: 'button', onclick: dismiss }, '先不用'),
            h('span.tiny.muted', { style: { alignSelf: 'center' } }, '可以只勾其中几条，也可以改标题'),
          ]),
          h('div.tiny.muted', {}, '只有你确认之后才会进入待办。'),
        ])
      : h('div.proposal-foot', {}, [
          h('span.tag', {}, prop.status === 'confirmed' ? '已加入待办' : '已跳过'),
          prop.confirmedAt ? h('span.tiny.muted', {}, ` · ${fmtDateTime(prop.confirmedAt)}`) : null,
          prop.status === 'confirmed'
            ? h('button.btn.small.ghost.ml1', {
                type: 'button', onclick: () => ctx.navigate('/tasks?filter=open'),
              }, '去看待办')
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

  // ---------------------------------------------------------------- 快捷回话

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
        items.push({ label: '好，加进待办', primary: true, onclick: () => quickConfirm(prop, pendingIds) });
        items.push({ label: '只想先做第一条', onclick: () => quickConfirm(prop, [pendingIds[0]]) });
      }
      items.push({ label: '这次先不用', onclick: () => quickDismiss(prop) });
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

  async function quickConfirm(prop, ids) {
    try {
      const r = await api.confirmProposal(conversation.id, prop.id, { actionIds: ids, planId: null });
      const created = r.created || [];
      const skipped = r.skipped || [];
      if (created.length) {
        toast(`加进待办了：${created.length} 条${skipped.length ? `，跳过 ${skipped.length} 条已有的` : ''}。`);
      } else {
        toast(skipped.length ? '这些都已经在待办里了，没有重复添加。' : '没有添加。', 'warn');
      }
      conversation = r.conversation || conversation;
      picking.delete(prop.id);
      await ctx.refresh();
      const target = (conversation.messages || []).find((m) => m.proposalId === prop.id);
      if (target) repaintMessage(target.id);
      paintQuick();
      paintList(true);
    } catch (err) { toastError(err); }
  }

  async function quickDismiss(prop) {
    try {
      conversation = await api.dismissProposal(conversation.id, prop.id);
      picking.delete(prop.id);
      toast('好，那就先放着。');
      const target = (conversation.messages || []).find((m) => m.proposalId === prop.id);
      if (target) repaintMessage(target.id);
      paintQuick();
      paintList(true);
    } catch (err) { toastError(err); }
  }

  function focusComposer(prefix) {
    textarea.focus();
    if (prefix) {
      textarea.value = prefix;
      autosize();
      textarea.setSelectionRange(prefix.length, prefix.length);
    }
  }

  // ---------------------------------------------------------------- 增量渲染

  function paintQuick() {
    const qr = conversation ? quickReplies() : null;
    quickEl.replaceChildren();
    if (qr) quickEl.appendChild(qr);
    // 保持它永远在最后
    if (innerEl.lastElementChild !== quickEl) innerEl.appendChild(quickEl);
  }

  /**
   * 底部那一个按钮。
   * 答完了给「重新生成」，只有你的问题没有回答时给「让它回答」——
   * 后者专治「服务端跑到一半挂了，只剩一句话悬在那儿」。
   */
  function paintTail() {
    tailEl.replaceChildren();
    if (!conversation) return;
    if (chatRun.isRunning(conversation.id)) return;   // 生成中有占位，不再堆按钮
    const msgs = conversation.messages || [];
    if (!msgs.length) return;
    const last = msgs[msgs.length - 1];
    if (last.role === 'assistant') {
      tailEl.appendChild(h('button.cw-tail-btn', {
        type: 'button', title: '用同一句话再答一次', onclick: regenerate,
      }, '↻ 重新生成'));
    } else if (last.role === 'user') {
      tailEl.appendChild(h('button.cw-tail-btn.warn', {
        type: 'button', title: '这句话还没有回答', onclick: regenerate,
      }, '↻ 让它回答'));
    }
  }

  /** 按 id 对齐：删掉消失的，追加新增的，已有的节点一个都不碰 */
  function syncThread() {
    if (!conversation) return;
    const msgs = conversation.messages || [];
    if (msgs.length) dropEmptyState();

    for (const [id, node] of [...nodeById]) {
      if (!msgs.some((m) => m.id === id)) {
        node.remove();
        nodeById.delete(id);
      }
    }

    msgs.forEach((m, i) => {
      if (nodeById.has(m.id)) return;
      const node = messageNode(m);
      const next = msgs.slice(i + 1).map((x) => nodeById.get(x.id)).find(Boolean) || tailEl;
      innerEl.insertBefore(node, next);
      nodeById.set(m.id, node);
    });
    paintTail();
  }

  /** 空对话那句提示：有了第一条消息就必须撤掉，否则会一直悬在顶上 */
  function dropEmptyState() {
    const node = innerEl.querySelector('.chat-empty');
    if (node) node.remove();
  }

  function repaintMessage(msgId) {
    const msg = (conversation.messages || []).find((m) => m.id === msgId);
    const old = nodeById.get(msgId);
    if (!msg || !old) return;
    const node = messageNode(msg);
    old.replaceWith(node);
    nodeById.set(msgId, node);
  }

  /** 只在换对话时整段重画 */
  function paintThread({ keepScroll = false } = {}) {
    const top = threadEl.scrollTop;
    nodeById.clear();
    for (const child of [...innerEl.children]) if (child !== quickEl && child !== tailEl) child.remove();

    if (!conversation) return;

    const msgs = conversation.messages || [];
    if (!msgs.length) {
      innerEl.insertBefore(h('div.chat-empty', {}, [
        h('div.chat-empty-icon', {}, '◔'),
        h('div', {}, '想说什么就说什么。'),
        h('div.tiny.muted.mt1', {}, '不用组织语言，也不用先想清楚。'),
      ]), tailEl);
    } else {
      for (const m of msgs) {
        const node = messageNode(m);
        innerEl.insertBefore(node, tailEl);
        nodeById.set(m.id, node);
      }
    }
    paintQuick();
    paintedId = conversation.id;
    if (keepScroll) threadEl.scrollTop = top;
    else requestAnimationFrame(() => stickToBottom());
    paintTail();
  }

  // ---------------------------------------------------------------- 头部

  function paintHead() {
    headActions.replaceChildren();
    if (!conversation) {
      titleEl.textContent = 'AI 整理空间';
      subEl.textContent = '选一个对话，或者新建一个';
      return;
    }
    titleEl.replaceChildren(
      h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, conversation.title),
      h('button.icon-btn', { title: '改个名字', onclick: rename }, '✎')
    );
    subEl.textContent = `${(conversation.messages || []).length} 条消息 · 开始于 ${fmtDateTime(conversation.createdAt)}`;

    // 每个对话可以自己挑模型；没挑就跟随全局默认。选择只影响这个对话。
    const modelOptions = (state.settings && state.settings.modelOptions) || [];
    if (modelOptions.length) {
      const defaultRef = (state.settings && state.settings.defaultModelRef) || 'mock';
      const defaultLabel = (modelOptions.find((o) => o.ref === defaultRef) || {}).label || '本地规则引擎';
      const select = h('select.cw-model-select', {
        title: '这个对话用哪个模型',
        onchange: async (e) => {
          const ref = e.target.value || null;
          const previous = conversation.modelRef || null;
          conversation.modelRef = ref;   // 先乐观更新，发出去时立刻用得上
          try {
            const updated = await api.patchConversation(conversation.id, { modelRef: ref });
            conversation.modelRef = updated.modelRef;
            toast(ref ? '这个对话的模型换好了。' : `跟随默认：${defaultLabel}`);
          } catch (err) {
            conversation.modelRef = previous;
            toastError(err);
            paintHead();
          }
        },
      }, [
        h('option', { value: '', selected: !conversation.modelRef }, `跟随默认（${defaultLabel}）`),
        ...modelOptions.map((o) => h('option', {
          value: o.ref, selected: conversation.modelRef === o.ref,
        }, o.label)),
      ]);
      headActions.append(select);
    }

    headActions.append(
      h('button.btn.small.ghost', { type: 'button', onclick: removeCurrent }, '删除')
    );
    // 旧的待确认方案散在历史消息里，滚过去才看得见。头部给一个固定入口。
    const pendings = (conversation.proposals || []).filter((p) => p.status === 'pending');
    if (pendings.length) {
      headActions.append(h('button.btn.small.primary', {
        type: 'button',
        title: '跳到最近一条还没确认的建议',
        onclick: () => jumpToProposal(pendings[pendings.length - 1].id),
      }, `待确认 ${pendings.length}`));
    }
  }

  function jumpToProposal(propId) {
    const msg = (conversation.messages || []).find((m) => m.proposalId === propId);
    const node = msg && nodeById.get(msg.id);
    if (!node) return;
    const target = (node.querySelector && node.querySelector('.proposal-card')) || node;
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  async function rename() {
    if (!conversation) return;
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
              conversation = await api.patchConversation(conversation.id, { title: input.value });
              await ctx.refresh();
              paintHead();
              paintList(true);
            } catch (err) { toastError(err); return false; }
          },
        },
      ],
    });
  }

  async function removeCurrent() {
    if (!conversation) return;
    const ok = await confirmDialog('删掉这个对话？', `「${conversation.title}」以及里面的对话记录会被删除。`, '删掉');
    if (!ok) return;
    try {
      await api.deleteConversation(conversation.id);
      await ctx.refresh();
      conversation = null;
      paintedId = null;
      ctx.navigate('/chat');
    } catch (err) { toastError(err); }
  }

  // ---------------------------------------------------------------- 列表

  function paintList(force = false) {
    const sig = state.conversations
      .map((c) => `${c.id}:${c.messageCount}:${c.pendingProposals}:${chatRun.isRunning(c.id) ? 'run' : ''}`)
      .join('|');
    if (!force && sig === listSig) {
      // 只是选中项变了：改 class 就行，不重建
      for (const node of listBody.children) {
        node.classList.toggle('active', node.dataset.id === (conversation && conversation.id));
      }
      return;
    }
    listSig = sig;
    const top = listBody.scrollTop;

    if (!state.conversations.length) {
      listBody.replaceChildren(h('div.cw-list-empty', {}, [
        h('div', {}, '还没有对话。'),
        h('div', {}, '遇到不知道从哪下手的事，就从这里说一句。'),
      ]));
      return;
    }

    listBody.replaceChildren(...state.conversations.map((c) =>
      h('div.cw-item' + (conversation && conversation.id === c.id ? '.active' : ''), {
        'data-id': c.id,
        role: 'button',
        tabindex: '0',
        onclick: () => ctx.navigate(`/chat/${c.id}`),
        onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.navigate(`/chat/${c.id}`); } },
      }, [
        h('div.cw-item-title', {}, c.title),
        h('div.cw-item-snippet', {}, chatRun.isRunning(c.id)
          ? h('span.cw-item-live', {}, '正在回复…')
          : (c.lastMessage ? truncate(c.lastMessage, 80) : '还没有消息')),
        h('div.cw-item-meta', {}, [
          h('span', {}, `${c.messageCount} 条 · ${fmtRelative(c.updatedAt)}`),
          c.pendingProposals ? h('span.cw-item-flag', {}, `${c.pendingProposals} 待确认`) : null,
        ]),
        h('button.cw-item-del', {
          type: 'button',
          title: '删除对话',
          onclick: (e) => { e.stopPropagation(); removeConversation(c); },
        }, '×'),
      ])
    ));

    listBody.scrollTop = top;
  }

  async function removeConversation(conv) {
    const ok = await confirmDialog('删掉这个对话？', `「${conv.title}」以及里面的对话记录会被删除。`, '删掉');
    if (!ok) return;
    try {
      await api.deleteConversation(conv.id);
      await ctx.refresh();
      if (conversation && conversation.id === conv.id) {
        conversation = null;
        paintedId = null;
        ctx.navigate('/chat');
      } else {
        paintList(true);
      }
    } catch (err) { toastError(err); }
  }

  async function newConversation() {
    try {
      const conv = await api.createConversation({});
      await ctx.refresh();
      ctx.navigate(`/chat/${conv.id}`);
    } catch (err) { toastError(err); }
  }

  function toggleList() {
    ws.classList.toggle('show-list');
  }

  // ---------------------------------------------------------------- 发送

  function sendText(text) {
    textarea.value = text;
    autosize();
    send();
  }

  // ---------------------------------------------------------------- 发送 / 接续

  /**
   * 一块「正在生成」的占位。和真实消息同结构，边到边往里填。
   * 抽出来是因为它有两个入口：刚发出去时，以及从别的页面切回来时。
   */
  function buildStreamNode() {
    const streamState = { shown: '', timer: null };
    const prose = h('div.msg-prose');
    const actionsEl = h('div.msg-actions');
    const headEl = h('div.msg-ai-head', {}, [
      h('span.msg-avatar', {}, '缓'),
      h('span.msg-who', {}, 'AI'),
      h('span.badge-real', {}, '远程模型'),
      h('span.typing', {}, [h('i'), h('i'), h('i')]),
    ]);
    const node = h('div.msg.msg-ai.streaming', { 'data-id': `tmp-ai-${Date.now()}` }, [
      headEl, prose, actionsEl,
    ]);

    // 流式期间也按 markdown 渲染：标题、列表从一开始就是对的形状，
    // 不会等全部收完才「啪」一下换一套样式。
    const paint = (text) => {
      const atBottom = nearBottom();      // 先量再改，否则内容一变高就永远「不在底部」
      prose.replaceChildren(renderMarkdown(text));
      if (atBottom) stickToBottom();
    };
    const typing = (on) => {
      const has = headEl.querySelector('.typing');
      if (on && !has) headEl.appendChild(h('span.typing', {}, [h('i'), h('i'), h('i')]));
      if (!on && has) has.remove();
    };
    const addAction = (evt) => {
      if (!actionsEl.querySelector('.msg-actions-label')) {
        actionsEl.appendChild(h('div.msg-actions-label', {}, '它做的'));
      }
      actionsEl.appendChild(h('div.msg-action' + (evt.ok === false ? '.fail' : ''), {}, [
        h('span.msg-action-dot', {}, evt.ok === false ? '×' : '·'),
        h('span', {}, evt.summary || evt.tool || ''),
      ]));
    };

    return { node, state: streamState, paint, typing, addAction };
  }

  /** 当前挂在视图上的那一轮。切走时要能干净地退订，请求本身不受影响。 */
  let attached = null;

  function detachRun() {
    if (!attached) return;
    const { off, ui } = attached;
    if (off) off();
    if (ui) {
      if (ui.state.timer) clearTimeout(ui.state.timer);
      if (ui.node.parentNode) ui.node.remove();
    }
    attached = null;
    paintTail();
  }

  /** 服务端回传了真实的用户消息：把本地那条临时节点的 id 换成真的，节点不重建 */
  function adoptUserMessage(run, tmpId, tmpNode) {
    const real = run.userMessage;
    if (!real) return;
    const existing = nodeById.get(real.id);
    if (existing) {
      if (tmpNode && tmpNode !== existing && tmpNode.parentNode) tmpNode.remove();
      if (tmpId) nodeById.delete(tmpId);
      return;
    }
    if (tmpId) nodeById.delete(tmpId);
    tmpNode.dataset.id = real.id;
    nodeById.set(real.id, tmpNode);
    if (!(conversation.messages || []).some((m) => m.id === real.id)) {
      conversation.messages.push(real);
    }
  }

  /**
   * 把一轮进行中的生成挂到这个视图上。
   * 刚发出去时带一条本地临时用户消息；从别的页面回来时，自己那句通常已经在服务端了。
   */
  function attachRun(run, { withTmpUser = false } = {}) {
    if (!run || !conversation || run.conversationId !== conversation.id) return;
    if (attached && attached.run === run) return;
    detachRun();

    let tmpId = null;
    let tmpNode = null;

    const already = (conversation.messages || []).some(
      (m) => (run.userMessage && m.id === run.userMessage.id)
        || (m.role === 'user' && m.content === run.userText)
    );

    if (withTmpUser || !already) {
      tmpId = `tmp-user-${Date.now()}`;
      conversation.messages.push({
        id: tmpId,
        role: 'user',
        content: run.userText,
        createdAt: new Date().toISOString(),
        provider: 'mock',
      });
      tmpNode = messageNode({ id: tmpId, role: 'user', content: run.userText, createdAt: new Date().toISOString(), provider: 'mock' });
      innerEl.insertBefore(tmpNode, tailEl);
      nodeById.set(tmpId, tmpNode);
    }
    dropEmptyState();

    const ui = buildStreamNode();
    if (run.text) {
      ui.paint(run.text);
      ui.state.shown = run.text;   // 接上进度，别让已经写过的部分再长一遍
    } else if (run.statusText) {
      ui.paint(run.statusText);    // 切回来时它还停在「正在查…」
    }
    for (const a of run.actions) ui.addAction(a);
    if (run.text || run.actions.length) ui.typing(false);
    innerEl.insertBefore(ui.node, tailEl);

    const stick = nearBottom();

    const off = chatRun.subscribe(run, (r, evt) => {
      if (disposed) return;
      if (!evt || !evt.type) return;

      if (evt.type === 'open') {
        if (tmpNode) { adoptUserMessage(r, tmpId, tmpNode); tmpNode = null; tmpId = null; }
        return;
      }
      if (evt.type === 'partial') {
        smoothText(ui.state, evt.text, ui.paint);
        ui.typing(false);
        return;
      }
      if (evt.type === 'status') {
        // 「正在查…」只是过程提示：显示在占位里，但不进正文、切回来也不该当成回答
        ui.state.shown = '';
        ui.paint(evt.text || '');
        return;
      }
      if (evt.type === 'tool') {
        ui.addAction(evt);
        smoothText(ui.state, '', ui.paint);
        ui.typing(true);
        return;
      }
      if (evt.type === 'done') {
        finishRun(r, evt.result);
        return;
      }
      if (evt.type === 'stopped') {
        stoppedRun(r);
        return;
      }
      if (evt.type === 'gone') {
        goneRun(r);
        return;
      }
      if (evt.type === 'error') {
        failRun(r, evt.error);
      }
    });

    attached = { run, off, ui };
    if (stick) requestAnimationFrame(() => stickToBottom());
  }

  async function finishRun(run, res) {
    if (attached && attached.run === run) detachRun();
    setSending(false);
    try {
      const fresh = await load(run.conversationId);
      if (fresh && conversation && fresh.id === conversation.id) {
        conversation = fresh;
        syncThread();
        paintQuick();
        paintHead();
      }
      paintCtxBar();
      await ctx.refresh();           // 列表里的条数、摘要、标题都跟着更新
      paintList(true);
    } catch (err) {
      console.error('刷新对话失败', err);
    }
    if (res && res.warning) toast(res.warning, 'warn');
    if (nearBottom()) requestAnimationFrame(() => stickToBottom());
    if (textarea) textarea.focus();
  }

  async function failRun(run, message) {
    if (attached && attached.run === run) detachRun();
    setSending(false);
    sendError = plainError(message) || '这一轮没回上来。';
    sendErrorText = run.userText;
    // 用户那句已经先落库了，重新拉一次，让人确认它确实发出去了
    try {
      const fresh = await load(run.conversationId);
      if (fresh && conversation && fresh.id === conversation.id) {
        conversation = fresh;
        syncThread();
        paintHead();
      }
      await ctx.refresh().catch(() => {});
      paintList(true);
    } catch { /* 拉不到就维持现状 */ }
    textarea.value = sendErrorText;
    autosize();
    paintError();
    textarea.focus();
  }

  // ---------------------------------------------------------------- 停止 / 重答

  /** 用户点「停止」：请求在 chat-run 里，视图只是让它别再等 */
  function stopRun() {
    if (!conversation) return;
    chatRun.stop(conversation.id);
  }

  /** 重新生成：不新加问题，让上一句重答一遍（服务端会把旧答案撤掉再写） */
  async function regenerate() {
    if (!conversation || sending) return;
    if (chatRun.isRunning(conversation.id)) return;
    const msgs = conversation.messages || [];
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    if (!lastUser) return;

    // 旧答案先撤掉，免得新旧两版叠在一起
    const tail = msgs[msgs.length - 1];
    if (tail && tail.role === 'assistant') {
      msgs.pop();
      const node = nodeById.get(tail.id);
      if (node) { node.remove(); nodeById.delete(tail.id); }
      paintTail();
    }

    sendError = '';
    sendErrorText = '';
    paintError();
    setSending(true);

    try {
      const run = chatRun.start(conversation.id, lastUser.content, {
        retry: true, modelRef: conversation.modelRef || null,
      });
      attachRun(run);
      paintTail();
      paintList(true);
    } catch (err) {
      setSending(false);
      toastError(err);
    }
  }

  async function stoppedRun(run) {
    if (attached && attached.run === run) detachRun();
    setSending(false);
    try {
      const fresh = await load(run.conversationId);
      if (fresh && conversation && fresh.id === conversation.id) {
        conversation = fresh;
        syncThread();
        paintHead();
      }
      await ctx.refresh().catch(() => {});
      paintList(true);
    } catch { /* 拉不到就维持现状 */ }
    paintTail();
    toast('已停止。这句话还在，想接着问随时说。', 'warn');
    textarea.focus();
  }

  function goneRun() {
    detachRun();
    setSending(false);
    toast('这个对话在生成期间被删掉了。', 'warn');
    conversation = null;
    paintedId = null;
    ctx.navigate('/chat');
  }

  async function send() {
    if (!conversation || sending) return;
    const text = textarea.value.trim();
    if (!text) { toast('写一句就行。', 'warn'); return; }
    if (chatRun.isRunning(conversation.id)) {
      toast('这一轮还在回，等它说完再发。', 'warn');
      return;
    }

    sendError = '';
    sendErrorText = '';
    paintError();
    textarea.value = '';
    autosize();

    const stick = nearBottom();
    setSending(true);

    // 请求交给模块跑，视图只负责挂上去看。
    // 这样切到别的页面再回来，这段还在，不会从头开始。
    const run = chatRun.start(conversation.id, text, { modelRef: conversation.modelRef || null });
    attachRun(run, { withTmpUser: true });
    paintList(true);                 // 立刻让列表显示「正在回复」
    // 服务端已经存下这句了，顺手把标题和条数拉新（不等它，别挡着发消息）
    ctx.refresh().then(() => { if (!disposed) paintList(true); }).catch(() => {});
    if (stick) requestAnimationFrame(() => stickToBottom());
    textarea.focus();
  }

  // ---------------------------------------------------------------- 模式切换

  // ---------------------------------------------------------------- 流式文本平滑显现

  /**
   * 有些网关并不真的逐字返回，而是一次性把整段灌过来（实测：170 字在 130ms 内到齐）。
   * 这种情况下直接把全文渲染上去，看上去就是「啪」一下出现。
   * 所以只有「这一次新增很多字」时才做一段很短的平滑显现；
   * 真的逐字来时增量很小，走原样渲染，不受影响。
   *
   * paint(text) 负责把给定的这一小段文字渲染出来 —— 因为正文要走 markdown，
   * 不能再用 textContent 直接赋值。
   */
  function smoothText(state, full, paint) {
    const text = String(full || '');
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (!text) { state.shown = ''; paint(''); return; }
    if (!text.startsWith(state.shown)) { state.shown = text; paint(text); return; }

    const gap = text.length - state.shown.length;
    if (gap <= 24) { state.shown = text; paint(text); return; }

    const step = () => {
      const left = text.length - state.shown.length;
      if (left <= 0) { state.timer = null; return; }
      const take = Math.max(2, Math.ceil(left / 26));
      state.shown = text.slice(0, state.shown.length + take);
      paint(state.shown);
      state.timer = setTimeout(step, 18);
    };
    step();
  }

  // ---------------------------------------------------------------- 学习记录开关

  function paintCtxBar() {
    const st = state.settings || {};
    if (st.shareContext === true) {
      ctxBar.style.display = 'none';
      ctxBar.replaceChildren();
      return;
    }
    ctxBar.style.display = '';
    ctxBar.replaceChildren(
      h('span.cw-ctxbar-text', {}, 'AI 现在看不到你的学习记录 —— 任务、进度、教材都还在本机。'),
      h('button.cw-ctxbar-btn', { type: 'button', onclick: enableContext }, '让它看一眼')
    );
  }

  async function enableContext() {
    try {
      await api.patchSettings({ shareContext: true });
      await ctx.refresh();
      paintCtxBar();
      toast('好，之后它能在回答时参考你的学习记录。');
    } catch (err) { toastError(err); }
  }

  function setMode(hasConv) {
    threadWrap.style.display = hasConv ? '' : 'none';
    composerEl.style.display = hasConv ? '' : 'none';
    idleEl.style.display = hasConv ? 'none' : '';
  }

  // ---------------------------------------------------------------- 对外：首次 + 更新

  async function load(id) {
    try {
      return await api.getConversation(id);
    } catch (err) {
      toastError(err);
      return null;
    }
  }

  async function update(args) {
    if (disposed) return;
    const id = args && args.id ? args.id : null;

    if (!id) {
      conversation = null;
      paintedId = null;
      detachRun();
      setMode(false);
      paintHead();
      paintCtxBar();
      paintList(true);
      return;
    }

    if (!conversation || conversation.id !== id) {
      const fresh = await load(id);
      conversation = fresh;
      if (!conversation) {
        setMode(false);
        idleEl.querySelector('p').textContent = '这个对话打不开了，可能已经被删掉。';
        paintHead();
        paintList(true);
        return;
      }
    }

    setMode(true);
    paintHead();
    paintCtxBar();
    paintList();

    // 这个对话如果还有一轮在跑，把进度接回来：切走之前写到哪，就从哪继续。
    const run = chatRun.get(conversation.id);
    const running = Boolean(run && run.status === 'running');
    detachRun();                       // DOM 要重建，旧的那份先退订

    if (paintedId !== conversation.id) paintThread();
    else { syncThread(); paintQuick(); }

    if (running) {
      setSending(true);
      attachRun(run);
      requestAnimationFrame(() => stickToBottom());
    } else {
      setSending(false);
    }
  }

  function cleanup() {
    // 只是把「看」的这一端断掉，请求本身还在跑 —— 切回来还能接上
    disposed = true;
    detachRun();
    window.removeEventListener('chat-run-state', onRunState);
  }

  await update(ctx.args);
  autosize();
  return { cleanup, update };
}
