'use strict';

/**
 * 教材精读用的通用模型调用（OpenAI 兼容接口 / 本机 Ollama）。
 *
 * 与 ai.js 里的对话通道分开：这里要的是「长文本、结构化 JSON、较长超时」，
 * 而 ai.js 的规则引擎护栏是为短对话设计的，不适合直接套用。
 * 但两处共用 data/settings.json 里的同一套引擎配置，界面上显示的也是同一组名字。
 */

const PROVIDER_LABEL = {
  mock: '本地规则引擎',
  ollama: 'Ollama 本地模型',
  real: '远程模型',
};

function providerLabel(provider) {
  return PROVIDER_LABEL[provider] || PROVIDER_LABEL.mock;
}

function stripThink(text) {
  let s = String(text || '');
  s = s.replace(/<think(?:ing)?[\s\S]*?<\/think(?:ing)?>/gi, '');
  if (/<think(?:ing)?/i.test(s)) s = s.slice(0, s.search(/<think(?:ing)?/i));
  s = s.replace(/<\/think(?:ing)?>/gi, '');
  s = s.replace(/^```(?:json|markdown|md)?\s*/i, '').replace(/```\s*$/i, '');
  return s.trim();
}

/**
 * 超时覆盖到响应体读完。
 * 有些兼容接口会先回响应头，再慢慢生成内容；只给 fetch() 计时的话，
 * 响应头一到计时器就被清掉，页面会一直转圈。
 */
async function fetchTextWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 发一次完整的（非流式）对话请求。
 * 返回 { text, provider, model }；失败抛异常，由调用方决定是否回退本地整理。
 */
async function complete({
  settings, system, user, messages, temperature = 0.35, maxTokens = 1600,
  timeoutMs = 90000, disableReasoning = false,
}) {
  const provider = settings.aiProvider;
  const chatMessages = messages || [
    system ? { role: 'system', content: system } : null,
    { role: 'user', content: user },
  ].filter(Boolean);

  if (provider === 'real') {
    if (!settings.apiKey) throw new Error('还没有配置远程模型的 API Key');
    const base = String(settings.baseUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('还没有配置远程模型接口地址');

    const payload = {
      model: settings.model || 'gpt-4o-mini',
      temperature,
      max_tokens: maxTokens,
      messages: chatMessages,
    };
    if (disableReasoning) payload.reasoning_effort = 'none';

    let attempt = 0;
    let res;
    let bodyText = '';
    while (true) {
      try {
        ({ res, text: bodyText } = await fetchTextWithTimeout(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
          body: JSON.stringify(payload),
        }, timeoutMs));
      } catch (err) {
        throw new Error(err.name === 'AbortError'
          ? `远程模型超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`
          : `连不上远程模型：${err.message}`);
      }

      if (res.ok) break;

      // 有些兼容接口不认识 reasoning_effort，去掉它再试一次。
      if (attempt === 0 && payload.reasoning_effort && [400, 422].includes(res.status)
        && /reasoning|unknown|unsupported|invalid/i.test(bodyText)) {
        delete payload.reasoning_effort;
        attempt += 1;
        continue;
      }
      throw new Error(`模型接口返回 ${res.status}${bodyText ? `：${bodyText.slice(0, 180)}` : ''}`);
    }

    let data;
    try { data = JSON.parse(bodyText); } catch { throw new Error('模型接口返回了无法解析的内容'); }
    const text = stripThink(data?.choices?.[0]?.message?.content || '');
    if (!text) throw new Error('模型返回了空内容');
    return { text, provider: 'real', model: data.model || settings.model };
  }

  if (provider === 'ollama') {
    const base = String(settings.ollamaUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('还没有配置 Ollama 地址');
    const model = settings.ollamaModel;
    if (!model) throw new Error('还没有选择 Ollama 模型');

    const body = {
      model,
      stream: false,
      think: false,
      options: {
        temperature,
        num_predict: maxTokens,
        top_p: 0.9,
        repeat_penalty: 1.08,
      },
      messages: chatMessages,
    };

    async function post(payload) {
      return fetchTextWithTimeout(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, timeoutMs);
    }

    let res;
    let bodyText = '';
    try {
      ({ res, text: bodyText } = await post(body));
      if (res.status === 400) {
        const { think, ...withoutThink } = body;
        ({ res, text: bodyText } = await post(withoutThink));
      }
    } catch (err) {
      throw new Error(err.name === 'AbortError'
        ? `Ollama 超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`
        : `连不上 Ollama：${err.message}`);
    }

    if (!res.ok) {
      throw new Error(`Ollama 返回 ${res.status}${bodyText ? `：${bodyText.slice(0, 180)}` : ''}`);
    }
    let data;
    try { data = JSON.parse(bodyText); } catch { throw new Error('Ollama 返回了无法解析的内容'); }
    const text = stripThink(data?.message?.content || '');
    if (!text) throw new Error('Ollama 返回了空内容');
    return { text, provider: 'ollama', model: data.model || model };
  }

  throw new Error('当前是本地规则引擎，没有可调用的模型');
}

/** 模型输出不总是干净的 JSON，尽量把最外层对象抠出来 */
function parseJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(s); } catch { /* 继续尝试截取 */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch { /* 放弃 */ }
  }
  return null;
}

module.exports = { complete, parseJson, providerLabel, stripThink };
