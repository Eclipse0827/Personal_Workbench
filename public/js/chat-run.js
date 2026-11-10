/**
 * 进行中的对话请求
 * ---------------------------------------------------------------
 * 为什么单独抽一层：模型回一轮要好幾秒到几十秒，这段时间里用户完全可能
 * 切去看待办、翻教材。如果请求的生命周期跟着视图走，视图一卸载，
 * 正在生成的那段就没了 —— 回到对话页只看得到「还没有消息」，
 * 得等服务端自己跑完才有记录。
 *
 * 所以这里把「跑」和「看」分开：
 *   · 请求跑在这个模块里，和任何视图无关；
 *   · 视图只是订阅者，挂上就能接上当前进度，卸下就退订，请求照跑；
 *   · 完成后服务端已落库，重新拉一次就是正式消息。
 *
 * 一个对话同时只允许一轮在跑；不同对话可以各跑各的。
 */

import { api } from './api.js';

const runs = new Map();

function emit(run, evt) {
  for (const fn of [...run.listeners]) {
    try { fn(run, evt); } catch (err) { console.error('对话订阅者出错', err); }
  }
}

/**
 * 广播「有一轮开始 / 结束了」。
 * 视图不一定还挂在那个对话上（比如用户在列表页），
 * 靠这个让它把左侧的「正在回复」标记撤掉。
 */
function broadcast() {
  try {
    window.dispatchEvent(new CustomEvent('chat-run-state'));
  } catch { /* 非浏览器环境，忽略 */ }
}

function isAbort(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  return /aborted|abort/i.test(String(err.message || ''));
}

/**
 * @param {string} conversationId
 * @param {string} userText  新一轮的内容；retry 时只用来占位（服务端会用最后一条自己的话）
 * @param {{retry?: boolean, modelRef?: string}} opts
 */
function start(conversationId, userText, { retry = false, modelRef = null } = {}) {
  const living = runs.get(conversationId);
  if (living && living.status === 'running') {
    throw new Error('这一轮还没回完，等它说完再发。');
  }

  const controller = new AbortController();
  const run = {
    id: `run-${Date.now()}`,
    conversationId,
    userText,
    retry,
    modelRef,
    text: '',            // 已经到达的回答文本（可能只是半截）
    statusText: '',      // 「正在查…」这类过程提示，不算正文
    actions: [],         // 它已经做过的动作
    userMessage: null,   // 服务端先落库后回传的那条用户消息
    status: 'running',   // running | done | stopped | error
    gone: false,         // 生成期间对话被删了
    error: '',
    warning: '',
    result: null,
    startedAt: Date.now(),
    finishedAt: 0,
    listeners: new Set(),
    stop() {
      try { controller.abort(); } catch { /* 已经结束 */ }
    },
  };
  runs.set(conversationId, run);
  emit(run, { type: 'start' });
  broadcast();

  (async () => {
    try {
      const res = await api.sendMessageStream(conversationId, userText, {
        signal: controller.signal,
        retry,
        modelRef,
        onEvent: (evt) => {
          if (!evt || !evt.type) return;
          if (evt.type === 'open') {
            run.userMessage = evt.userMessage || null;
          } else if (evt.type === 'partial') {
            run.text = evt.text || '';
            run.statusText = '';
          } else if (evt.type === 'status') {
            run.statusText = evt.text || '';   // 只当提示，不混进正文
          } else if (evt.type === 'tool') {
            run.actions = run.actions.concat([evt]);
            run.text = '';            // 工具跑完，下一步的回答重新开始
            run.statusText = '';
          } else if (evt.type === 'gone') {
            run.gone = true;
          }
          emit(run, evt);
        },
      });
      run.status = 'done';
      run.result = res;
      run.warning = res.warning || '';
      run.finishedAt = Date.now();
      emit(run, { type: 'done', result: res });
    } catch (err) {
      if (isAbort(err)) {
        run.status = 'stopped';
        run.finishedAt = Date.now();
        emit(run, { type: 'stopped' });
      } else if (run.gone) {
        // 服务端在收尾前发现对话被删了，直接断开 —— 这不是错误
        run.status = 'gone';
        run.finishedAt = Date.now();
        emit(run, { type: 'gone' });
      } else {
        run.status = 'error';
        run.error = err.message || String(err);
        run.finishedAt = Date.now();
        emit(run, { type: 'error', error: run.error });
      }
    } finally {
      // 留一小段时间，方便刚好切回来的视图还能读到最终状态；
      // 之后靠服务端的历史就够了。
      setTimeout(() => {
        if (runs.get(conversationId) === run) runs.delete(conversationId);
      }, 15000);
      broadcast();
    }
  })();

  return run;
}

function subscribe(run, fn) {
  if (!run) return () => {};
  run.listeners.add(fn);
  return () => run.listeners.delete(fn);
}

export const chatRun = {
  start,
  subscribe,
  get: (conversationId) => runs.get(conversationId) || null,
  isRunning: (conversationId) => {
    const run = runs.get(conversationId);
    return Boolean(run && run.status === 'running');
  },
  stop: (conversationId) => {
    const run = runs.get(conversationId);
    if (run && run.status === 'running') run.stop();
  },
  anywhereRunning: () => [...runs.values()].some((r) => r.status === 'running'),
  runningIds: () => [...runs.values()].filter((r) => r.status === 'running').map((r) => r.conversationId),
};
