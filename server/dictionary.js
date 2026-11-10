'use strict';

/**
 * 官方词典补充：牛津词典 API（需要用户自己申请 App ID / App Key）。
 *
 * 只在用户配置了凭据时调用，而且只发送选中的单词或短语，
 * 不发送文章段落、批注或生词本里的其他内容。
 * 欧路词典没有公开的词典内容接口，这里只提供网页跳转，不抓取它的释义。
 */

const DEFAULT_OXFORD_BASE = 'https://od-api.oxforddictionaries.com/api/v2';
const REQUEST_TIMEOUT = 8000;

function cleanTerm(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
}

/** 只有单词/短语才适合查词典；句子和含特殊符号的选中内容跳过 */
function lookupWord(value, mode) {
  const term = cleanTerm(value);
  if (!term || mode === 'sentence') return '';
  if (!/^[a-zA-Z][a-zA-Z' -]*$/.test(term)) return '';
  return term;
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function linksFor(term) {
  const word = cleanTerm(term);
  if (!word) return null;
  const q = encodeURIComponent(word);
  return {
    oxford: `https://www.oxfordlearnersdictionaries.com/search/english/?q=${q}`,
    eudic: `https://dict.eudic.net/dicts/en/${q}`,
  };
}

function hasCredentials(settings) {
  return Boolean(settings && settings.oxfordAppId && settings.oxfordAppKey);
}

function pushUnique(list, seen, value) {
  const key = value.toLowerCase();
  if (!key || seen.has(key)) return;
  seen.add(key);
  list.push(value);
}

function collectSense(sense, bucket, depth) {
  if (!sense || typeof sense !== 'object' || depth > 3) return;
  for (const definition of sense.definitions || []) {
    const value = typeof definition === 'string' ? definition : definition && definition.text;
    pushUnique(bucket.definitions, bucket.seenDefinitions, text(value, 600));
  }
  for (const example of sense.examples || []) {
    const value = typeof example === 'string' ? example : example && example.text;
    const en = text(value, 400);
    if (!en) continue;
    const key = en.toLowerCase();
    if (bucket.seenExamples.has(key)) continue;
    bucket.seenExamples.add(key);
    bucket.examples.push({ en, zh: '' });
  }
  for (const sub of sense.subsenses || []) collectSense(sub, bucket, depth + 1);
}

function fromOxford(data) {
  const results = data && Array.isArray(data.results) ? data.results : [];
  const bucket = {
    definitions: [],
    examples: [],
    derivatives: [],
    seenDefinitions: new Set(),
    seenExamples: new Set(),
    seenDerivatives: new Set(),
  };
  let partOfSpeech = '';

  for (const result of results.slice(0, 2)) {
    for (const lexical of (result && result.lexicalEntries) || []) {
      if (!partOfSpeech && lexical.lexicalCategory) {
        partOfSpeech = text(lexical.lexicalCategory.text || lexical.lexicalCategory.id, 60);
      }
      for (const derivative of lexical.derivatives || []) {
        const word = text(derivative.text || derivative.id, 80);
        if (!word) continue;
        const key = word.toLowerCase();
        if (bucket.seenDerivatives.has(key)) continue;
        bucket.seenDerivatives.add(key);
        bucket.derivatives.push({ word, partOfSpeech: '', meaningZh: '' });
      }
      for (const entry of lexical.entries || []) {
        for (const derivative of entry.derivatives || []) {
          const word = text(derivative.text || derivative.id, 80);
          if (!word) continue;
          const key = word.toLowerCase();
          if (bucket.seenDerivatives.has(key)) continue;
          bucket.seenDerivatives.add(key);
          bucket.derivatives.push({ word, partOfSpeech: '', meaningZh: '' });
        }
        for (const sense of entry.senses || []) collectSense(sense, bucket, 0);
      }
    }
  }

  if (!bucket.definitions.length && !bucket.examples.length) return null;
  return {
    label: '牛津词典',
    partOfSpeech,
    definitions: bucket.definitions.slice(0, 3),
    examples: bucket.examples.slice(0, 6),
    derivatives: bucket.derivatives.slice(0, 8),
  };
}

/** 返回 { ok: true, entry } 或 { ok: false, missing/error }，任何失败都不影响查词本身 */
async function lookupOxford({ settings, term }) {
  if (!hasCredentials(settings)) return { ok: false, missing: true };
  const base = String(settings.oxfordBaseUrl || DEFAULT_OXFORD_BASE).replace(/\/+$/, '');

  let res;
  let body = '';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      res = await fetch(`${base}/entries/en-gb/${encodeURIComponent(term.toLowerCase())}`, {
        headers: {
          Accept: 'application/json',
          app_id: settings.oxfordAppId,
          app_key: settings.oxfordAppKey,
        },
        signal: controller.signal,
      });
      body = await res.text();
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? '牛津词典接口超时' : '连不上牛津词典接口' };
  }

  if (res.status === 404) return { ok: false, missing: true };
  if (!res.ok) return { ok: false, error: `牛津词典接口返回 ${res.status}` };

  let data;
  try { data = JSON.parse(body); } catch { return { ok: false, error: '牛津词典返回了无法解析的内容' }; }
  const entry = fromOxford(data);
  if (!entry) return { ok: false, missing: true };
  return { ok: true, entry };
}

/**
 * 用牛津数据覆盖英文释义、补充官方例句和派生词。
 * 中文解释、搭配、语境含义仍然保留模型结果，不会伪装成牛津内容。
 */
async function enrich(entry, { settings, selection }) {
  const next = { ...entry };
  const term = cleanTerm(next.term || (selection && selection.text));
  if (!lookupWord(term, selection && selection.mode)) return next;
  const links = linksFor(term);
  if (links) next.dictionaryLinks = links;

  const result = await lookupOxford({ settings, term });
  if (!result.ok) {
    if (result.error) next.dictionaryError = `${result.error}，这次先用模型释义。`;
    return next;
  }

  const oxford = result.entry;
  next.dictionarySource = 'oxford';
  next.oxford = oxford;
  if (!next.partOfSpeech && oxford.partOfSpeech) next.partOfSpeech = oxford.partOfSpeech;
  if (oxford.definitions.length) next.definitionEn = oxford.definitions.slice(0, 2).join(' ');
  if (!(next.derivatives || []).length && oxford.derivatives.length) {
    next.derivatives = oxford.derivatives;
  }
  return next;
}

module.exports = { enrich, lookupOxford, fromOxford, linksFor, hasCredentials };