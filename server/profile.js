'use strict';

/**
 * 长期记忆（很小的一个本子）
 * ---------------------------------------------------------------
 * 只记「跨对话仍然成立」的事：目标和科目、作息、明确的限制、反复卡住的点。
 * 不记情绪、不记一次性的琐事 —— 那些属于当轮对话。
 *
 * 存在 data/profile.json，纯文本，随时可以在设置里清掉。
 * 只有「让它看到学习记录」那个开关打开时，这份记忆才会跟请求一起发出去。
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');

const FILE = path.join(db.DATA_DIR, 'profile.json');
const MAX_ITEMS = 30;
const MAX_LEN = 120;

function empty() {
  return { items: [], updatedAt: null };
}

async function read() {
  try {
    const raw = await fs.promises.readFile(FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.items)) return empty();
    return {
      items: data.items.filter((x) => x && typeof x.text === 'string').slice(0, MAX_ITEMS),
      updatedAt: data.updatedAt || null,
    };
  } catch {
    return empty();
  }
}

async function write(data) {
  const next = {
    items: data.items.slice(0, MAX_ITEMS),
    updatedAt: new Date().toISOString(),
  };
  await db.atomicWrite(FILE, JSON.stringify(next, null, 2));
  return next;
}

function norm(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

/** 记一条；重复的不再记，返回这条是否真的新增 */
async function add(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LEN);
  if (!clean) return { added: false, reason: '空的' };

  const data = await read();
  if (data.items.some((x) => norm(x.text) === norm(clean))) {
    return { added: false, reason: '已经记过了' };
  }
  data.items.push({
    id: `mem-${Date.now().toString(36)}`,
    text: clean,
    at: new Date().toISOString(),
  });
  await write(data);
  return { added: true, text: clean };
}

async function list() {
  const data = await read();
  return data.items;
}

async function clear() {
  await write(empty());
  return { items: [] };
}

/** 拼成给模型看的一小段；没有内容就返回空串 */
async function asText() {
  const items = await list();
  if (!items.length) return '';
  return items.map((x, i) => `${i + 1}. ${x.text}`).join('\n');
}

module.exports = { read, add, list, clear, asText, MAX_ITEMS };
