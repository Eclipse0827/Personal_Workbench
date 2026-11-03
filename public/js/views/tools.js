/**
 * 页面五：我的工具
 * ---------------------------------------------------------------
 * PRD 2.6 / 1.4：
 *   · 只展示已实现的功能，和清晰的「规划中」状态
 *   · 未实现的工具不允许进入无效页面
 *   · 不在尚未实现的功能上显示虚假的完成状态
 *
 * 番茄钟与教材精读已经接上真实页面；剩下标「规划中」的仍然点不进去，
 * 不会跳到一个空壳页面。
 */

import { h, toast, pageHead } from '../ui.js';
import { state } from '../state.js';

const TOOLS = [
  {
    id: 'thought',
    name: '思考档案',
    desc: '你在第一版里写下的记录，以及从对话里主动保存的摘要。',
    state: 'ready',
    to: '/archive',
    icon: '▢',
    detail: '可以查看、编辑、删除。',
  },
  {
    id: 'pdf',
    name: '教材精读',
    desc: '导入教材 PDF，按章、节阅读，逐节生成讲义并与 AI 讨论。',
    state: 'ready',
    to: '/textbooks',
    icon: '◫',
    detail: '支持 PDF 书签 / 目录页识别；章节框架、讲义和问答都会标明用的是哪个引擎。',
  },
  {
    id: 'outline',
    name: '章节知识框架',
    desc: '把一个章节的内容整理成可以看的结构图。',
    state: 'planned',
    icon: '⌗',
    detail: '教材精读里已经能看到「章 → 节」的文字框架；独立的关系图还没有做。',
  },
  {
    id: 'quiz',
    name: '习题生成',
    desc: '按章节生成练习题，并记录作答情况。',
    state: 'planned',
    icon: '✎',
    detail: '需要真实 AI 服务和题目质量校验，V1.0 不做。',
  },
  {
    id: 'mistakes',
    name: '错题整理',
    desc: '把做错的题收集起来，按知识点归类复习。',
    state: 'planned',
    icon: '↺',
    detail: '依赖「习题生成」。',
  },
];

export default async function renderTools(root, ctx) {
  const ready = TOOLS.filter((t) => t.state === 'ready');
  const planned = TOOLS.filter((t) => t.state === 'planned');

  function tile(tool) {
    const isReady = tool.state === 'ready';
    return h(`div.card.tool-card${isReady ? '.ready' : '.planned'}`, {
      onclick: () => {
        if (isReady) ctx.navigate(tool.to);
        else toast(`「${tool.name}」还在规划中，暂时打不开。`, 'warn');
      },
      style: { cursor: 'pointer' },
    }, [
      h('div.tool-card-head', {}, [
        h('span.tool-icon', {}, tool.icon),
        h('h3', {}, tool.name),
        h(`span.tag${isReady ? '.accent' : ''}`, {}, isReady ? '可用' : '规划中'),
      ]),
      h('p.small.muted.mb1', {}, tool.desc),
      h('div.tiny.muted', {}, tool.detail),
      isReady
        ? h('div.btn-row.mt2', {}, [
            h('button.btn.small.primary', {
              onclick: (e) => { e.stopPropagation(); ctx.navigate(tool.to); },
            }, '打开 →'),
          ])
        : h('div.btn-row.mt2', {}, [
            h('span.tiny.muted', {}, '不可点击进入 —— 还没有可用的页面'),
          ]),
    ]);
  }

  root.appendChild(
    h('div.page', {}, [
      pageHead({
        title: '工具',
        sub: '这里只有两种状态：真的能用，和明确标着「规划中」。没有点了没反应的空壳。',
      }),

      h('div.section', {}, [
        h('div.section-head', {}, [
          h('h2', {}, '现在可用'),
          h('span.count', {}, `${ready.length} 个`),
        ]),
        h('div.grid.two', {}, ready.map(tile)),
      ]),

      h('div.section', {}, [
        h('div.section-head', {}, [
          h('h2', {}, '规划中'),
          h('span.count', {}, `${planned.length} 个`),
        ]),
        h('div.notice.quiet.mb2', {}, '下面这些还没有实现。先放在这里，是为了让你知道它们的位置，不是暗示马上就有。'),
        h('div.grid.two', {}, planned.map(tile)),
      ]),

      h('div.card.mt3', {}, [
        h('h3.mb1', {}, '关于这一页'),
        h('ul.small.muted.mb0', {}, [
          h('li', {}, '标「规划中」的工具点不进去，也不会显示假的完成状态。'),
          h('li', {}, '专注番茄钟和教材精读已经可用：番茄钟可以关联待办并在结束时自动勾选，教材精读支持 PDF 导入、按节讲义和问答。'),
          h('li', {}, '远程模型只在你于设置里主动配置后才会使用；教材原文、讲义和问答都会标明引擎。'),
        ]),
      ]),

      h('div.btn-row.mt3', {}, [
        h('button.btn.ghost', { onclick: () => ctx.navigate('/') }, '← 回到工作台'),
      ]),
    ])
  );
}
