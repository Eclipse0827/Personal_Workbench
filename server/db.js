'use strict';

/**
 * 统一数据访问层（PRD 6.1 / 6.2）
 * ---------------------------------------------------------------
 * 所有持久化都走这里。页面组件不允许各自直接读写文件。
 *
 * 设计要点，对应 PRD 的要求：
 *   · 统一管理创建、更新、删除和查询
 *   · 处理损坏数据、缺失字段和读取失败（单个坏文件不会让整站打不开）
 *   · 重要数据修改前避免意外覆盖（每条新记录一个文件 + 临时文件原子替换）
 *   · 删除操作有清晰反馈（API 返回略，界面负责提示）
 *   · 预留未来从本地存储迁移到后端 API 的接口边界
 *     —— 这一层就是那道边界。将来换成数据库，只需要重写本文件的实现，
 *        页面和 API 路由不需要动。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');

/** 每个集合是一个目录，里面一条记录一个 JSON 文件 */
const COLLECTIONS = {
  tasks: path.join(DATA_DIR, 'tasks'),
  plans: path.join(DATA_DIR, 'plans'),
  /** 学习项目；课程作为项目里的数组一起保存，不再单独建集合 */
  projects: path.join(DATA_DIR, 'projects'),
  conversations: path.join(DATA_DIR, 'conversations'),
  archives: path.join(DATA_DIR, 'archives'),
  /** 番茄钟完成的专注记录（计时本身在浏览器里） */
  focusSessions: path.join(DATA_DIR, 'focus-sessions'),
  /** 教材的元数据、目录结构、讲义缓存和问答；正文按页单独存放 */
  textbooks: path.join(DATA_DIR, 'textbooks'),
  /** 外刊文章；正文和文章内对话单独存放 */
  articles: path.join(DATA_DIR, 'articles'),
  /** 生词本，独立于文章保存 */
  vocabulary: path.join(DATA_DIR, 'vocabulary'),
  /** 第一版遗留的「焦虑记录」，只读保留，用于迁移，绝不删除 */
  legacyEntries: path.join(DATA_DIR, 'entries'),
};

/** 教材的正文与原始 PDF 不放在记录文件里：目录列表不应该每次都把整本书读进内存 */
const TEXTBOOK_PAGES_DIR = path.join(COLLECTIONS.textbooks, 'pages');
const TEXTBOOK_FILES_DIR = path.join(COLLECTIONS.textbooks, 'files');
const ARTICLE_CONTENT_DIR = path.join(COLLECTIONS.articles, 'content');
const ARTICLE_CHAT_DIR = path.join(COLLECTIONS.articles, 'chats');

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');
/**
 * 正在进行中的那一轮专注。
 * 浏览器和桌面浮窗各自有独立的 localStorage，只有把「这一轮」放到服务端，
 * 两边看到的才是同一块表、同一个暂停状态。
 */
const ACTIVE_FOCUS_FILE = path.join(DATA_DIR, 'focus-active.json');
/**
 * 专注内容的归类关系：「单词」「墨墨背单词」都算到「背单词」。
 * 只保存标题之间的指向，不改写原始专注记录 —— 取消归类之后能原样恢复。
 */
const FOCUS_ALIASES_FILE = path.join(DATA_DIR, 'focus-aliases.json');

// ---------------------------------------------------------------- 基础工具

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const dir of Object.values(COLLECTIONS)) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(TEXTBOOK_PAGES_DIR, { recursive: true });
  fs.mkdirSync(TEXTBOOK_FILES_DIR, { recursive: true });
  fs.mkdirSync(ARTICLE_CONTENT_DIR, { recursive: true });
  fs.mkdirSync(ARTICLE_CHAT_DIR, { recursive: true });
}

function isSafeId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function assertId(id) {
  if (!isSafeId(id)) throw Object.assign(new Error('非法的标识'), { status: 400 });
  return id;
}

function newId(prefix) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
  const rand = crypto.randomBytes(4).toString('hex');
  return prefix ? `${prefix}-${stamp}-${rand}` : `${stamp}-${rand}`;
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * 原子写入：先写临时文件并落盘，再改名替换。
 * 这样即使写到一半断电/报错，也不会把已有记录写坏成半个 JSON。
 */
async function atomicWrite(file, text) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await fsp.open(tmp, 'w');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // 损坏的文件不应该让整个列表读不出来：跳过它，并在控制台留下线索
    if (err instanceof SyntaxError) {
      console.warn(`[数据] 跳过损坏的 JSON：${file}`);
      return fallback;
    }
    throw err;
  }
}

function collectionDir(name) {
  const dir = COLLECTIONS[name];
  if (!dir) throw Object.assign(new Error(`没有这个数据集合：${name}`), { status: 500 });
  return dir;
}

// ---------------------------------------------------------------- 通用集合操作

async function list(name) {
  const dir = collectionDir(name);
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const file of names) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue;
    const item = await readJson(path.join(dir, file), null);
    if (item && typeof item === 'object') out.push(item);
  }
  return out;
}

/** 按创建时间倒序（新的在前） */
async function listSorted(name) {
  const items = await list(name);
  return items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function get(name, id) {
  assertId(id);
  const item = await readJson(path.join(collectionDir(name), `${id}.json`), null);
  if (!item) throw Object.assign(new Error('找不到这条记录'), { status: 404 });
  return item;
}

async function getOrNull(name, id) {
  if (!isSafeId(id)) return null;
  return readJson(path.join(collectionDir(name), `${id}.json`), null);
}

async function put(name, item) {
  assertId(item.id);
  item.updatedAt = nowIso();
  await atomicWrite(path.join(collectionDir(name), `${item.id}.json`), JSON.stringify(item, null, 2));
  return item;
}

async function remove(name, id) {
  assertId(id);
  const file = path.join(collectionDir(name), `${id}.json`);
  const existed = fs.existsSync(file);
  await fsp.rm(file, { force: true });
  return { ok: true, existed };
}

/** 统计某个集合里满足条件的数量，不读进内存做多余的事 */
async function count(name, predicate) {
  const items = await list(name);
  return predicate ? items.filter(predicate).length : items.length;
}

// ---------------------------------------------------------------- 设置

function defaultSettings() {
  return {
    /**
     * AI 引擎，三种实现：
     *   mock   —— 本地规则引擎（离线、确定性、遵守 PRD 的对话与拆解规则）
     *   ollama —— 本机 Ollama：模型负责「怎么说话」，结构化内容仍由规则引擎生成
     *   real   —— 远程 OpenAI 兼容接口：模型负责全部内容
     */
    aiProvider: 'mock',
    /** 远程模型 */
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: '',
    /** 本地 Ollama */
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: '',
    /** 牛津词典 API（可选，只用于补充官方释义和例句） */
    oxfordAppId: '',
    oxfordAppKey: '',
  };
}

async function getSettings() {
  const raw = await readJson(SETTINGS_FILE, null);
  const merged = { ...defaultSettings(), ...(raw || {}) };
  // 兼容第一版的字段名
  if (!raw || raw.aiProvider === undefined) {
    if (raw && raw.provider === 'openai-compatible') merged.aiProvider = 'real';
    if (raw && raw.provider === 'local') merged.aiProvider = 'mock';
  }
  return merged;
}

/** 对外只暴露「有没有配 Key」，绝不回显明文 */
async function getPublicSettings() {
  const s = await getSettings();
  return {
    aiProvider: s.aiProvider,
    baseUrl: s.baseUrl,
    model: s.model,
    hasApiKey: Boolean(s.apiKey),
    ollamaUrl: s.ollamaUrl,
    ollamaModel: s.ollamaModel,
    oxfordAppId: s.oxfordAppId || '',
    hasOxfordKey: Boolean(s.oxfordAppKey),
  };
}

async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current };
  if (['mock', 'ollama', 'real'].includes(patch.aiProvider)) next.aiProvider = patch.aiProvider;
  if (typeof patch.baseUrl === 'string') next.baseUrl = patch.baseUrl.trim();
  if (typeof patch.model === 'string') next.model = patch.model.trim();
  if (typeof patch.ollamaUrl === 'string') next.ollamaUrl = patch.ollamaUrl.trim();
  if (typeof patch.ollamaModel === 'string') next.ollamaModel = patch.ollamaModel.trim();
  if (typeof patch.apiKey === 'string' && patch.apiKey.trim() !== '') next.apiKey = patch.apiKey.trim();
  if (patch.clearApiKey === true) next.apiKey = '';
  if (typeof patch.oxfordAppId === 'string') next.oxfordAppId = patch.oxfordAppId.trim();
  if (typeof patch.oxfordAppKey === 'string' && patch.oxfordAppKey.trim() !== '') {
    next.oxfordAppKey = patch.oxfordAppKey.trim();
  }
  if (patch.clearOxfordKey === true) next.oxfordAppKey = '';
  // 只保留约定字段，避免设置文件被塞进预期外的东西
  const clean = {
    aiProvider: next.aiProvider,
    baseUrl: next.baseUrl,
    model: next.model,
    apiKey: next.apiKey,
    ollamaUrl: next.ollamaUrl,
    ollamaModel: next.ollamaModel,
    oxfordAppId: next.oxfordAppId,
    oxfordAppKey: next.oxfordAppKey,
  };
  await atomicWrite(SETTINGS_FILE, JSON.stringify(clean, null, 2));
  return getPublicSettings();
}

// ---------------------------------------------------------------- 活动专注（唯一一条）

async function getActiveFocus() {
  const record = await readJson(ACTIVE_FOCUS_FILE, null);
  if (!record || typeof record !== 'object' || !record.token || !record.endAt) return null;
  return record;
}

async function saveActiveFocus(record) {
  await atomicWrite(ACTIVE_FOCUS_FILE, JSON.stringify(record, null, 2));
  return record;
}

async function clearActiveFocus() {
  await fsp.rm(ACTIVE_FOCUS_FILE, { force: true });
}

// ---------------------------------------------------------------- 专注内容归类

/** 返回 { [标题小写]: { from, to, updatedAt } }；坏数据直接跳过 */
async function getFocusAliases() {
  const data = await readJson(FOCUS_ALIASES_FILE, null);
  const aliases = data && typeof data === 'object' ? data.aliases : null;
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) return {};
  const out = {};
  for (const [key, entry] of Object.entries(aliases)) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.from !== 'string' || typeof entry.to !== 'string') continue;
    const from = entry.from.trim();
    const to = entry.to.trim();
    if (!from || !to) continue;
    out[key] = { from, to, updatedAt: entry.updatedAt || null };
  }
  return out;
}

async function saveFocusAliases(aliases) {
  const clean = {};
  for (const [key, entry] of Object.entries(aliases || {})) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.from !== 'string' || typeof entry.to !== 'string') continue;
    if (!entry.from.trim() || !entry.to.trim()) continue;
    clean[key] = {
      from: entry.from.trim(),
      to: entry.to.trim(),
      updatedAt: entry.updatedAt || nowIso(),
    };
  }
  await atomicWrite(FOCUS_ALIASES_FILE, JSON.stringify({ aliases: clean }, null, 2));
  return clean;
}

// ---------------------------------------------------------------- meta（迁移标记等）

async function getMeta() {
  return (await readJson(META_FILE, null)) || { migrations: [] };
}

async function saveMeta(meta) {
  await atomicWrite(META_FILE, JSON.stringify(meta, null, 2));
  return meta;
}

// ---------------------------------------------------------------- 教材正文与原始文件

/** 教材正文：数组 [{ page, text }]，与元数据分开存放 */
async function writeTextbookPages(id, pages) {
  assertId(id);
  const file = path.join(TEXTBOOK_PAGES_DIR, `${id}.json`);
  await atomicWrite(file, JSON.stringify({ id, pages }, null, 2));
  return pages;
}

async function readTextbookPages(id) {
  assertId(id);
  const data = await readJson(path.join(TEXTBOOK_PAGES_DIR, `${id}.json`), null);
  return data && Array.isArray(data.pages) ? data.pages : [];
}

function textbookFilePath(id) {
  assertId(id);
  return path.join(TEXTBOOK_FILES_DIR, `${id}.pdf`);
}

async function textbookFileExists(id) {
  assertId(id);
  try {
    const st = await fsp.stat(textbookFilePath(id));
    return st.isFile() && st.size > 0;
  } catch { return false; }
}

async function removeTextbookAssets(id) {
  assertId(id);
  await fsp.rm(path.join(TEXTBOOK_PAGES_DIR, `${id}.json`), { force: true });
  await fsp.rm(textbookFilePath(id), { force: true });
  // 上传中断时留下的临时文件也一并清掉
  try {
    const names = await fsp.readdir(TEXTBOOK_FILES_DIR);
    for (const n of names) {
      if (n.startsWith(`.${id}.`) && n.endsWith('.tmp')) {
        await fsp.rm(path.join(TEXTBOOK_FILES_DIR, n), { force: true });
      }
    }
  } catch { /* 目录不存在就算了 */ }
}

// ---------------------------------------------------------------- 外刊正文与文章内对话

async function writeArticleContent(id, paragraphs) {
  assertId(id);
  await atomicWrite(
    path.join(ARTICLE_CONTENT_DIR, `${id}.json`),
    JSON.stringify({ id, version: 1, paragraphs }, null, 2)
  );
  return paragraphs;
}

async function readArticleContent(id) {
  assertId(id);
  const data = await readJson(path.join(ARTICLE_CONTENT_DIR, `${id}.json`), null);
  return data && Array.isArray(data.paragraphs) ? data.paragraphs : [];
}

async function writeArticleChat(id, chat) {
  assertId(id);
  await atomicWrite(
    path.join(ARTICLE_CHAT_DIR, `${id}.json`),
    JSON.stringify({ articleId: id, messages: (chat && chat.messages) || [] }, null, 2)
  );
  return chat;
}

async function readArticleChat(id) {
  assertId(id);
  const data = await readJson(path.join(ARTICLE_CHAT_DIR, `${id}.json`), null);
  return { articleId: id, messages: data && Array.isArray(data.messages) ? data.messages : [] };
}

async function removeArticleAssets(id) {
  assertId(id);
  await fsp.rm(path.join(ARTICLE_CONTENT_DIR, `${id}.json`), { force: true });
  await fsp.rm(path.join(ARTICLE_CHAT_DIR, `${id}.json`), { force: true });
}

module.exports = {
  ROOT,
  DATA_DIR,
  COLLECTIONS,
  TEXTBOOK_PAGES_DIR,
  TEXTBOOK_FILES_DIR,
  ARTICLE_CONTENT_DIR,
  ARTICLE_CHAT_DIR,
  ensureDirs,
  atomicWrite,
  newId,
  nowIso,
  isSafeId,
  list,
  listSorted,
  get,
  getOrNull,
  put,
  remove,
  count,
  writeTextbookPages,
  readTextbookPages,
  textbookFilePath,
  textbookFileExists,
  removeTextbookAssets,
  writeArticleContent,
  readArticleContent,
  writeArticleChat,
  readArticleChat,
  removeArticleAssets,
  getSettings,
  getPublicSettings,
  saveSettings,
  defaultSettings,
  getActiveFocus,
  saveActiveFocus,
  clearActiveFocus,
  ACTIVE_FOCUS_FILE,
  getFocusAliases,
  saveFocusAliases,
  FOCUS_ALIASES_FILE,
  getMeta,
  saveMeta,
};
