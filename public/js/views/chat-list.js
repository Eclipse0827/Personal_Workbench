/**
 * AI 整理空间 · 对话列表
 */

import { api } from '../api.js';
import { h, toastError, confirmDialog, emptyState, pageHead, fmtRelative, truncate } from '../ui.js';
import { state } from '../state.js';

export default async function renderChatList(root, ctx) {
  async function newConversation() {
    try {
      const conv = await api.createConversation({});
      ctx.navigate(`/chat/${conv.id}`);
    } catch (err) { toastError(err); }
  }

  async function remove(conv) {
    const ok = await confirmDialog(
      '删掉这个对话？',
      `「${conv.title}」以及里面的对话记录会被删除。已经保存到「我的档案」的摘要不受影响。`,
      '删掉'
    );
    if (!ok) return;
    try {
      await api.deleteConversation(conv.id);
      await ctx.rerender();
    } catch (err) { toastError(err); }
  }

  const conversations = state.conversations;
  const provider = (state.settings && state.settings.aiProvider) || 'mock';
  const ai = state.ai || {};

  /** 这一页的引擎说明必须跟着实际配置走，不能写死 */
  function engineNotice() {
    if (provider === 'ollama') {
      const online = ai.ollama && ai.ollama.online;
      return h('div.notice.quiet.mb3', {}, [
        h('strong', {}, online ? '当前用本机 Ollama 说话。' : 'Ollama 现在没连上。'),
        online
          ? ` 回复由本地模型「${ai.ollama.selected || '—'}」生成，梳理卡和行动方案仍由本地规则引擎保证正确。所有内容都不离开这台电脑。`
          : ' 回复会暂时由本地规则引擎生成，你的话仍然不会离开这台电脑。可以在「设置与数据」里检查 Ollama。',
      ]);
    }
    if (provider === 'real') {
      return h('div.notice.warm.mb3', {}, [
        h('strong', {}, '当前用远程模型。'),
        ' 你写的内容会发送到设置里配置的那个接口。不想外传的话，可以在「设置与数据」里切回本地规则引擎或本机 Ollama。',
      ]);
    }
    return h('div.notice.quiet.mb3', {}, [
      h('strong', {}, '当前用的是本地规则引擎。'),
      ' 回复由本地规则生成，不需要联网，你的话也不会离开这台电脑。',
      ' 想换成本机 Ollama 或远程模型，可以在「设置与数据」里配置。',
    ]);
  }

  root.appendChild(
    h('div.page', {}, [
      pageHead({
        title: '想说什么就说什么',
        sub: '不用先选情绪类型，也不用填表。说完了，会整理成一个可以改的梳理结果；需要的时候，再帮你拆成具体的行动。',
        actions: [
          h('button.btn.primary', { onclick: newConversation }, '＋ 开始新的对话'),
        ],
      }),

      engineNotice(),

      conversations.length
        ? h('div', {}, conversations.map((c) =>
            h('div.card.clickable', {
              onclick: () => ctx.navigate(`/chat/${c.id}`),
            }, [
              h('div.entry-row', {}, [
                h('div.grow', {}, [
                  h('div.entry-title', {}, c.title),
                  c.lastMessage
                    ? h('div.entry-snippet', {}, truncate(c.lastMessage, 100))
                    : h('div.entry-snippet', {}, '还没有消息'),
                  h('div.tiny.muted.mt1', {}, `${c.messageCount} 条消息 · ${fmtRelative(c.updatedAt)}`),
                ]),
                h('div.entry-side', {}, [
                  c.pendingProposals
                    ? h('span.tag.warm', {}, `${c.pendingProposals} 个方案待确认`)
                    : null,
                  h('button.icon-btn.danger', {
                    title: '删除对话',
                    onclick: (e) => { e.stopPropagation(); remove(c); },
                  }, '×'),
                ]),
              ]),
            ])
          ))
        : emptyState({
            icon: '◔',
            title: '还没有对话',
            hint: '遇到不知道从哪下手的事，就从这里说一句。',
            actionLabel: '开始新的对话',
            onAction: newConversation,
          }),

      h('div.center.mt3', {}, [
        h('button.btn.ghost', { onclick: () => ctx.navigate('/') }, '← 回到工作台'),
      ]),
    ])
  );
}
