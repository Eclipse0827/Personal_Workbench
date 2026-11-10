'use strict';

/**
 * 多供应商 / 多模型配置（纯函数层，不碰磁盘）
 * ---------------------------------------------------------------
 * 配置只存在本地 data/settings.json。每家供应商有自己的地址、Key 和模型清单；
 * Key 只在服务端保存，对外只暴露 hasApiKey。
 *
 * 旧的顶层字段（aiProvider / baseUrl / model / apiKey / ollama*）继续保留，
 * 由 db.saveSettings 用 syncLegacy() 跟「默认模型」保持一致 —— 这样教材精读、
 * 外刊阅读那些不走对话的 AI 调用链一行都不用改，也会跟着默认模型走。
 * 某个对话想临时换模型时，只在发消息那一刻用 resolve() 覆盖 settings。
 */

const MOCK_REF = 'mock';
const TYPES = ['openai', 'ollama'];
const LEGACY_OPENAI_ID = 'mp-legacy-openai';
const LEGACY_OLLAMA_ID = 'mp-legacy-ollama';
const LEGACY_OPENAI_MODEL = 'mdl-legacy-openai';
const LEGACY_OLLAMA_MODEL = 'mdl-legacy-ollama';

function text(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function safeType(v) {
  return TYPES.includes(v) ? v : 'openai';
}

function safeId(v) {
  const s = String(v || '');
  return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : '';
}

function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nameFromUrl(raw) {
  try { return new URL(raw).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** 第一次升级：把旧的单份 real / ollama 配置变成两条供应商，Key 原样带过来 */
function migrateLegacy(s) {
  const providers = [];
  if (text(s.baseUrl) || text(s.apiKey) || text(s.model)) {
    providers.push({
      id: LEGACY_OPENAI_ID,
      name: nameFromUrl(s.baseUrl) || 'OpenAI 兼容',
      type: 'openai',
      baseUrl: text(s.baseUrl, 500) || 'https://api.openai.com/v1',
      apiKey: text(s.apiKey, 4000),
      models: [{ id: LEGACY_OPENAI_MODEL, name: text(s.model, 120) || 'gpt-4o-mini' }],
    });
  }
  if (text(s.ollamaUrl) || text(s.ollamaModel)) {
    providers.push({
      id: LEGACY_OLLAMA_ID,
      name: '本机 Ollama',
      type: 'ollama',
      baseUrl: text(s.ollamaUrl, 500) || 'http://127.0.0.1:11434',
      apiKey: '',
      models: text(s.ollamaModel, 120)
        ? [{ id: LEGACY_OLLAMA_MODEL, name: text(s.ollamaModel, 120) }]
        : [],
    });
  }

  let ref = MOCK_REF;
  const openai = providers.find((p) => p.type === 'openai' && p.models.length);
  const ollama = providers.find((p) => p.type === 'ollama' && p.models.length);
  if (s.aiProvider === 'real' && openai) ref = `${openai.id}/${openai.models[0].id}`;
  else if (s.aiProvider === 'ollama' && ollama) ref = `${ollama.id}/${ollama.models[0].id}`;

  return { modelProviders: providers, defaultModelRef: ref };
}

/**
 * 清洗前端传来的供应商列表。
 * 前端不回传 apiKey 明文（只有 hasApiKey），所以按 id 从 existing 里把原 Key 接回来；
 * 只有明确传了新 Key 或 clearApiKey 才改动。
 */
function sanitizeProviders(input, existing = []) {
  if (!Array.isArray(input)) return null;
  const byId = new Map((existing || []).map((p) => [p.id, p]));
  const used = new Set();
  const out = [];

  for (const raw of input.slice(0, 20)) {
    if (!raw || typeof raw !== 'object') continue;
    let id = safeId(raw.id);
    if (!id || used.has(id)) id = newId('mp');
    used.add(id);

    const prev = byId.get(id) || {};
    const type = safeType(raw.type);
    const models = [];
    const usedModels = new Set();
    for (const m of (Array.isArray(raw.models) ? raw.models : []).slice(0, 40)) {
      const name = text(m && m.name, 120);
      if (!name) continue;
      let mid = safeId(m && m.id);
      if (!mid || usedModels.has(mid)) mid = newId('mdl');
      usedModels.add(mid);
      models.push({ id: mid, name });
    }

    let apiKey = text(prev.apiKey, 4000);
    if (typeof raw.apiKey === 'string' && raw.apiKey.trim()) apiKey = raw.apiKey.trim().slice(0, 4000);
    if (raw.clearApiKey === true) apiKey = '';

    out.push({
      id,
      name: text(raw.name, 80) || '未命名供应商',
      type,
      baseUrl: text(raw.baseUrl, 500)
        || (type === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.openai.com/v1'),
      apiKey,
      models,
    });
  }
  return out;
}

/** 对外形状：绝不带 apiKey 明文 */
function publicProviders(list) {
  return (Array.isArray(list) ? list : []).map((p) => ({
    id: p.id,
    name: p.name,
    type: p.type,
    baseUrl: p.baseUrl,
    hasApiKey: Boolean(p.apiKey),
    models: (p.models || []).map((m) => ({ id: m.id, name: m.name })),
  }));
}

/** 下拉用的扁平列表，本地规则引擎永远排第一 */
function flatOptions(s) {
  const out = [{
    ref: MOCK_REF,
    label: '本地规则引擎（不联网）',
    providerName: '本地',
    modelName: '规则引擎',
    type: 'mock',
  }];
  for (const p of (s && s.modelProviders) || []) {
    for (const m of p.models || []) {
      out.push({
        ref: `${p.id}/${m.id}`,
        label: `${p.name} · ${m.name}`,
        providerName: p.name,
        modelName: m.name,
        type: p.type,
      });
    }
  }
  return out;
}

function isValidRef(s, ref) {
  if (ref === MOCK_REF) return true;
  if (typeof ref !== 'string') return false;
  const [pid, mid] = ref.split('/');
  const p = ((s && s.modelProviders) || []).find((x) => x.id === pid);
  return Boolean(p && (p.models || []).some((m) => m.id === mid));
}

/**
 * 把一个 modelRef 展开成 llm.complete 能直接用的 settings。
 * ref 不存在时依次回退：默认模型 → 本地规则引擎，绝不把请求打到未知地址。
 */
function resolve(s, ref) {
  const wanted = isValidRef(s, ref)
    ? ref
    : (isValidRef(s, s && s.defaultModelRef) ? s.defaultModelRef : MOCK_REF);

  if (wanted === MOCK_REF) {
    return {
      settings: { ...s, aiProvider: 'mock' },
      ref: wanted,
      label: '本地规则引擎',
      modelName: '规则引擎',
      type: 'mock',
    };
  }

  const [pid, mid] = wanted.split('/');
  const p = ((s && s.modelProviders) || []).find((x) => x.id === pid);
  const m = (p.models || []).find((x) => x.id === mid);
  const effective = { ...s };
  if (p.type === 'ollama') {
    effective.aiProvider = 'ollama';
    effective.ollamaUrl = p.baseUrl;
    effective.ollamaModel = m.name;
  } else {
    effective.aiProvider = 'real';
    effective.baseUrl = p.baseUrl;
    effective.model = m.name;
    effective.apiKey = p.apiKey;
  }
  return {
    settings: effective,
    ref: wanted,
    label: `${p.name} · ${m.name}`,
    modelName: m.name,
    type: p.type,
  };
}

/**
 * 让旧的顶层字段跟默认模型对齐。切到规则引擎时**不动** baseUrl / apiKey，
 * 否则用户切一次就把保存的 Key 清掉了。
 */
function syncLegacy(s) {
  const r = resolve(s, s.defaultModelRef);
  s.aiProvider = r.settings.aiProvider;
  if (r.type === 'openai') {
    s.baseUrl = r.settings.baseUrl;
    s.model = r.settings.model;
    s.apiKey = r.settings.apiKey;
  } else if (r.type === 'ollama') {
    s.ollamaUrl = r.settings.ollamaUrl;
    s.ollamaModel = r.settings.ollamaModel;
  }
  return s;
}

/** 快捷切换：从旧的三选一按钮反推该用哪个 modelRef */
function refForLegacyProvider(s, provider) {
  if (provider === 'mock') return MOCK_REF;
  const wanted = provider === 'ollama' ? 'ollama' : 'openai';
  const p = ((s && s.modelProviders) || []).find((x) => x.type === wanted && (x.models || []).length);
  return p ? `${p.id}/${p.models[0].id}` : MOCK_REF;
}

/** 测试连通并尽量拉回模型清单；失败也返回人话原因，模型名仍可手填 */
async function testProvider(p) {
  const base = text(p && p.baseUrl, 500).replace(/\/+$/, '');
  if (!base) return { ok: false, models: [], error: '还没填接口地址' };
  try {
    if (p.type === 'ollama') {
      const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return { ok: false, models: [], error: `Ollama 返回 ${res.status}` };
      const data = await res.json();
      const models = (data.models || [])
        .map((m) => ({ name: text(m && (m.name || m.model), 120) }))
        .filter((m) => m.name).slice(0, 50);
      return { ok: true, models, error: null };
    }
    const headers = {};
    if (p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`;
    const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      return {
        ok: false, models: [],
        error: `接口返回 ${res.status}（有些网关不提供 /models，模型名可以手填）`,
      };
    }
    const data = await res.json();
    const models = (data.data || data.models || [])
      .map((m) => ({ name: typeof m === 'string' ? text(m, 120) : text(m && (m.id || m.name), 120) }))
      .filter((m) => m.name).slice(0, 50);
    return { ok: true, models, error: null };
  } catch (err) {
    return { ok: false, models: [], error: String((err && err.message) || '连不上') };
  }
}

module.exports = {
  MOCK_REF,
  TYPES,
  migrateLegacy,
  sanitizeProviders,
  publicProviders,
  flatOptions,
  isValidRef,
  resolve,
  syncLegacy,
  refForLegacyProvider,
  testProvider,
  newId,
};
