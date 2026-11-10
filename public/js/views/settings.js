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
import { h, toast, toastError, confirmDialog, modal, pageHead, PROVIDER_LABEL } from '../ui.js';
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

  // ---------------------------------------------------------------- 智能体开关

  function switchRow({ title, desc, on, onToggle }) {
    const btn = h('button.switch' + (on ? '.on' : ''), {
      type: 'button',
      'aria-pressed': on ? 'true' : 'false',
      onclick: () => onToggle(!btn.classList.contains('on')),
    }, [h('span.switch-dot')]);
    return h('div.switch-row', {}, [
      h('div.switch-text', {}, [
        h('div.switch-title', {}, title),
        h('div.switch-desc', {}, desc),
      ]),
      btn,
    ]);
  }

  // ---------------------------------------------------------------- 模型供应商

  /** 新增 / 编辑一家供应商：地址、Key、模型清单都在这一个弹窗里 */
  function openProviderForm(provider) {
    const isNew = !provider;
    const p = provider
      ? { ...provider, models: (provider.models || []).map((m) => ({ ...m })) }
      : { id: '', name: '', type: 'openai', baseUrl: 'https://api.openai.com/v1', hasApiKey: false, models: [] };

    const name = h('input', { type: 'text', value: p.name, placeholder: '例如：DeepSeek / 本机 Ollama' });
    const type = h('select', {}, [
      h('option', { value: 'openai', selected: p.type === 'openai' }, 'OpenAI 兼容接口'),
      h('option', { value: 'ollama', selected: p.type === 'ollama' }, 'Ollama 本机'),
    ]);
    const baseUrl = h('input', {
      type: 'text', value: p.baseUrl,
      placeholder: p.type === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1',
    });
    const apiKey = h('input', {
      type: 'password',
      placeholder: p.hasApiKey ? '已经保存（留空则不修改）' : '粘贴 API Key（Ollama 可留空）',
    });

    let models = p.models.slice();
    const modelsHost = h('div.model-editor-list');
    function paintModels() {
      modelsHost.replaceChildren(
        ...models.map((m, i) => h('div.model-editor-row', {}, [
          h('input', {
            type: 'text', value: m.name, placeholder: '模型名，例如 gpt-4o-mini',
            oninput: (e) => { models[i].name = e.target.value; },
          }),
          h('button.btn.small.ghost', {
            type: 'button', onclick: () => { models.splice(i, 1); paintModels(); },
          }, '删'),
        ])),
        h('p.tiny.muted.mb0', {}, models.length
          ? `${models.length} 个模型`
          : '还没有模型。可以手填，也可以点「测试连通」自动列出。')
      );
    }
    paintModels();

    const testNote = h('p.tiny.muted.mb0', {}, '');
    const body = h('div', {}, [
      h('label.field', {}, [h('span.label-text', {}, '名称'), name]),
      h('div.split', {}, [
        h('label.field', {}, [h('span.label-text', {}, '协议类型'), type]),
        h('label.field', {}, [h('span.label-text', {}, '接口地址'), baseUrl]),
      ]),
      h('label.field', {}, [
        h('span.label-text', {}, 'API Key'),
        h('span.label-hint', {}, '只存在本机，页面不会回显；留空表示不修改已保存的 Key。'),
        apiKey,
      ]),
      h('div.field', {}, [
        h('span.label-text', {}, '模型清单'),
        h('span.label-hint', {}, '一家供应商可以挂多个模型，对话里任选一个。'),
        modelsHost,
        h('div.btn-row.mt1', {}, [
          h('button.btn.small.ghost', {
            type: 'button', onclick: () => { models.push({ id: '', name: '' }); paintModels(); },
          }, '＋ 手动加一个模型'),
        ]),
      ]),
      testNote,
    ]);

    modal({
      title: isNew ? '添加模型供应商' : '编辑模型供应商',
      body,
      actions: [
        { label: '取消' },
        {
          label: '测试连通',
          onClick: async () => {
            try {
              const r = await api.testModel({
                provider: { id: p.id, type: type.value, baseUrl: baseUrl.value, apiKey: apiKey.value },
              });
              if (!r.ok) {
                testNote.textContent = `没连上：${r.error || '未知原因'}。模型名仍然可以手填。`;
                return false;
              }
              const seen = new Set(models.map((m) => m.name));
              let added = 0;
              for (const m of r.models || []) {
                if (!m.name || seen.has(m.name)) continue;
                models.push({ id: '', name: m.name });
                seen.add(m.name);
                added += 1;
              }
              paintModels();
              testNote.textContent = `连上了，列出 ${(r.models || []).length} 个模型，新增 ${added} 个到清单。`;
            } catch (err) { testNote.textContent = `测试失败：${err.message || err}`; }
            return false;
          },
        },
        {
          label: '保存',
          primary: true,
          onClick: async () => {
            if (!name.value.trim()) {
              toast('给这家供应商起个名字吧。', 'warn');
              name.focus();
              return false;
            }
            const list = (settings.modelProviders || []).map((x) => ({
              ...x, models: (x.models || []).map((m) => ({ ...m })),
            }));
            const entry = {
              name: name.value.trim(),
              type: type.value,
              baseUrl: baseUrl.value.trim(),
              models: models.filter((m) => m.name.trim()).map((m) => ({ id: m.id || '', name: m.name.trim() })),
            };
            if (p.id) entry.id = p.id;
            if (apiKey.value.trim()) entry.apiKey = apiKey.value.trim();
            const idx = p.id ? list.findIndex((x) => x.id === p.id) : -1;
            if (idx >= 0) list[idx] = { ...list[idx], ...entry };
            else list.push(entry);
            const next = await patch({ modelProviders: list }, '模型配置已保存。');
            return Boolean(next);
          },
        },
      ],
    });
  }

  function providerCard(p) {
    const names = (p.models || []).map((m) => m.name).join('、');
    return h('div.model-provider-card', {}, [
      h('div.model-provider-head', {}, [
        h('strong', {}, p.name),
        h('span.tag', {}, p.type === 'ollama' ? 'Ollama 本机' : 'OpenAI 兼容'),
        h('span.tiny.muted', {}, p.hasApiKey ? '已配置 Key' : (p.type === 'ollama' ? '无需 Key' : '未配置 Key')),
      ]),
      h('div.tiny.muted.mt1', {}, p.baseUrl),
      h('div.tiny.muted', {}, `${(p.models || []).length} 个模型${names ? `：${names}` : ''}`),
      h('div.btn-row', {}, [
        h('button.btn.small.ghost', { type: 'button', onclick: () => openProviderForm(p) }, '编辑'),
        h('button.btn.small.ghost', {
          type: 'button',
          onclick: async () => {
            try {
              const first = (p.models || [])[0];
              const r = await api.testModel({ ref: `${p.id}/${first ? first.id : ''}` });
              toast(r.ok ? `连上了，列出 ${(r.models || []).length} 个模型。` : `没连上：${r.error}`, r.ok ? '' : 'warn');
            } catch (err) { toastError(err); }
          },
        }, '测试'),
        h('button.btn.small.danger', {
          type: 'button',
          onclick: async () => {
            const sure = await confirmDialog(
              '删掉这家供应商？',
              `「${p.name}」和它下面的 ${(p.models || []).length} 个模型配置会被移除，已经生成的对话不受影响。`,
              '删掉'
            );
            if (!sure) return;
            const list = (settings.modelProviders || []).filter((x) => x.id !== p.id);
            await patch({ modelProviders: list }, '已删掉这家供应商。');
          },
        }, '删除'),
      ]),
    ]);
  }

  const defaultModelSelect = h('select', {
    onchange: (e) => patch({ defaultModelRef: e.target.value }, '默认模型已切换。'),
  }, (settings.modelOptions || []).map((o) => h('option', {
    value: o.ref, selected: o.ref === settings.defaultModelRef,
  }, o.label)));

  function modelProvidersSection() {
    const list = settings.modelProviders || [];
    return h('div.section', {}, [
      h('div.section-head.inline', {}, [
        h('h2', {}, '模型供应商'),
        h('button.btn.small.primary', {
          type: 'button', style: { marginLeft: 'auto' },
          onclick: () => openProviderForm(null),
        }, '＋ 添加供应商'),
      ]),
      h('p.tiny.muted', {}, '每家供应商配自己的地址和 Key，下面挂多个模型。配置只存在本机 data/settings.json，Key 不会回显到页面。'),
      h('label.field', {}, [
        h('span.label-text', {}, '默认模型'),
        h('span.label-hint', {}, '新对话默认用它；每个对话还能在头部单独换。'),
        defaultModelSelect,
      ]),
      list.length
        ? h('div.model-provider-list', {}, list.map(providerCard))
        : h('p.small.muted.mb0', {}, '还没有配置供应商，点右上角添加。'),
    ]);
  }

  // ---------------------------------------------------------------- 长期记忆

  const memory = await api.profile().catch(() => []);

  function memoryCard() {
    if (!memory.length) {
      return h('div.card', {}, [
        h('p.small.muted.mb0', {}, '还没有记下什么。聊到「考哪几科、什么时候有空、哪块一直卡着」这类长期成立的事，它会自己记一条。'),
      ]);
    }
    return h('div.card', {}, [
      h('ul.memory-list', {}, memory.map((m) => h('li', {}, m.text))),
      h('div.tiny.muted.mt2', {}, '这些只在「让它看到学习记录」打开时才会随请求发出去。'),
      h('div.btn-row.mt2', {}, [
        h('button.btn.small.danger', {
          type: 'button',
          onclick: async () => {
            const sure = await confirmDialog('清掉全部记忆？', '清掉之后，它就不再记得这些事了。对话本身不受影响。', '清掉');
            if (!sure) return;
            try { await api.clearProfile(); toast('已清空。'); ctx.rerender(); } catch (err) { toastError(err); }
          },
        }, '清空记忆'),
      ]),
    ]);
  }

  // ---------------------------------------------------------------- 数据

  const stats = state.stats || {};

  root.appendChild(
    h('div.page', {}, [
      pageHead({
        title: '设置与数据',
        sub: '选择用哪个引擎思考，管理你的数据放在哪里。',
      }),

      modelProvidersSection(),

      h('div.section', {}, [
        h('div.section-head', {}, [h('h2', {}, 'AI 引擎')]),
        h('p.tiny.muted', {}, '这里的三选一是快捷切换；要加供应商、加模型，用上面的「模型供应商」。'),
        h('div.card', {}, [providerSeg, ollamaFields, realFields]),
      ]),

      h('div.section', {}, [
        h('div.section-head', {}, [h('h2', {}, '智能体')]),
        h('div.card', {}, [
          switchRow({
            title: '允许它替你动手',
            desc: '打开后，模型可以自己查任务、建任务、改日期、翻教材章节，最多连续查 3 轮再回答。关掉就退回「只说不动」。',
            on: settings.agentEnabled !== false,
            onToggle: (v) => patch({ agentEnabled: v }, v ? '好，它现在可以动手了。' : '好，它只说话，不动你的东西。'),
          }),
          h('div.divider'),
          switchRow({
            title: '让它看到学习记录',
            desc: '打开后，每次提问会把任务、进度、教材的摘要一起发给远程模型。关着的时候，它只知道你这一轮说的话，什么记录都看不到。',
            on: settings.shareContext === true,
            onToggle: (v) => patch({ shareContext: v }, v ? '已开启：模型能看到你的学习摘要。' : '已关闭：学习记录不会外发。'),
          }),
        ]),
      ]),

      h('div.section', {}, [
        h('div.section-head', {}, [h('h2', {}, '长期记忆')]),
        memoryCard(),
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
