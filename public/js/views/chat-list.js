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
      `「${conv.title}」以及里面的对话记录会被删除。`,
      '删掉'
    );
    if (!ok) return;
    try {
      await api.deleteConversation(conv.id);
      await ctx.rerender();
    } catch (err) { toastError(err); }
  }

  const conversations = state.conversations;

  root.appendChild(
    h('div.page', {}, [
      pageHead({
        title: '想说什么就说什么',
        actions: [
          h('button.btn.primary', { onclick: newConversation }, '＋ 开始新的对话'),
        ],
      }),

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
