'use strict';

/**
 * 专注统计（纯函数，不读写数据）
 * ---------------------------------------------------------------
 * 从 server.js 抽出来，供页面接口和 AI Context Builder 共用：
 *   · 时间窗口由调用方指定，默认 7 天（保持原有行为）
 *   · week* 始终表示最近 7 天，window* 表示本次请求的窗口
 *   · total* / byContent 仍然是全部历史，不受窗口影响
 */

/** 本地日历日，避免用 UTC 切日期导致「今天」在晚上八点就变了 */
function localDayKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function clampWindowDays(value, fallback = 7) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(366, Math.round(n)));
}

function focusContentKey(title) {
  return String(title || '').replace(/\s+/g, ' ').trim() || '未命名专注';
}

function focusTitleKey(title) {
  return focusContentKey(title).toLowerCase();
}

/** 顺着归类关系找到最终标题；带环保护，坏数据也不会让统计卡死 */
function resolveFocusAlias(title, aliases) {
  let current = focusContentKey(title);
  const seen = new Set();
  while (!seen.has(current.toLowerCase())) {
    seen.add(current.toLowerCase());
    const entry = aliases && aliases[focusTitleKey(current)];
    if (!entry || !entry.to) break;
    const next = focusContentKey(entry.to);
    if (next.toLowerCase() === current.toLowerCase()) break;
    current = next;
  }
  return current;
}

/** 对外只给出最终标题，前端不必自己再顺一遍 */
function focusAliasList(aliases) {
  return Object.values(aliases || {})
    .filter((entry) => entry && entry.from && entry.to)
    .map((entry) => ({
      from: focusContentKey(entry.from),
      to: resolveFocusAlias(entry.to, aliases),
      updatedAt: entry.updatedAt || null,
    }))
    .sort((a, b) => a.from.localeCompare(b.from, 'zh-Hans-CN'));
}

function focusSeconds(session) {
  const seconds = Number(session && session.actualSeconds);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds);
  return Math.max(0, Math.round((Number(session && session.minutes) || 0) * 60));
}

function focusStats(sessions, aliases = {}, options = {}) {
  const windowDays = clampWindowDays(options.days, 7);
  const valid = sessions.filter((s) => !s.undoneAt && s.mode === 'focus');
  const now = options.now instanceof Date && !Number.isNaN(options.now.getTime())
    ? options.now
    : new Date();
  const todayKey = localDayKey(now);
  const yesterdayKey = localDayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const days = [];
  const byKey = new Map();
  for (let i = windowDays - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = localDayKey(d);
    const day = { date: key, seconds: 0, minutes: 0, sessions: 0, content: [] };
    days.push(day);
    byKey.set(key, day);
  }

  let totalSeconds = 0;
  let totalSessions = 0;
  let todaySeconds = 0;
  let todaySessions = 0;
  let yesterdaySeconds = 0;
  let yesterdaySessions = 0;
  let windowSeconds = 0;
  let windowSessions = 0;
  const contentAll = new Map();
  const contentByDay = new Map();

  const bump = (map, title, seconds, endedAt) => {
    const key = title.toLowerCase();
    let item = map.get(key);
    if (!item) {
      item = { title, seconds: 0, sessions: 0, lastAt: endedAt };
      map.set(key, item);
    }
    item.seconds += seconds;
    item.sessions += 1;
    if (String(endedAt) > String(item.lastAt)) {
      item.lastAt = endedAt;
      item.title = title;
    }
  };

  for (const s of valid) {
    const seconds = focusSeconds(s);
    const title = resolveFocusAlias(s.title, aliases);
    totalSeconds += seconds;
    totalSessions += 1;
    bump(contentAll, title, seconds, s.endedAt);

    const key = localDayKey(s.endedAt);
    const day = byKey.get(key);
    if (!day) continue;
    day.seconds += seconds;
    day.sessions += 1;
    windowSeconds += seconds;
    windowSessions += 1;
    if (!contentByDay.has(key)) contentByDay.set(key, new Map());
    bump(contentByDay.get(key), title, seconds, s.endedAt);
    if (key === todayKey) {
      todaySeconds += seconds;
      todaySessions += 1;
    } else if (key === yesterdayKey) {
      yesterdaySeconds += seconds;
      yesterdaySessions += 1;
    }
  }

  const withMinutes = (item) => ({
    ...item,
    minutes: Math.round(item.seconds / 60),
  });

  for (const day of days) {
    day.minutes = Math.round(day.seconds / 60);
    day.content = [...(contentByDay.get(day.date) || new Map()).values()]
      .map(withMinutes)
      .sort((a, b) => b.seconds - a.seconds || a.title.localeCompare(b.title, 'zh-Hans-CN'));
  }

  const byContent = [...contentAll.values()]
    .map(withMinutes)
    .sort((a, b) => b.seconds - a.seconds || a.title.localeCompare(b.title, 'zh-Hans-CN'));

  // 窗口内的内容汇总：只合并本次窗口内的天，不掺入更早的记录
  const windowContent = new Map();
  for (const day of days) {
    for (const item of (contentByDay.get(day.date) || new Map()).values()) {
      const key = item.title.toLowerCase();
      let acc = windowContent.get(key);
      if (!acc) {
        acc = { title: item.title, seconds: 0, sessions: 0, lastAt: item.lastAt };
        windowContent.set(key, acc);
      }
      acc.seconds += item.seconds;
      acc.sessions += item.sessions;
      if (String(item.lastAt) > String(acc.lastAt)) {
        acc.lastAt = item.lastAt;
        acc.title = item.title;
      }
    }
  }
  const windowByContent = [...windowContent.values()]
    .map(withMinutes)
    .sort((a, b) => b.seconds - a.seconds || a.title.localeCompare(b.title, 'zh-Hans-CN'));

  // week* 固定表示最近 7 天，即使本次看的是 30 天窗口
  const weekDays = days.slice(-7);
  const weekSeconds = weekDays.reduce((n, d) => n + d.seconds, 0);
  const weekSessions = weekDays.reduce((n, d) => n + d.sessions, 0);

  return {
    todayKey,
    yesterdayKey,
    totalSessions,
    totalSeconds,
    totalMinutes: Math.round(totalSeconds / 60),
    todayMinutes: Math.round(todaySeconds / 60),
    todaySeconds,
    todaySessions,
    yesterdayMinutes: Math.round(yesterdaySeconds / 60),
    yesterdaySeconds,
    yesterdaySessions,
    weekMinutes: Math.round(weekSeconds / 60),
    weekSeconds,
    weekSessions,
    windowDays,
    windowStartKey: days[0] ? days[0].date : '',
    windowEndKey: todayKey,
    windowMinutes: Math.round(windowSeconds / 60),
    windowSeconds,
    windowSessions,
    byDay: days,
    byContent,
    windowByContent,
  };
}

module.exports = {
  localDayKey,
  clampWindowDays,
  focusContentKey,
  focusTitleKey,
  resolveFocusAlias,
  focusAliasList,
  focusSeconds,
  focusStats,
};
