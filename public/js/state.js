/**
 * 极简全局状态：一个对象 + 订阅通知。
 * 数据量不大（一个人的工作台），改动后直接重新渲染当前视图 —— 简单、不会出现界面与数据不同步。
 */

import { api } from './api.js';

const listeners = new Set();

export const state = {
  today: '',
  tasks: [],
  plans: [],
  projects: [],
  archives: [],
  conversations: [],
  settings: null,
  /** AI 引擎状态：当前 provider、实际模型名、Ollama 是否在线及模型列表 */
  ai: null,
  stats: null,
  loading: true,
  error: null,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify() {
  for (const fn of listeners) {
    try { fn(); } catch (err) { console.error('渲染出错', err); }
  }
}

export function set(patch) {
  Object.assign(state, patch);
  notify();
}

/**
 * 从服务端重新拉一次全量数据。
 * 所有写操作之后都调用它 —— 这样工作台、待办列表、档案里的状态一定是一致的。
 */
export async function refresh() {
  const data = await api.bootstrap();
  set({
    today: data.today,
    tasks: data.tasks,
    plans: data.plans,
    projects: data.projects || [],
    archives: data.archives,
    conversations: data.conversations,
    settings: data.settings,
    ai: data.ai || null,
    stats: data.stats,
    loading: false,
    error: null,
  });
  return data;
}

// ---------------------------------------------------------------- 查询辅助

export const isDone = (t) => t.status === 'done';
export const isOpen = (t) => t.status !== 'done';

/** 今天要做的：安排日期是今天、或今天到期 */
export function isTodayTask(task) {
  return task.scheduledDate === state.today || task.dueDate === state.today;
}

export function isOverdue(task) {
  return Boolean(task.dueDate && task.dueDate < state.today && task.status !== 'done');
}

export function planById(id) {
  return state.plans.find((p) => p.id === id) || null;
}

export function projectById(id) {
  return state.projects.find((p) => p.id === id) || null;
}

export function courseById(project, courseId) {
  if (!project) return null;
  return (project.courses || []).find((c) => c.id === courseId) || null;
}

/** 今天要做的未完成任务 */
export function todayOpen() {
  return state.tasks.filter((t) => isOpen(t) && isTodayTask(t));
}

/** 今天已经完成的 */
export function todayDone() {
  return state.tasks.filter((t) => isDone(t) && isTodayTask(t));
}

/** 全部未完成（包括没有日期的 —— 这些任务不能从列表里消失） */
export function allOpen() {
  return state.tasks.filter(isOpen);
}

/** 没有安排日期的未完成任务 */
export function undatedOpen() {
  return state.tasks.filter((t) => isOpen(t) && !t.scheduledDate && !t.dueDate);
}
