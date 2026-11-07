/**
 * 设置与数据
 * ---------------------------------------------------------------
 * 三个 AI 引擎，各自的责任边界写清楚：
 *
 *   本地规则引擎  离线、确定性；结构化内容和回复都由规则生成
 *   Ollama 本地模型  模型只负责「怎么说话」，梳理卡与行动方案仍由规则引擎生成
 *   远程模型      模型负责全部内容；需要 API Key，对话原文会发送到外部
 *
 * PRD 6.3 的要求：独立服务模块、密钥不进前端、对发送到外部的数据做清晰说明。
 */

import { api } from '../api.js';
import { h, toast, toastError, confirmDialog, pageHead, PROVIDER_LABEL } from '../ui.js';
import { state } from '../state.js';

export default async function renderSettings(root, ctx) {
  let settings = state.settings || (await api.settings());
  let ai = state.ai || (await api.aiStatus(true).catch(() => null));

  async function patch(payload, message) {
    try {
      settings = await api.patchSettings(payload);
      state.settings = settings;
      ai = await api.aiStatus(true).catch(() => ai);
      state.ai = ai;
      if (message) toast(message);
      await ctx.refresh();
      ctx.rerender();
      return settings;
    } catch (err) {
      toastError(err);
      return null;
    }
  }

  async function rescan() {
    try {
      ai = await api.aiStatus(true);
      state.ai = ai;
      toast(ai.ollama.online
        ? `连上了，找到 ${ai.ollama.models.length} 个模型。`
        : `没连上：${ai.ollama.error || '未知原因'}`,
      ai.ollama.online ? '' : 'warn');
      ctx.rerender();
    } catch (err) { toastError(err); }
  }

  // ---------------------------------------------------------------- 引擎选择

  const providerSeg = h('div.seg');
  function paintProvider() {
    const cur = settings.aiProvider;
    const opts = [
      { id: 'mock', t: PROVIDER_LABEL.mock, d: '离线，不联网。回复和结构化内容都由本地规则生成，结果稳定、可预期。' },
      { id: 'ollama', t: PROVIDER_LABEL.ollama, d: '用本机 Ollama 生成回复的措辞；梳理卡和行动方案仍由规则引擎保证正确。' },
      { id: 'real', t: PROVIDER_LABEL.real, d: '调用兼容 OpenAI 接口的远程模型。质量最高，但对话原文会发送到那个服务。' },
    ];
    providerSeg.replaceChildren(...opts.map((o) =>
      h(`button.seg-opt${cur === o.id ? '.active' : ''}`, {
        type: 'button',
        onclick: () => patch({ aiProvider: o.id }, `已切换到「${o.t}」。`),
      }, [h('span.t', {}, o.t), h('span.d', {}, o.d)])
    ));
  }
  paintProvider();

  // ---------------------------------------------------------------- Ollama

  const ollamaModels = (ai && ai.ollama && ai.ollama.models) || [];
  const ollamaOnline = Boolean(ai && ai.ollama && ai.ollama.online);
  const selectedModel = settings.ollamaModel || (ollamaModels[0] && ollamaModels[0].name) || '';

  const ollamaUrlInput = h('input', {
    type: 'text',
    value: settings.ollamaUrl || 'http://127.0.0.1:11434',
    placeholder: 'http://127.0.0.1:11434',
  });

  const modelSelect = ollamaModels.length
    ? h('select', {
        onchange: (e) => patch({ ollamaModel: e.target.value }, `已选模型：${e.target.value}`),
      }, ollamaModels.map((m) =>
        h('option', { value: m.name, selected: m.name === selectedModel },
          `${m.name}${m.parameterSize ? ` · ${m.parameterSize}` : ''}${m.sizeBytes ? ` · ${(m.sizeBytes / 1e9).toFixed(1)}GB` : ''}`)
      ))
    : h('input', {
        type: 'text',
        value: settings.ollamaModel || '',
        placeholder: ollamaOnline ? '手动填写模型名，例如 qwen2.5:7b' : '先启动 Ollama 再刷新',
      });

  const ollamaFields = h(`div${settings.aiProvider === 'ollama' ? '' : '.hidden'}`, {}, [
    // 服务是旧版本（没有 /api/ai/status）时，别让用户以为是自己 Ollama 坏了
    ai === null
      ? h('div.notice.warm', {}, [
          h('strong', {}, '这个服务是旧版本，没有 AI 状态接口。'),
          ' 关掉命令行窗口重新启动一次（双击 start.bat 或运行 node server/server.js），这一块就能用了。',
        ])
      : null,
    h('div.notice.quiet', {}, [
      h('strong', {}, '分工说明：'),
      ' Ollama 只负责把回复说得自然一点。问题梳理卡、行动方案、以及哪些事情算「还没确定」，',
      '仍然由本地规则引擎生成 —— 这样小模型不会擅自给还没定的科目排任务，也不会重复问同一个问题。',
    ]),

    // 连接状态
    h('div.card.flat.mb2', {}, [
      h('div.flex.between.items-center.gap1.wrap', {}, [
        h('div', {}, [
          h('strong', {}, ollamaOnline ? '本机 Ollama 已连接' : '连不上本机 Ollama'),
          h('div.tiny.muted.mt1', {},
            ollamaOnline
              ? `找到 ${ollamaModels.length} 个模型。地址：${(ai && ai.ollama && ai.ollama.url) || settings.ollamaUrl}`
              : `${(ai && ai.ollama && ai.ollama.error) || '请确认 Ollama 正在运行（命令行执行 ollama serve）'}`),
        ]),
        h('button.btn.small', { onclick: rescan }, '重新检测'),
      ]),
      ollamaOnline && !ollamaModels.length
        ? h('div.notice.warm.mt2.mb0', {}, [
            '连上了，但一个模型都没有。先在命令行拉一个：',
            h('code', {}, 'ollama pull qwen2.5:7b'),
          ])
        : null,
    ]),

    h('label.field', {}, [
      h('span.label-text', {}, 'Ollama 地址'),
      h('span.label-hint', {}, '默认 http://127.0.0.1:11434，装在别的机器上时改成对应地址。'),
      ollamaUrlInput,
      h('div.btn-row.mt1', {}, [
        h('button.btn.small', {
          onclick: async () => {
            const next = await patch({ ollamaUrl: ollamaUrlInput.value }, '地址已保存，正在重新检测…');
            if (next) ai = await api.aiStatus(true).catch(() => ai);
            ctx.rerender();
          },
        }, '保存地址并检测'),
      ]),
    ]),

    h('label.field', {}, [
      h('span.label-text', {}, '用哪个模型'),
      h('span.label-hint', {}, ollamaOnline ? '下面是这台机器上已经有的模型。' : '需要先让 Ollama 跑起来才能列出模型。'),
      modelSelect,
      settings.ollamaModel
        ? h('div.tiny.muted.mt1', {}, `当前选定：${settings.ollamaModel}`)
        : (ollamaModels.length ? null : h('div.tiny.muted.mt1', {}, '还没有选定模型。')),
    ]),

    (() => {
      if (!ollamaOnline) return null;
      const picked = ollamaModels.find((m) => m.name === selectedModel) || ollamaModels[0];
      if (!picked) return null;
      // 从 "1.8B" 这类字符串里取数字，判断模型是不是偏小
      const sizeNum = parseFloat(String(picked.parameterSize || '').replace(/[^\d.]/g, ''));
      const small = Number.isFinite(sizeNum) && sizeNum < 3;
      return h(`div.notice.${small ? 'warn' : 'quiet'}.mb0`, {}, small
        ? [
            h('strong', {}, `「${picked.name}」是个很小的模型（${picked.parameterSize}）。`),
            ' 它的回复会比较泛、有时候会跑题。系统会做两件事兜底：',
            '把它的输出限制在一两句话内；一旦跑题就自动改用规则引擎的说法（消息上会显示「规则引擎」）。',
            ' 想要更自然的措辞，可以拉一个大一点的模型：',
            h('code', {}, 'ollama pull qwen2.5:7b'),
            '（约 4.7GB），然后在上面点「重新检测」。',
          ]
        : [
            h('strong', {}, `当前模型：${picked.name}（${picked.parameterSize || '—'}）。`),
            ' 它只负责措辞；梳理卡和行动方案始终由本地规则引擎生成。',
          ]);
    })(),
  ]);

  // ---------------------------------------------------------------- 远程模型

  const baseUrl = h('input', { type: 'text', value: settings.baseUrl || '', placeholder: 'https://api.openai.com/v1' });
  const model = h('input', { type: 'text', value: settings.model || '', placeholder: 'gpt-4o-mini' });
  const apiKey = h('input', {
    type: 'password',
    placeholder: settings.hasApiKey ? '已经保存（留空则不修改）' : '粘贴 API Key',
  });

  const realFields = h(`div${settings.aiProvider === 'real' ? '' : '.hidden'}`, {}, [
    h('div.notice.warn', {}, [
      h('strong', {}, '开之前请先看清楚：'),
      ' 开启后，你在对话里写的内容会被发送到下面这个接口，由它生成回复。',
      ' 不想外传内容的话，用本地规则引擎或本机 Ollama —— 那两条路都不联网。',
    ]),
    h('label.field', {}, [
      h('span.label-text', {}, '接口地址'),
      h('span.label-hint', {}, '兼容 OpenAI Chat Completions 的服务都可以，例如 https://api.deepseek.com/v1'),
      baseUrl,
    ]),
    h('label.field', {}, [h('span.label-text', {}, '模型名称'), model]),
    h('label.field', {}, [
      h('span.label-text', {}, 'API Key'),
      h('span.label-hint', {}, '只保存在本机的 data/settings.json，不会出现在页面源码里，也不会随导出文件外传。'),
      apiKey,
    ]),
    h('div.btn-row', {}, [
      h('button.btn.primary', {
        onclick: async () => {
          const next = await patch({
            baseUrl: baseUrl.value, model: model.value, apiKey: apiKey.value,
          }, '设置已保存。');
          if (next) apiKey.value = '';
        },
      }, '保存'),
      settings.hasApiKey
        ? h('button.btn.danger', {
            onclick: async () => {
              const sure = await confirmDialog('清掉 API Key？', '清掉之后会回到本地规则引擎，你的数据不受影响。', '清掉');
              if (!sure) return;
              await patch({ clearApiKey: true, aiProvider: 'mock' }, '已清掉，回到本地规则引擎。');
            },
          }, '清掉已保存的 Key')
        : null,
    ]),
    h('p.tiny.muted.mb0', {}, `当前：${settings.hasApiKey ? '已配置 Key' : '还没有配置 Key'}。远程调用失败时会自动回退到本地规则引擎，并告诉你原因。`),
  ]);

  // ---------------------------------------------------------------- 数据

  const stats = state.stats || {};

  root.appendChild(
    h('div.page', {}, [
      pageHead({
        title: '设置与数据',
        sub: '选择用哪个引擎思考，管理你的数据放在哪里。',
      }),

      h('div.section', {}, [
        h('div.section-head', {}, [h('h2', {}, 'AI 引擎')]),
        h('div.card', {}, [providerSeg, ollamaFields, realFields]),
      ]),

      h('div.section', {}, [
        h('div.section-head', {}, [h('h2', {}, '我的数据在哪')]),
        h('div.card', {}, [
          h('p.small.muted', {}, [
            '所有数据都是这台电脑上的纯文本 JSON 文件，在项目的 ',
            h('code', {}, 'data/'),
            ' 目录里，一个集合一个文件夹：',
          ]),
          h('ul.small.muted', {}, [
            h('li', {}, [h('code', {}, 'data/tasks/'), ' 任务，一个任务一个文件']),
            h('li', {}, [h('code', {}, 'data/plans/'), ' 学习计划']),
            h('li', {}, [h('code', {}, 'data/conversations/'), ' 对话与行动方案']),
            h('li', {}, [h('code', {}, 'data/archives/'), ' 我的档案']),
            h('li', {}, [h('code', {}, 'data/focus-sessions/'), ' 专注记录']),
            h('li', {}, [h('code', {}, 'data/textbooks/'), ' 教材框架、讲义、问答与原始 PDF']),
            h('li', {}, [h('code', {}, 'data/entries/'), ' 第一版的原始记录（只读保留，没有被改动）']),
          ]),
          h('div.grid.three.mt2', {}, [
            h('div.card.flat', {}, [h('div.stat', {}, [h('div.n', {}, String(stats.total || 0)), h('div.l', {}, '个任务')])]),
            h('div.card.flat', {}, [h('div.stat', {}, [h('div.n', {}, String(stats.plans || 0)), h('div.l', {}, '个进行中计划')])]),
            h('div.card.flat', {}, [h('div.stat', {}, [h('div.n', {}, String(stats.conversations || 0)), h('div.l', {}, '个对话')])]),
          ]),
          h('div.btn-row.mt2', {}, [
            h('a.btn', { href: '/api/export?format=json', download: '' }, '导出任务、对话与档案（JSON）'),
            h('a.btn', { href: '/api/export?format=markdown', download: '' }, '导出任务、对话与档案（Markdown）'),
          ]),
          h('p.tiny.muted.mt2.mb0', {}, '导出的文件里不含 API Key。专注记录和教材数据目前只保存在本机，不在这两个导出文件里；需要备份时请一并复制 data/focus-sessions/ 和 data/textbooks/。'),
        ]),
      ]),

      h('div.section', {}, [
        h('div.section-head', {}, [h('h2', {}, '关于这个产品')]),
        h('div.card', {}, [
          h('p.small', {}, '它是一个个人学术工作台：帮你安排学习任务、管理长期计划；思绪混乱时，可以自然地聊一聊，等你确认之后，把有用的部分变成待办。'),
          h('ul.small.muted', {}, [
            h('li', {}, '不用 AI 也能独立完成目标和待办管理 —— 工作台优先，AI 只是辅助。'),
            h('li', {}, 'AI 建议和正式任务分开保存，只有你确认过的行动才会创建成任务。'),
            h('li', {}, '原始记录和 AI 整理的内容分开存放，改摘要不会覆盖原始对话。'),
            h('li', {}, '没有强制打卡、连续使用奖励和排行榜。'),
            h('li', {}, '界面里只放已经能用的功能，不会拿点不动的入口占位置。'),
          ]),
          h('p.tiny.muted.mb0', {}, '它不是医疗或心理治疗工具。如果情绪已经明显影响到睡眠、饮食或日常生活，请找专业的人聊一聊。'),
        ]),
      ]),

      h('div.btn-row.mt3', {}, [
        h('button.btn.ghost', { onclick: () => ctx.navigate('/') }, '← 回到工作台'),
      ]),
    ])
  );
}
