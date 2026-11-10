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

/** 网关出错时经常回一整页 HTML，别把它原样抛给界面 */
function cleanErrorBody(text) {
  return String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function isRetryable(status) {
  return status === 502 || status === 503 || status === 504 || status === 429;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 发一次完整的（非流式）对话请求。
 * 返回 { text, provider, model }；失败抛异常，由调用方决定是否回退本地整理。
 */
async function complete({ settings, system, user, messages, temperature = 0.35, maxTokens = 1600, timeoutMs = 90000 }) {
  const provider = settings.aiProvider;
  const chatMessages = messages || [
    system ? { role: 'system', content: system } : null,
    { role: 'user', content: user },
  ].filter(Boolean);

  if (provider === 'real') {
    if (!settings.apiKey) throw new Error('还没有配置远程模型的 API Key');
    const base = String(settings.baseUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('还没有配置远程模型接口地址');

    let res;
    try {
      res = await fetchWithTimeout(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify({
          model: settings.model || 'gpt-4o-mini',
          temperature,
          max_tokens: maxTokens,
          messages: chatMessages,
        }),
      }, timeoutMs);
    } catch (err) {
      throw new Error(err.name === 'AbortError'
        ? `远程模型超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`
        : `连不上远程模型：${err.message}`);
    }

    if (!res.ok) {
      const body = cleanErrorBody(await res.text().catch(() => ''));
      throw new Error(`模型接口返回 ${res.status}${body ? `：${body.slice(0, 180)}` : ''}`);
    }
    const data = await res.json();
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
      return fetchWithTimeout(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, timeoutMs);
    }

    let res;
    try {
      res = await post(body);
      if (res.status === 400) {
        const { think, ...withoutThink } = body;
        res = await post(withoutThink);
      }
    } catch (err) {
      throw new Error(err.name === 'AbortError'
        ? `Ollama 超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`
        : `连不上 Ollama：${err.message}`);
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Ollama 返回 ${res.status}${detail ? `：${detail.slice(0, 180)}` : ''}`);
    }
    const data = await res.json();
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

/**
 * 流式版本：边收边把增量交给 onDelta，最后返回完整文本。
 * 支持 OpenAI 兼容的 SSE（data: {...}）与本机 Ollama 的 NDJSON（一行一个对象）。
 */
async function completeStream({ settings, system, user, messages, temperature = 0.35, maxTokens = 1600, timeoutMs = 180000, onDelta, retried = false }) {
  const provider = settings.aiProvider;
  const chatMessages = messages || [
    system ? { role: 'system', content: system } : null,
    { role: 'user', content: user },
  ].filter(Boolean);

  const emit = (piece) => {
    if (!piece || typeof onDelta !== 'function') return;
    try { onDelta(piece); } catch { /* 回调里出错不该打断流 */ }
  };

  if (provider === 'real') {
    if (!settings.apiKey) throw new Error('还没有配置远程模型的 API Key');
    const base = String(settings.baseUrl || '').replace(/\/+$/, '');
    if (!base) throw new Error('还没有配置远程模型接口地址');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
        body: JSON.stringify({
          model: settings.model || 'gpt-4o-mini',
          temperature,
          max_tokens: maxTokens,
          stream: true,
          messages: chatMessages,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(err.name === 'AbortError'
        ? `远程模型超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`
        : `连不上远程模型：${err.message}`);
    }
    if (!res.ok) {
      clearTimeout(timer);
      const body = cleanErrorBody(await res.text().catch(() => ''));
      // 网关偶发 502：等半秒重试一次，还不行就交给上层回退
      if (isRetryable(res.status) && !retried) {
        await wait(500);
        return completeStream({ settings, system, user, messages, temperature, maxTokens, timeoutMs, onDelta, retried: true });
      }
      throw new Error(`模型接口返回 ${res.status}${body ? `：${body}` : ''}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;
          let piece = '';
          try {
            const j = JSON.parse(payload);
            piece = j?.choices?.[0]?.delta?.content || '';
          } catch { piece = ''; }
          if (piece) { full += piece; emit(piece); }
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (!full.trim()) throw new Error('模型返回了空内容');
    return { text: stripThink(full), provider: 'real', model: settings.model };
  }

  if (provider === 'ollama') {
    const base = String(settings.ollamaUrl || '').replace(/\/+$/, '');
    const model = settings.ollamaModel;
    if (!base || !model) throw new Error('还没有配置 Ollama');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: true,
          think: false,
          options: { temperature, num_predict: maxTokens },
          messages: chatMessages,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new Error(err.name === 'AbortError' ? 'Ollama 超时' : `连不上 Ollama：${err.message}`);
    }
    if (!res.ok) {
      clearTimeout(timer);
      const body = cleanErrorBody(await res.text().catch(() => ''));
      throw new Error(`Ollama 返回 ${res.status}${body ? `：${body.slice(0, 180)}` : ''}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let full = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          try {
            const j = JSON.parse(t);
            const piece = j?.message?.content || '';
            if (piece) { full += piece; emit(piece); }
          } catch { /* 半行忽略 */ }
        }
      }
    } finally {
      clearTimeout(timer);
    }
    if (!full.trim()) throw new Error('Ollama 返回了空内容');
    return { text: stripThink(full), provider: 'ollama', model };
  }

  throw new Error('当前是本地规则引擎，没有可流式调用的模型');
}

module.exports = { complete, completeStream, parseJson, providerLabel, stripThink };
