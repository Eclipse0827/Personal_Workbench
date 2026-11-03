/**
 * 页面四：我的档案
 * ---------------------------------------------------------------
 * PRD 2.5：保存用户**主动选择保留**的长期信息。
 *
 * 硬约束：
 *   · AI 不得默认把所有对话保存为长期记忆 → 这里面的东西全都是用户点过「保存」的
 *   · 用户能清楚区分「原始记录」和「AI 整理内容」→ 每条都标了来源
 *   · 显示保存时间
 *   · V1.0 不自动生成未经确认的心理画像 → 这一页只有你给的东西，系统不往里塞结论
 */

import { api } from '../api.js';
import {
  h, toast, toastError, modal, confirmDialog, emptyState, pageHead,
  fmtDateTime, fmtRelative, truncate,
  ARCHIVE_TYPE_LABEL, ARCHIVE_ORIGIN_LABEL,
} from '../ui.js';
import { state } from '../state.js';

const FILTERS = [
  { id: '', label: '全部' },
  { id: 'thought', label: '思考档案' },
  { id: 'summary', label: '重要摘要' },
  { id: 'plan', label: '学习计划' },
];

export default async function renderArchive(root, ctx) {
  const type = FILTERS.some((f) => f.id === ctx.args.filter) ? (ctx.args.filter || '') : '';
  const all = state.archives;
  const list = type ? all.filter((a) => a.type === type) : all;

  function createNew() {
    const title = h('input', { type: 'text', placeholder: '例如：关于要不要换研究方向的一次整理' });
    const typeSel = h('select', {}, Object.entries(ARCHIVE_TYPE_LABEL).map(([k, v]) =>
      h('option', { value: k, selected: k === 'summary' }, v)));
    const content = h('textarea', { rows: 12, placeholder: '想留什么就写什么。以后会一直在这里。' });

    modal({
      title: '新建一份档案',
      wide: true,
      body: h('div', {}, [
        h('label.field', {}, [h('span.label-text', {}, '标题'), title]),
        h('label.field', {}, [h('span.label-text', {}, '类型'), typeSel]),
        h('label.field.mb0', {}, [h('span.label-text', {}, '内容'), content]),
      ]),
      actions: [
        { label: '取消' },
        {
          label: '保存', primary: true,
          onClick: async () => {
            if (!title.value.trim()) { toast('起个名字吧。', 'warn'); return false; }
            if (!content.value.trim()) { toast('内容是空的。', 'warn'); return false; }
            try {
              await api.createArchive({ title: title.value, content: content.value, type: typeSel.value });
              toast('已保存。');
              await ctx.rerender();
            } catch (err) { toastError(err); return false; }
          },
        },
      ],
    });
  }

  async function remove(a) {
    const ok = await confirmDialog('删掉这份档案？', `「${a.title}」会被删除。如果它是从对话保存的，原始对话不受影响。`, '删掉');
    if (!ok) return;
    try {
      await api.deleteArchive(a.id);
      toast('已删除。');
      await ctx.rerender();
    } catch (err) { toastError(err); }
  }

  const counts = {
    '': all.length,
    thought: all.filter((a) => a.type === 'thought').length,
    summary: all.filter((a) => a.type === 'summary').length,
    plan: all.filter((a) => a.type === 'plan').length,
  };

  root.appendChild(
    h('div.page', {}, [
      pageHead({
        title: '我选择留下来的东西',
        sub: '这里只有你自己点过「保存」的内容。系统不会把对话自动存成记忆，也不会替你下关于你的结论。',
        actions: [
          h('button.btn.primary', { onclick: createNew }, '＋ 新建档案'),
        ],
      }),

      h('div.tabs', {}, FILTERS.map((f) =>
        h(`button.tab${f.id === type ? '.active' : ''}`, {
          onclick: () => ctx.navigate(f.id ? `/archive?filter=${f.id}` : '/archive'),
        }, [f.label, counts[f.id] ? h('span.tab-count', {}, String(counts[f.id])) : null])
      )),

      list.length
        ? h('div', {}, list.map((a) =>
            h('div.card.clickable', { onclick: () => ctx.navigate(`/archive/${a.id}`) }, [
              h('div.entry-row', {}, [
                h('div.grow', {}, [
                  h('div.entry-title', {}, a.title),
                  h('div.entry-snippet', {}, truncate(a.content, 130)),
                  h('div.tiny.muted.mt1', {}, [
                    ARCHIVE_TYPE_LABEL[a.type] || a.type,
                    ' · ',
                    ARCHIVE_ORIGIN_LABEL[a.origin] || a.origin,
                    ' · ',
                    fmtDateTime(a.createdAt),
                  ].join('')),
                ]),
                h('div.entry-side', {}, [
                  h('span.tag', {}, ARCHIVE_TYPE_LABEL[a.type] || a.type),
                  h('button.icon-btn.danger', {
                    title: '删除',
                    onclick: (e) => { e.stopPropagation(); remove(a); },
                  }, '×'),
                ]),
              ]),
            ])
          ))
        : emptyState({
            icon: '▢',
            title: type ? `还没有${ARCHIVE_TYPE_LABEL[type]}` : '还没有任何档案',
            hint: '档案是你主动留下来的东西 —— 可以从一次对话里保存摘要，也可以直接新建。',
            actionLabel: '新建一份档案',
            onAction: createNew,
          }),

      h('div.notice.quiet.mt3', {}, [
        h('strong', {}, '关于「思考档案」：'),
        ' 你在第一版里写下的记录，已经原样迁移过来了（原始文件仍然在 data/entries/ 里，没有被修改）。',
        ' 那些内容是你当时真实写下的，和 AI 整理的内容分开显示。',
      ]),

      h('div.btn-row.mt3', {}, [
        h('button.btn.ghost', { onclick: () => ctx.navigate('/') }, '← 回到工作台'),
        h('button.btn.ghost', { onclick: () => ctx.navigate('/chat') }, '去 AI 整理空间'),
      ]),
    ])
  );
}
