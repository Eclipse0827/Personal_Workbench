/**
 * 档案详情：查看 / 编辑 / 删除
 * PRD 2.5：编辑档案标题和内容、删除档案、显示保存时间和来源。
 */

import { api } from '../api.js';
import {
  h, toast, toastError, modal, confirmDialog, emptyState, pageHead,
  fmtDateTime, ARCHIVE_TYPE_LABEL, ARCHIVE_ORIGIN_LABEL,
} from '../ui.js';
import { state } from '../state.js';

export default async function renderArchiveDetail(root, ctx) {
  const archive = state.archives.find((a) => a.id === ctx.args.id)
    || await api.getArchive(ctx.args.id).catch(() => null);

  if (!archive) {
    root.replaceChildren(h('div.page', {}, [
      emptyState({
        icon: '▢', title: '找不到这份档案', hint: '它可能已经被删掉了。',
        actionLabel: '回到我的档案', onAction: () => ctx.navigate('/archive'),
      }),
    ]));
    return;
  }

  const editing = Boolean(ctx.args.edit);

  async function remove() {
    const ok = await confirmDialog('删掉这份档案？', `「${archive.title}」会被删除，无法恢复。`, '删掉');
    if (!ok) return;
    try {
      await api.deleteArchive(archive.id);
      toast('已删除。');
      ctx.navigate('/archive');
    } catch (err) { toastError(err); }
  }

  function viewMode() {
    return h('div.card.archive-paper', {}, [
      // 原文按段落渲染，保住换行
      ...String(archive.content || '').split('\n').map((line) => {
        if (!line.trim()) return h('div.archive-gap');
        if (/^#{1,6}\s/.test(line)) {
          const level = line.match(/^#+/)[0].length;
          return h(`h${Math.min(4, Math.max(3, level))}.archive-h`, {}, line.replace(/^#+\s*/, ''));
        }
        if (/^-\s/.test(line)) {
          return h('div.archive-li', {}, ['· ', line.replace(/^-\s/, '')]);
        }
        if (/^>\s?/.test(line)) {
          return h('div.archive-quote', {}, line.replace(/^>\s?/, ''));
        }
        if (/^\*\*.*\*\*$/.test(line.trim())) {
          return h('div.archive-sub', {}, line.replace(/\*\*/g, ''));
        }
        return h('div.archive-p', {}, line);
      }),
    ]);
  }

  function editMode() {
    const title = h('input', { type: 'text', value: archive.title });
    const typeSel = h('select', {}, Object.entries(ARCHIVE_TYPE_LABEL).map(([k, v]) =>
      h('option', { value: k, selected: archive.type === k }, v)));
    const content = h('textarea.tall', { rows: 20, value: archive.content || '' });

    return h('div.card', {}, [
      h('div.notice.quiet.mb2', {}, [
        h('strong', {}, '编辑不会改动来源。'),
        archive.origin === 'legacy' || archive.legacyEntryId
          ? ' 这份档案是从第一版记录迁移来的，data/entries/ 里的原始文件不会被修改。'
          : archive.sourceConversationId
            ? ' 它来自一次对话；改这份摘要不会改动原始对话。'
            : ' 这是一份你自己写的档案。',
      ]),
      h('label.field', {}, [h('span.label-text', {}, '标题'), title]),
      h('label.field', {}, [h('span.label-text', {}, '类型'), typeSel]),
      h('label.field.mb0', {}, [h('span.label-text', {}, '内容'), content]),
      h('div.btn-row.mt2', {}, [
        h('button.btn.primary', {
          onclick: async () => {
            if (!title.value.trim()) { toast('标题不能为空。', 'warn'); return; }
            try {
              await api.patchArchive(archive.id, {
                title: title.value, type: typeSel.value, content: content.value,
              });
              toast('保存了。');
              await ctx.refresh();
              ctx.navigate(`/archive/${archive.id}`);
            } catch (err) { toastError(err); }
          },
        }, '保存'),
        h('button.btn.ghost', { onclick: () => ctx.navigate(`/archive/${archive.id}`) }, '取消'),
      ]),
    ]);
  }

  root.appendChild(
    h('div.page', {}, [
      pageHead({
        kicker: `${ARCHIVE_TYPE_LABEL[archive.type] || archive.type} · ${ARCHIVE_ORIGIN_LABEL[archive.origin] || archive.origin}`,
        title: archive.title,
        sub: [
          `保存于 ${fmtDateTime(archive.createdAt)}`,
          archive.updatedAt && archive.updatedAt !== archive.createdAt
            ? ` · 最后修改 ${fmtDateTime(archive.updatedAt)}`
            : '',
        ].join(''),
        actions: [
          !editing ? h('button.btn', { onclick: () => ctx.navigate(`/archive/${archive.id}?edit=1`) }, '编辑') : null,
          h('button.btn.danger', { onclick: remove }, '删除'),
        ].filter(Boolean),
      }),

      h('div.doc-meta.mb2', {}, [
        archive.legacyEntryId ? h('span.tag', {}, `原记录 ${archive.legacyEntryId}`) : null,
        archive.sourceConversationId
          ? h('span.tag.calm', {
              style: { cursor: 'pointer' },
              onclick: () => ctx.navigate(`/chat/${archive.sourceConversationId}`),
            }, '来自对话 →')
          : null,
      ]),

      editing ? editMode() : viewMode(),

      h('div.btn-row.mt3', {}, [
        h('button.btn.ghost', { onclick: () => ctx.navigate('/archive') }, '← 我的档案'),
      ]),
    ])
  );
}
