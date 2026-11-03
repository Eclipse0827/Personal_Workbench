/**
 * 页面一：工作台（概览）
 * ---------------------------------------------------------------
 * PRD 2.2 要求的五个模块，全部保留：
 *   A. 欢迎区域（日期 + 问候，不用连续打卡施压）
 *   B. 今日计划（未完成 / 已完成 / 快速新增 / 查看全部未完成 / 直接改状态 / 多时先展示部分）
 *   C. AI 快速入口（自然语言输入 + 四个快捷入口）
 *   D. 最近计划
 *   E. 工具入口（未实现标「规划中」，不许进入无效页面）
 *
 * 版式按参考设计组织：一张「今日」大卡（三栏 + 竖分隔线）、
 * 一张大数字进度卡、一张计划卡，然后是 AI 入口与工具。
 * 主角是今日任务，AI 入口在旁边 —— 对应 PRD 1.4「工作台优先，AI 辅助」。
 */

import { api } from '../api.js';
import {
  h, toast, toastError, taskRow, emptyState, pageHead, chip, iconButton,
  todayLabel, greeting, fmtDay, fmtDateTime, fmtRelative, truncate,
  PROVIDER_LABEL,
} from '../ui.js';
import { state, todayOpen, todayDone, allOpen, isOverdue, planById } from '../state.js';
import { openTaskForm, openPlanForm } from './task-form.js';

/** 今日计划最多先展示几条，其余折叠 */
const TODAY_PREVIEW = 6;

const QUICK_STARTS = [
  { label: '我想理清一件事', text: '我想理清一件事：' },
  { label: '我最近有些焦虑', text: '我最近有些焦虑，' },
  { label: '帮我规划接下来的学习', text: '帮我规划接下来的学习。' },
  { label: '我已经知道要做什么，帮我拆成小任务', text: '我已经知道要做什么了，帮我拆成小任务：' },
];

const TOOLS = [
  { id: 'thought', label: '思考档案', desc: '已经保存的思考与摘要', state: 'ready', to: '/archive' },
  { id: 'pdf', label: '教材精读', desc: '导入 PDF，按节读讲义、问 AI', state: 'ready', to: '/textbooks' },
  { id: 'outline', label: '章节知识框架', desc: '自动整理章节的知识结构', state: 'planned' },
  { id: 'quiz', label: '习题生成', desc: '按章节生成练习题', state: 'planned' },
  { id: 'mistakes', label: '错题整理', desc: '收集错题并归类复习', state: 'planned' },
];

/** 中文的「10月20日 星期二」 */
function monthDayWeek() {
  const d = new Date();
  const w = ['日', '一', '二', '三', '四', '五', '六'];
  return `${d.getMonth() + 1}月${d.getDate()}日 星期${w[d.getDay()]}`;
}

export default async function renderDashboard(root, ctx) {
  const stats = state.stats || {};
  const open = todayOpen();
  const done = todayDone();
  const overdue = state.tasks.filter(isOverdue);
  const plans = state.plans.filter((p) => p.status === 'active');

  // ---------------------------------------------------------------- 操作

  function quickAdd() {
    openTaskForm({
      plans,
      defaults: { scheduledDate: state.today },
      onSaved: () => ctx.rerender(),
    });
  }

  async function setStatus(task, status) {
    try {
      await api.patchTask(task.id, { status });
      await ctx.rerender();
      if (status === 'done') toast('做完了。');
    } catch (err) { toastError(err); }
  }

  const editTask = (task) => openTaskForm({ task, plans, onSaved: () => ctx.rerender() });

  // ---------------------------------------------------------------- 引擎状态

  function engineChip() {
    const ai = state.ai || {};
    const provider = (state.settings && state.settings.aiProvider) || ai.provider || 'mock';
    if (provider === 'ollama') {
      const online = ai.ollama && ai.ollama.online;
      const model = (ai.ollama && ai.ollama.selected) || ai.model || '未选择模型';
      return online
        ? chip(`Ollama · ${truncate(model, 22)}`, { tone: 'accent', title: `本地模型在线：${model}` })
        : chip('Ollama 未连接', { tone: 'warm', title: (ai.ollama && ai.ollama.error) || '连不上本地 Ollama 服务' });
    }
    if (provider === 'real') {
      const configured = state.settings && state.settings.hasApiKey;
      return configured
        ? chip(`远程 · ${truncate(ai.model || '模型', 18)}`, { title: '使用远程模型生成回复' })
        : chip('远程模型未配置', { tone: 'warm', title: '还没有填 API Key' });
    }
    return chip(PROVIDER_LABEL.mock, { title: '离线规则引擎，不联网' });
  }

  // ---------------------------------------------------------------- 今日大卡

  function todayItem(task, { strikethrough = false } = {}) {
    return h(`div.today-item${strikethrough ? '.done' : ''}`, {
      onclick: () => editTask(task),
      title: '点一下可以修改这件事',
    }, [
      h('span.bullet'),
      h('span.txt', {}, task.title),
      task.dueDate && task.dueDate === state.today
        ? h('span.when', {}, '今天截止')
        : task.scheduledDate === state.today
          ? h('span.when', {}, '今天')
          : null,
    ]);
  }

  function todayCard() {
    const recentConvs = (state.conversations || []).slice(0, 3);
    const preview = open.slice(0, TODAY_PREVIEW);
    const rest = open.length - preview.length;

    return h('div.card.today-card', {}, [
      h('div.today-head', {}, [
        h('div.today-title', {}, `今日 · ${monthDayWeek()}`),
        h('div.today-sub', {}, [
          h('span', {}, ['待办 ', h('b', {}, String(open.length)), ' 项']),
          h('span', {}, ['已完成 ', h('b', {}, String(done.length)), ' 项']),
          h('span', {}, ['计划 ', h('b', {}, String(plans.length)), ' 个']),
          h('span', {}, ['对话 ', h('b', {}, String((state.conversations || []).length)), ' 个']),
        ]),
      ]),

      h('div.today-grid', {}, [
        // 第一栏：今日待办
        h('div.today-col', {}, [
          h(`div.today-col-title${open.length ? '' : '.empty'}`, {}, [
            '今日待办',
            h('span.n', {}, String(open.length)),
          ]),
          open.length
            ? h('div.today-list', {}, preview.map((t) => todayItem(t)))
            : h('div.today-empty', {}, '今天还没有安排。空着也完全可以。'),
          rest > 0
            ? h('div.mt1', {}, [
                h('button.btn.small.ghost', {
                  onclick: () => ctx.navigate('/tasks?filter=open'),
                }, `还有 ${rest} 件，看全部 →`),
              ])
            : null,
          h('div.btn-row.mt2', {}, [
            h('button.btn.small.ghost', { onclick: quickAdd }, '＋ 新增任务'),
            h('button.btn.small.ghost', { onclick: () => ctx.navigate('/tasks?filter=open') }, '全部未完成 →'),
          ]),
        ]),

        // 第二栏：今天已完成
        h('div.today-col', {}, [
          h(`div.today-col-title${done.length ? '' : '.empty'}`, {}, [
            '今日已完成',
            h('span.n', {}, String(done.length)),
          ]),
          done.length
            ? h('div.today-list', {}, done.slice(0, TODAY_PREVIEW).map((t) => todayItem(t, { strikethrough: true })))
            : h('div.today-empty', {}, '还没有完成的。做完了会自动出现在这里。'),
        ]),

        // 第三栏：最近对话
        h('div.today-col', {}, [
          h(`div.today-col-title${recentConvs.length ? '' : '.empty'}`, {}, [
            '最近对话',
            h('span.n', {}, String((state.conversations || []).length)),
          ]),
          recentConvs.length
            ? h('div.today-list', {}, recentConvs.map((c) =>
                h('div.today-item', {
                  onclick: () => ctx.navigate(`/chat/${c.id}`),
                  title: '打开这段对话',
                }, [
                  h('span.bullet'),
                  h('span.txt', {}, truncate(c.title, 26)),
                  c.pendingProposals
                    ? h('span.when', { style: { color: 'var(--warm)' } }, `${c.pendingProposals} 待确认`)
                    : h('span.when', {}, fmtRelative(c.updatedAt)),
                ])
              ))
            : h('div.today-empty', {}, '还没有对话。遇到卡住的事可以从下面开始。'),
          recentConvs.length
            ? h('div.mt2', {}, [
                h('button.btn.small.ghost', { onclick: () => ctx.navigate('/chat') }, '全部对话 →'),
              ])
            : null,
        ]),
      ]),

      overdue.length
        ? h('div.notice.warm.mt3.mb0', {}, [
            h('strong', {}, `${overdue.length} 件已经过了截止日期。`),
            ' 它们还在未完成列表里，不会消失。可以改个日期，或者干脆删掉——删掉也是一种处理。',
          ])
        : null,
    ]);
  }

  // ---------------------------------------------------------------- 进度大卡

  function progressCard() {
    const total = stats.total || 0;
    const doneCount = stats.done || 0;
    const pct = total ? Math.round((doneCount / total) * 1000) / 10 : 0;
    const remaining = Math.max(0, total - doneCount);

    return h('div.card.bigstat-card', {}, [
      h('div.bigstat-label', {}, '全部任务 · 完成度'),
      h('div.bigstat-value', {}, [
        total ? (pct % 1 === 0 ? String(pct) : pct.toFixed(1)) : '0',
        h('span.unit', {}, '%'),
      ]),
      h('div.bigstat-bar', {}, [
        h('div.progress', {}, [h('i', { style: { width: `${pct}%` } })]),
      ]),
      h('div.bigstat-meta', {}, [
        h('span', {}, `共 ${total} 个任务`),
        h('span', {}, `已完成 ${doneCount} 个`),
      ]),
      total
        ? h('div.bigstat-foot', {}, remaining ? `还剩 ${remaining} 个未完成` : '全部完成了')
        : h('div.bigstat-foot', { style: { color: 'var(--ink-4)' } }, '还没有任务'),
    ]);
  }

  // ---------------------------------------------------------------- 计划卡

  function planCard() {
    const active = plans.slice(0, 4);
    return h('div.card', {}, [
      h('div.plan-card-head', {}, [h('span.dot'), '学习计划']),
      active.length
        ? h('div', {}, active.map((p) => {
            const total = (p.stats && p.stats.total) || 0;
            const d = (p.stats && p.stats.done) || 0;
            return h('div.plan-line', { onclick: () => ctx.navigate(`/plan/${p.id}`) }, [
              h('div.plan-line-main', {}, [
                h('div.plan-line-title', {}, truncate(p.title, 22)),
                h('div.plan-line-meta', {}, p.endDate ? `到 ${fmtDay(p.endDate)}` : (total ? `${total} 个任务` : '还没有任务')),
              ]),
              h('div.plan-line-num', {}, [String(d), h('small', {}, `/${total}`)]),
            ]);
          }))
        : h('div.today-empty', {}, '还没有进行中的计划。计划是可选的，不建也能正常用工作台。'),
      h('div.btn-row.mt2', {}, [
        h('button.btn.small', { onclick: () => openPlanForm({ onSaved: () => ctx.rerender() }) }, '＋ 新建计划'),
        active.length
          ? h('button.btn.small.ghost', { onclick: () => ctx.navigate('/tasks?tab=plans') }, '全部计划 →')
          : null,
      ]),
    ]);
  }

  // ---------------------------------------------------------------- AI 入口

  const aiInput = h('textarea', {
    rows: 3,
    placeholder: '现在在想什么？直接写下来就行，不用组织语言。\n\n例如：我最近很焦虑考研，不知道怎么开始，学校还没选好。',
    onkeydown: (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
    },
  });

  let busy = false;
  const sendBtn = h('button.btn.primary', { onclick: () => submit() }, '和 AI 聊聊');

  async function submit() {
    const text = aiInput.value.trim();
    if (!text) {
      toast('写一句就行，哪怕只有几个字。', 'warn');
      aiInput.focus();
      return;
    }
    if (busy) return;
    busy = true;
    sendBtn.disabled = true;
    sendBtn.textContent = '正在打开…';
    try {
      const conv = await api.createConversation({});
      await api.sendMessage(conv.id, text);
      ctx.navigate(`/chat/${conv.id}`);
    } catch (err) {
      toastError(err);
      busy = false;
      sendBtn.disabled = false;
      sendBtn.textContent = '和 AI 聊聊';
    }
  }

  function aiCard() {
    const provider = (state.settings && state.settings.aiProvider) || 'mock';
    const label = PROVIDER_LABEL[provider] || PROVIDER_LABEL.mock;
    return h('div.card.ai-entry', {}, [
      h('div.ai-entry-head', {}, [
        h('h3', {}, '遇到问题了？直接说'),
        h(`span.badge-${provider === 'real' ? 'real' : provider === 'ollama' ? 'ollama' : 'mock'}`,
          { title: '当前使用的引擎' }, label),
      ]),
      h('p.small.muted', {}, '不用先选情绪类型，也不用填表。说完之后会整理成一个可以改的梳理结果；需要的话，再帮你拆成具体的行动。'),
      aiInput,
      h('div.quick-starts', {}, QUICK_STARTS.map((q) =>
        h('button.quick-chip', {
          type: 'button',
          onclick: () => {
            aiInput.value = q.text;
            aiInput.focus();
            aiInput.setSelectionRange(q.text.length, q.text.length);
          },
        }, q.label)
      )),
      h('div.btn-row.mt2', {}, [
        sendBtn,
        h('button.btn.ghost', { onclick: () => ctx.navigate('/chat') }, '以前的对话'),
      ]),
      h('div.tiny.muted.mt1', {}, '写完按 Ctrl + Enter 可以直接发送。'),
    ]);
  }

  // ---------------------------------------------------------------- 工具

  function toolsCard() {
    return h('div.card', {}, [
      h('div.section-head.inline', {}, [
        h('h2', {}, '我的工具'),
        h('button.btn.small.ghost', {
          style: { marginLeft: 'auto' },
          onclick: () => ctx.navigate('/tools'),
        }, '全部工具 →'),
      ]),
      h('div.tool-grid', {}, TOOLS.map((t) =>
        h(`button.tool-tile${t.state === 'planned' ? '.planned' : ''}`, {
          type: 'button',
          onclick: () => {
            if (t.state === 'ready') ctx.navigate(t.to);
            else toast('这个工具还在规划中，暂时打不开。', 'warn');
          },
        }, [
          h('div.tool-name', {}, t.label),
          h('div.tool-desc', {}, t.desc),
          h('div.tool-state', {}, t.state === 'ready' ? '可用' : '规划中'),
        ])
      )),
    ]);
  }

  // ---------------------------------------------------------------- 组装

  root.appendChild(
    h('div.page', {}, [
      pageHead({
        title: '概览',
        sub: `${todayLabel()} · ${greeting()}`,
        actions: [
          engineChip(),
          h('button.btn.primary', { onclick: quickAdd }, '＋ 新增任务'),
        ],
      }),

      h('div.section', {}, [todayCard()]),

      h('div.grid.two', {}, [
        progressCard(),
        planCard(),
      ]),

      h('div.section.mt3', {}, [aiCard()]),

      h('div.section', {}, [toolsCard()]),

      h('div.center.mt3', {}, [
        h('div.tiny.muted', {}, [
          `共 ${stats.total || 0} 个任务 · ${stats.done || 0} 个已完成 · ${stats.archives || 0} 份档案`,
        ]),
      ]),
    ])
  );
}
