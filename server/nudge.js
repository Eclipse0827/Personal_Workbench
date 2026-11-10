'use strict';

/**
 * 一句主动的提醒（最多一句，而且只在真有事的时候）
 * ---------------------------------------------------------------
 * PRD 的底线：不催促、不制造压力、不做打卡。
 * 所以这里只做三件事：
 *   · 说出一个事实（有几件事排在过去没动 / 今天还没安排）
 *   · 给一个动作（去看看 / 挑一件小的）
 *   · 别的什么都不说；没事就返回 null，不硬凑
 */

const db = require('./db');
const { localDayKey } = require('./focus-stats');

async function build() {
  const tasks = await db.list('tasks');
  const today = localDayKey(new Date());
  const open = tasks.filter((t) => t.status !== 'done');
  if (!open.length) return null;

  const overdue = open.filter((t) => t.dueDate && t.dueDate < today);
  const todayTasks = open.filter((t) => t.scheduledDate === today || t.dueDate === today);
  const undated = open.filter((t) => !t.scheduledDate && !t.dueDate);

  if (overdue.length >= 3) {
    return {
      kind: 'overdue',
      text: `有 ${overdue.length} 件事排在过去，还挂着。`,
      hint: overdue.slice(0, 3).map((t) => t.title).join(' · '),
      action: '去看看',
      to: '/tasks',
    };
  }

  if (!todayTasks.length) {
    const pick = undated[0] || open[0];
    return {
      kind: 'empty-day',
      text: '今天还没有安排。',
      hint: pick ? `可以先放一件最小的：${pick.title}` : '',
      action: '去看看',
      to: '/tasks',
    };
  }

  return null;
}

module.exports = { build };
