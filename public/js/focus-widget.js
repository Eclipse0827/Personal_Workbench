/**
 * 停留在页面右下角的迷你计时器。
 * 切到别的页面也看得见，不必为了看倒计时一直留在专注页。
 */

import { h, toast, toastError } from './ui.js';
import { focusStore, formatClock } from './focus-store.js';

let dock = null;
let unsubscribe = null;
let hideTimer = null;
let mounted = false;

function isFocusPage() {
  return (location.hash.replace(/^#/, '') || '/').startsWith('/focus');
}

function mount() {
  if (!dock) {
    dock = h('div#focus-dock.focus-dock.hidden', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(dock);
  }
  return dock;
}

function render(snap) {
  if (!dock) return;
  if (isFocusPage()) {
    dock.classList.add('hidden');
    return;
  }

  if (snap.current) {
    clearTimeout(hideTimer);
    const cur = snap.current;
    const paused = Boolean(cur.pausedAt);
    dock.replaceChildren(
      h(`button.focus-dock-main${paused ? '.paused' : ''}`, {
        type: 'button',
        title: '打开专注页',
        onclick: () => { location.hash = '/focus'; },
      }, [
        h('span.focus-dock-dot'),
        h('span.focus-dock-info', {}, [
          h('span.focus-dock-time', {}, formatClock(snap.remainingMs)),
          h('span.focus-dock-title', {}, `${paused ? '已暂停 · ' : ''}${cur.title}`),
        ]),
      ]),
      h('button.focus-dock-btn', {
        type: 'button',
        title: paused ? '继续' : '暂停',
        onclick: (e) => {
          e.stopPropagation();
          if (paused) focusStore.resume();
          else focusStore.pause();
        },
      }, paused ? '▶' : '❙❙')
    );
    dock.classList.remove('hidden');
    return;
  }

  const res = snap.lastResult;
  if (!res) {
    dock.classList.add('hidden');
    return;
  }

  const failed = res.ok === false;
  const session = res.session;
  const canUndo = Boolean(session && session.autoCompleted && !session.undoneAt && res.task && res.task.status === 'done');
  const parts = [
    h(`button.focus-dock-main${failed ? '.failed' : '.done'}`, {
      type: 'button',
      title: '打开专注页',
      onclick: () => { location.hash = '/focus'; },
    }, [
      h('span.focus-dock-dot'),
      h('span.focus-dock-info', {}, [
        h('span.focus-dock-time', {}, failed ? '待同步' : '已完成'),
        h('span.focus-dock-title', {}, session
          ? (res.task && session.autoCompleted ? `已勾选：${res.task.title}` : session.title)
          : (res.error || '这一轮已记录')),
      ]),
    ]),
  ];
  if (canUndo) {
    parts.push(h('button.focus-dock-btn', {
      type: 'button',
      title: '撤销自动勾选',
      onclick: async (e) => {
        e.stopPropagation();
        try {
          await focusStore.undoSession(session.id);
          toast('已撤销勾选。');
        } catch (err) { toastError(err); }
      },
    }, '↺'));
  }
  dock.replaceChildren(...parts);
  dock.classList.remove('hidden');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { if (!focusStore.current) dock.classList.add('hidden'); }, 22000);
}

export function mountFocusWidget() {
  if (mounted) return;
  mounted = true;
  mount();
  unsubscribe = focusStore.subscribe(render);
  window.addEventListener('hashchange', () => render({
    current: focusStore.current,
    remainingMs: focusStore.remainingMs(),
    lastResult: focusStore.lastResult,
  }));
  window.addEventListener('focus:done', () => render({
    current: null,
    remainingMs: 0,
    lastResult: focusStore.lastResult,
  }));
  window.addEventListener('focus:synced', () => render({
    current: focusStore.current,
    remainingMs: focusStore.remainingMs(),
    lastResult: focusStore.lastResult,
  }));
}
