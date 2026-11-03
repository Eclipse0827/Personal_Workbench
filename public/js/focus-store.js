/**
 * 番茄钟的计时状态。
 * ---------------------------------------------------------------
 * 计时本身仍然由浏览器按「结束时间」算，刷新、切标签页都不会跑偏；
 * 但「这一轮」同时保存在服务端，桌面浮窗和网页看到的才是同一块表。
 *
 * 在线时服务端是权威：在浮窗里暂停、结束，网页会跟着变；
 * 断网时先在本机继续走，结果进入待发队列，服务恢复后按 clientToken 补交，
 * 同一个令牌只会留下一条记录。
 */

import { api } from './api.js';

const ACTIVE_KEY = 'huan-focus-active-v1';
const OUTBOX_KEY = 'huan-focus-outbox-v1';
const CANCELLED_KEY = 'huan-focus-cancelled-v1';
const DISMISSED_KEY = 'huan-focus-dismissed-v1';

const listeners = new Set();
let current = null;
let lastResult = null;
let ticker = null;
let retryTimer = null;
let pollTimer = null;
let pollBusy = false;
let initialPollDone = false;
let finishing = false;
let initialized = false;
let audio = null;

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function writeJson(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* 隐私模式写不进去也不影响这一次使用 */ }
}

function readSet(key) {
  const list = readJson(key, []);
  return new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
}

function writeSet(key, set) {
  const list = [...set].slice(-30);
  writeJson(key, list.length ? list : null);
}

function emit(type = 'tick', extra = {}) {
  const snapshot = {
    type,
    current,
    remainingMs: remainingMs(),
    running: Boolean(current && !current.pausedAt),
    paused: Boolean(current && current.pausedAt),
    lastResult,
    pending: outbox().length,
    ...extra,
  };
  for (const fn of listeners) {
    try { fn(snapshot); } catch (err) { console.error('专注状态订阅出错', err); }
  }
}

function announce(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function makeToken() {
  try {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* 用下面的兜底 */ }
  return `f-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function remainingMs() {
  if (!current) return 0;
  if (current.pausedAt) return Math.max(0, Number(current.pausedRemainingMs) || 0);
  return Math.max(0, Number(current.endAt) - Date.now());
}

function outbox() {
  const list = readJson(OUTBOX_KEY, []);
  return Array.isArray(list) ? list : [];
}

function saveOutbox(list) {
  writeJson(OUTBOX_KEY, list.length ? list : null);
}

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (!current) {
      stopTicker();
      return;
    }
    if (!current.pausedAt && remainingMs() <= 0) {
      finish({ natural: true });
      return;
    }
    emit('tick');
  }, 500);
}

function stopTicker() {
  if (ticker) { clearInterval(ticker); ticker = null; }
}

function persist() {
  writeJson(ACTIVE_KEY, current);
}

function sleepAudio() {
  try {
    if (!audio) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audio = new Ctx();
    }
    if (audio.state === 'suspended') audio.resume();
  } catch { audio = null; }
}

function chime() {
  try {
    sleepAudio();
    if (!audio) return;
    const nowAt = audio.currentTime;
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, i) => {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, nowAt + i * 0.16);
      gain.gain.linearRampToValueAtTime(0.09, nowAt + i * 0.16 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, nowAt + i * 0.16 + 0.75);
      osc.connect(gain).connect(audio.destination);
      osc.start(nowAt + i * 0.16);
      osc.stop(nowAt + i * 0.16 + 0.8);
    });
  } catch { /* 声音失败不影响记录 */ }
}

async function postSession(payload) {
  return api.createFocusSession(payload);
}

// ---------------------------------------------------------------- 与服务端对账

function sameToken(result, token) {
  return Boolean(
    token
    && result
    && (
      (result.session && result.session.clientToken === token)
      || (result.payload && result.payload.clientToken === token)
    )
  );
}

function adoptActive(active, { silent = false } = {}) {
  if (!active) return false;
  const prev = current;
  current = { ...active, token: String(active.token || makeToken()), synced: true };
  delete current.pendingAction;
  persist();
  if (current.pausedAt) stopTicker();
  else startTicker();

  const changed = !prev
    || prev.token !== current.token
    || Boolean(prev.pausedAt) !== Boolean(current.pausedAt)
    || Number(prev.endAt) !== Number(current.endAt)
    || String(prev.title) !== String(current.title);
  if (changed && !silent) emit('sync');
  return changed;
}

function recordRemaining(record) {
  if (!record) return 0;
  if (record.pausedAt) return Math.max(0, Number(record.pausedRemainingMs) || 0);
  return Math.max(0, Number(record.endAt) - Date.now());
}

function rememberResult(result, { announceIt = false } = {}) {
  if (!result || !result.session) return false;
  const id = result.session.id;
  if (readSet(DISMISSED_KEY).has(id)) return false;
  const prevId = lastResult && lastResult.session && lastResult.session.id;
  lastResult = { ...result, ok: result.ok !== false };
  if (prevId !== id) {
    if (announceIt) {
      emit('finished');
      announce('focus:done', lastResult);
    } else {
      emit('tick');
    }
    return true;
  }
  return false;
}

async function pushStart(record) {
  if (!record) return false;
  try {
    const data = await api.startActiveFocus({
      clientToken: record.token,
      mode: record.mode,
      title: record.title,
      taskId: record.taskId || null,
      planId: record.planId || null,
      minutes: record.minutes,
      completeTask: Boolean(record.completeTask),
      // 离线走过一段的本机计时，交给服务端时保留剩余时间，而不是重新从整段开始
      remainingMs: recordRemaining(record),
      startedAt: record.startedAt,
    });
    adoptActive(data.active);
    return true;
  } catch (err) {
    if (err.status === 409) {
      try {
        const state = await api.activeFocus();
        if (state.active) {
          adoptActive(state.active);
          announce('focus:conflict', { active: state.active });
        }
        return true;
      } catch { return false; }
    }
    return false;
  }
}

async function retryPendingAction() {
  if (!current || !current.pendingAction) return false;
  const action = current.pendingAction;
  try {
    const data = await api.patchActiveFocus(action);
    if (data.active) {
      current = { ...data.active, token: data.active.token, synced: true };
      delete current.pendingAction;
      persist();
      if (current.pausedAt) stopTicker();
      else startTicker();
      emit('sync');
      return true;
    }
    if (data.justFinished) {
      current = null;
      persist();
      stopTicker();
      rememberResult(data.lastResult, { announceIt: true });
      return true;
    }
    return true;
  } catch (err) {
    if (err.status === 404 && !current.synced) {
      const ok = await pushStart(current);
      if (ok && current) {
        current.pendingAction = action;
        persist();
        return retryPendingAction();
      }
    }
    return false;
  }
}

async function reconcile(data) {
  // 正在结束这一轮时，服务端的「还在进行」是旧状态，别把它又接回来
  if (finishing) return;
  const active = data.active || null;
  const serverResult = data.lastResult && data.lastResult.session ? data.lastResult : null;
  const cancelled = readSet(CANCELLED_KEY);
  const announceIt = initialPollDone || Boolean(current);

  if (data.cancelledToken) {
    if (cancelled.has(data.cancelledToken)) {
      cancelled.delete(data.cancelledToken);
      writeSet(CANCELLED_KEY, cancelled);
    }
    if (current && current.token === data.cancelledToken) {
      current = null;
      persist();
      stopTicker();
      emit('cancel');
      announce('focus:cancelled', {});
      return;
    }
  }

  if (active) {
    // 本机刚点过「放弃」，但请求没送到：先把取消补上，别把这一轮又接回来
    if (cancelled.has(active.token)) {
      try { await api.cancelActiveFocus(); } catch { /* 下次轮询再试 */ }
      cancelled.delete(active.token);
      writeSet(CANCELLED_KEY, cancelled);
      if (current && current.token === active.token) {
        current = null;
        persist();
        stopTicker();
        emit('cancel');
      }
      return;
    }

    if (current && current.token === active.token) {
      if (current.pendingAction) {
        // 本机刚暂停 / 继续，但请求没送到：先重试，成功与否都以本机这次操作为准
        await retryPendingAction();
        return;
      }
      const before = {
        paused: Boolean(current.pausedAt),
        endAt: Number(current.endAt),
        title: String(current.title || ''),
        remaining: Number(current.pausedRemainingMs) || 0,
      };
      current = { ...current, ...active, synced: true };
      delete current.pendingAction;
      persist();
      if (current.pausedAt) stopTicker();
      else startTicker();
      if (before.paused !== Boolean(current.pausedAt)
        || before.endAt !== Number(current.endAt)
        || before.title !== String(current.title || '')
        || before.remaining !== (Number(current.pausedRemainingMs) || 0)) {
        emit('sync');
      }
      return;
    }

    if (current && !current.synced) {
      const ok = await pushStart(current);
      if (ok) return;
    }

    adoptActive(active);
    return;
  }

  // ---- 服务端没有进行中的计时

  if (current) {
    if (cancelled.has(current.token)) {
      try { await api.cancelActiveFocus(); } catch { /* 下次再试 */ }
      cancelled.delete(current.token);
      writeSet(CANCELLED_KEY, cancelled);
      current = null;
      persist();
      stopTicker();
      emit('cancel');
      return;
    }

    if (serverResult && sameToken(serverResult, current.token)) {
      current = null;
      persist();
      stopTicker();
      rememberResult(serverResult, { announceIt });
      return;
    }

    // 服务端重启会丢掉活动记录；本地这一轮还在，就重新交上去，不白白丢掉计时
    const ok = await pushStart(current);
    if (!ok) return;
    return;
  }

  if (serverResult) {
    const id = serverResult.session.id;
    const dismissed = readSet(DISMISSED_KEY).has(id);
    const sameAsShown = lastResult && lastResult.session && lastResult.session.id === id;
    if (!dismissed && !sameAsShown) {
      rememberResult(serverResult, { announceIt: Boolean(data.justFinished) && announceIt });
    }
  }
}

async function pollActive() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const data = await api.activeFocus();
    await reconcile(data);
  } catch { /* 离线时继续用本机计时 */ }
  finally {
    pollBusy = false;
    initialPollDone = true;
  }
}

// ---------------------------------------------------------------- 结束与待发队列

function buildFinishPayload(snapshot, natural, remaining) {
  const plannedSeconds = Math.round(snapshot.minutes * 60);
  const elapsedSeconds = natural
    ? plannedSeconds
    : Math.max(1, Math.min(plannedSeconds, Math.round((plannedSeconds * 1000 - remaining) / 1000)));
  const endedAt = natural && snapshot.endAt
    ? new Date(snapshot.endAt).toISOString()
    : new Date().toISOString();

  return {
    clientToken: snapshot.token,
    mode: snapshot.mode,
    title: snapshot.title,
    taskId: snapshot.taskId || null,
    planId: snapshot.planId || null,
    minutes: snapshot.minutes,
    actualSeconds: elapsedSeconds,
    startedAt: snapshot.startedAt,
    endedAt,
    completeTask: snapshot.mode === 'focus' && Boolean(snapshot.completeTask),
  };
}

async function flushOutbox() {
  if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
  const list = outbox();
  if (!list.length) return;
  const left = [];
  let synced = 0;
  for (const item of list) {
    try {
      const result = await postSession(item.payload);
      if (item.isLast) {
        lastResult = { ...(lastResult || {}), ...result, ok: true, error: null, synced: true };
      }
      synced += 1;
    } catch (err) {
      const permanent = err && [400, 404, 413, 422].includes(err.status);
      if (!permanent) left.push(item);
    }
  }
  saveOutbox(left);
  if (left.length) {
    retryTimer = setInterval(flushOutbox, 30000);
  }
  if (synced) {
    emit('synced');
    announce('focus:synced', { count: synced });
    pollActive();
  }
  emit('tick');
}

function queueAndSync(payload) {
  const list = outbox();
  list.push({ token: payload.clientToken, payload, isLast: true, queuedAt: new Date().toISOString() });
  saveOutbox(list);
  flushOutbox();
}

function finishLocally(snapshot, natural, err, remaining) {
  const payload = buildFinishPayload(snapshot, natural, remaining);
  lastResult = {
    ok: false,
    error: err && err.message ? err.message : '本地服务暂时连不上',
    payload,
    completedAt: new Date().toISOString(),
  };
  queueAndSync(payload);
  emit('finished');
  announce('focus:done', { ...lastResult, offline: true });
}

async function finish({ natural = false } = {}) {
  if (!current || finishing) return;
  finishing = true;
  const snapshot = current;
  const leftAtFinish = remainingMs();

  current = null;
  persist();
  stopTicker();
  chime();

  try {
    if (!snapshot.synced) {
      finishLocally(snapshot, natural, null, leftAtFinish);
      return;
    }

    try {
      const data = await api.finishActiveFocus({ natural, clientToken: snapshot.token });
      lastResult = { ...data, ok: true, completedAt: data.completedAt || new Date().toISOString() };
      emit('finished');
      announce('focus:done', lastResult);
      return;
    } catch (err) {
      if (err.status === 404) {
        // 可能另一个窗口已经结束或放弃；先看服务端留下的是结果还是取消标记
        let state = null;
        try { state = await api.activeFocus(); } catch { /* 服务端也连不上，走本地补交 */ }
        if (state && sameToken(state.lastResult, snapshot.token)) {
          lastResult = { ...state.lastResult, ok: true };
          emit('finished');
          announce('focus:done', lastResult);
          return;
        }
        if (state && state.cancelledToken === snapshot.token) {
          lastResult = null;
          emit('cancel');
          announce('focus:cancelled', {});
          return;
        }
      }
      finishLocally(snapshot, natural, err, leftAtFinish);
    }
  } finally {
    finishing = false;
  }
}

// ---------------------------------------------------------------- 对外

export const focusStore = {
  init() {
    if (initialized) return;
    initialized = true;

    current = readJson(ACTIVE_KEY, null);
    if (current) {
      if (!current.token) current.token = makeToken();
      if (current.synced === undefined) current.synced = false;
      if (!current.pausedAt && remainingMs() <= 0) {
        // 页面关着的时候计时已经走完了：按计划结束时间补记一次
        finish({ natural: true });
      } else if (!current.pausedAt) {
        startTicker();
      }
    }
    if (outbox().length) flushOutbox();

    window.addEventListener('visibilitychange', () => {
      if (!document.hidden) pollActive();
      if (current && !current.pausedAt && remainingMs() <= 0) finish({ natural: true });
      else emit('tick');
    });
    window.addEventListener('focus', () => pollActive());
    window.addEventListener('storage', (e) => {
      if (e.key === ACTIVE_KEY) {
        const next = readJson(ACTIVE_KEY, null);
        if (!next) {
          if (current) {
            current = null;
            stopTicker();
            emit('cancel');
          }
        } else {
          current = next;
          if (current.pausedAt) stopTicker();
          else startTicker();
          emit('sync');
        }
      } else if (e.key === OUTBOX_KEY) {
        emit('tick');
      }
    });

    // 桌面浮窗可能在另一块表上操作；网页这边总要把结果接回来
    pollActive();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!document.hidden) pollActive();
    }, 2500);

    emit('init');
  },

  subscribe(fn) {
    listeners.add(fn);
    fn({
      type: 'init',
      current,
      remainingMs: remainingMs(),
      running: Boolean(current && !current.pausedAt),
      paused: Boolean(current && current.pausedAt),
      lastResult,
      pending: outbox().length,
    });
    return () => listeners.delete(fn);
  },

  get current() { return current; },
  get lastResult() { return lastResult; },
  get pending() { return outbox().length; },
  remainingMs,

  start(config) {
    if (current) throw new Error('已经有一轮专注在进行中了');
    const minutes = Math.max(1, Math.min(180, Math.round(Number(config.minutes) || 25)));
    const now = Date.now();
    current = {
      token: makeToken(),
      mode: config.mode === 'break' ? 'break' : 'focus',
      title: String(config.title || '').trim().slice(0, 160) || (config.mode === 'break' ? '休息' : '专注'),
      taskId: config.taskId || null,
      taskTitle: config.taskTitle || null,
      planId: config.planId || null,
      planTitle: config.planTitle || null,
      minutes,
      completeTask: Boolean(config.completeTask),
      startedAt: new Date(now).toISOString(),
      endAt: now + minutes * 60 * 1000,
      pausedAt: null,
      pausedRemainingMs: null,
      synced: false,
      pendingAction: null,
    };
    lastResult = null;
    persist();
    sleepAudio();
    startTicker();
    emit('start');
    announce('focus:started', { current });
    pushStart(current);
  },

  pause() {
    if (!current || current.pausedAt) return;
    current.pausedRemainingMs = remainingMs();
    current.pausedAt = new Date().toISOString();
    current.pendingAction = 'pause';
    persist();
    stopTicker();
    emit('pause');
    retryPendingAction();
  },

  resume() {
    if (!current || !current.pausedAt) return;
    const left = Math.max(1000, Number(current.pausedRemainingMs) || 0);
    current.endAt = Date.now() + left;
    current.pausedAt = null;
    current.pausedRemainingMs = null;
    current.pendingAction = 'resume';
    persist();
    startTicker();
    emit('resume');
    retryPendingAction();
  },

  finishEarly() {
    return finish({ natural: false });
  },

  cancel() {
    if (!current) return;
    const token = current.token;
    if (token) {
      const cancelled = readSet(CANCELLED_KEY);
      cancelled.add(token);
      writeSet(CANCELLED_KEY, cancelled);
    }
    current = null;
    persist();
    stopTicker();
    emit('cancel');
    announce('focus:cancelled', {});
    api.cancelActiveFocus()
      .then(() => {
        const cancelled = readSet(CANCELLED_KEY);
        cancelled.delete(token);
        writeSet(CANCELLED_KEY, cancelled);
      })
      .catch(() => { /* 下一轮轮询会重试；服务端也会留下取消标记 */ });
  },

  dismissResult() {
    if (lastResult && lastResult.session && lastResult.session.id) {
      const dismissed = readSet(DISMISSED_KEY);
      dismissed.add(lastResult.session.id);
      writeSet(DISMISSED_KEY, dismissed);
    }
    lastResult = null;
    emit('tick');
  },

  async undoSession(id) {
    const target = lastResult && lastResult.session && lastResult.session.id === id ? lastResult.session.id : id;
    const result = await api.undoFocusSession(target);
    if (lastResult && lastResult.session && lastResult.session.id === id) {
      lastResult = { ...lastResult, session: result.session, task: result.task, undone: true };
    }
    emit('undo');
    announce('focus:undone', result);
    return result;
  },
};

export { flushOutbox };
