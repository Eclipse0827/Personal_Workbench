/**
 * 应用外壳：路由、侧边导航、数据加载、全局状态处理。
 */

import { api } from './api.js';
import { h, clear, toast, toastError, emptyState, skeleton } from './ui.js';
import { state, set, refresh } from './state.js';
import { focusStore } from './focus-store.js';
import { mountFocusWidget } from './focus-widget.js';

import renderDashboard from './views/dashboard.js';
import renderTasks from './views/tasks.js';
import renderPlanDetail from './views/plan-detail.js';
import renderChatList from './views/chat-list.js';
import renderChat from './views/chat.js';
import renderArchive from './views/archive.js';
import renderArchiveDetail from './views/archive-detail.js';
import renderFocus from './views/focus.js';
import renderTextbooks from './views/textbooks.js';
import renderTextbook from './views/textbook.js';
import renderTools from './views/tools.js';
import renderSettings from './views/settings.js';

// ---------------------------------------------------------------- 路由表

const ROUTES = [
  { pattern: /^\/$/, view: renderDashboard, nav: 'dashboard', title: '工作台' },
  { pattern: /^\/tasks$/, view: renderTasks, nav: 'tasks', title: '待办与计划' },
  { pattern: /^\/plan\/([^/]+)$/, view: renderPlanDetail, nav: 'tasks', title: '计划' },
  { pattern: /^\/focus$/, view: renderFocus, nav: 'focus', title: '专注' },
  { pattern: /^\/textbooks$/, view: renderTextbooks, nav: 'textbooks', title: '教材精读' },
  { pattern: /^\/textbook\/([^/]+)$/, view: renderTextbook, nav: 'textbooks', title: '教材精读' },
  { pattern: /^\/chat$/, view: renderChatList, nav: 'chat', title: 'AI 整理空间' },
  { pattern: /^\/chat\/([^/]+)$/, view: renderChat, nav: 'chat', title: 'AI 整理空间' },
  { pattern: /^\/archive$/, view: renderArchive, nav: 'archive', title: '我的档案' },
  { pattern: /^\/archive\/([^/]+)$/, view: renderArchiveDetail, nav: 'archive', title: '档案' },
  { pattern: /^\/tools$/, view: renderTools, nav: 'tools', title: '我的工具' },
  { pattern: /^\/settings$/, view: renderSettings, nav: '', title: '设置' },
];

const ARG_NAMES = ['id', 'tab', 'filter'];

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart] = raw.split('?');
  const path = pathPart.startsWith('/') ? pathPart : `/${pathPart}`;
  const args = {};
  if (queryPart) for (const [k, v] of new URLSearchParams(queryPart)) args[k] = v;
  return { path, args };
}

function matchRoute(path) {
  for (const r of ROUTES) {
    const m = path.match(r.pattern);
    if (m) return { route: r, params: m.slice(1) };
  }
  return null;
}

// ---------------------------------------------------------------- 控制器

const app = {
  viewRoot: null,
  sidebar: null,
  scrim: null,
  current: null,
  scroller: 0,
  cleanup: null,

  /** 重新渲染当前视图 —— 写操作之后统一调用 */
  async rerender({ refreshData = true } = {}) {
    if (refreshData) {
      try { await refresh(); } catch (err) { console.error(err); }
    }
    if (this.current) await this.render(this.current.path, this.current.args, { keepScroll: true });
  },

  navigate(to) {
    const target = to.startsWith('#') ? to.slice(1) : to;
    if (location.hash.replace(/^#/, '') === target) this.renderFromHash();
    else location.hash = target;
  },

  /** 番茄钟结束后：数据要立刻同步，但不要打断正在输入 / 导入的页面 */
  async syncAfterFocus() {
    try { await refresh(); } catch (err) { console.error(err); }
    this.paintNav();
    const path = this.current && this.current.path;
    if (!path) return;
    const safe = path === '/' || path === '/tasks' || path === '/focus' || path.startsWith('/plan/');
    if (safe) await this.render(path, this.current.args, { keepScroll: true });
  },

  async renderFromHash() {
    const { path, args } = parseHash();
    await this.render(path, args);
  },

  async render(path, args, { keepScroll = false } = {}) {
    const found = matchRoute(path);
    const viewRoot = this.viewRoot;

    if (!found) {
      viewRoot.replaceChildren(
        h('div.page', {}, [
          emptyState({
            icon: '◌',
            title: '这个页面不存在',
            hint: '可能是链接写错了。',
            actionLabel: '回到工作台',
            onAction: () => this.navigate('/'),
          }),
        ])
      );
      return;
    }

    const merged = { ...args };
    found.params.forEach((v, i) => {
      if (v !== undefined && ARG_NAMES[i]) merged[ARG_NAMES[i]] = decodeURIComponent(v);
    });

    this.current = { path, args, nav: found.route.nav };
    this.paintNav();
    document.title = `${found.route.title} · 缓一缓`;

    if (this.cleanup) {
      try { this.cleanup(); } catch (err) { console.error('清理上一页失败', err); }
      this.cleanup = null;
    }

    if (keepScroll) this.scroller = window.scrollY;
    clear(viewRoot);

    const ctx = {
      args: merged,
      navigate: (to) => this.navigate(to),
      rerender: (opts) => this.rerender(opts),
      refresh: () => refresh(),
    };

    try {
      const result = await found.route.view(viewRoot, ctx);
      if (typeof result === 'function') this.cleanup = result;
    } catch (err) {
      console.error(err);
      this.cleanup = null;
      viewRoot.replaceChildren(
        h('div.page', {}, [
          h('div.notice.alert', {}, [
            h('strong', {}, '这一页没能打开。'),
            h('div.small.mt1', {}, err.message || String(err)),
          ]),
          h('div.btn-row', {}, [
            h('button.btn.primary', { onclick: () => this.renderFromHash() }, '重试'),
            h('button.btn.ghost', { onclick: () => this.navigate('/') }, '回到工作台'),
          ]),
        ])
      );
    }

    if (keepScroll) window.scrollTo({ top: this.scroller });
    else window.scrollTo({ top: 0 });
    this.closeSidebar();
  },

  // ---------------------------------------------------------------- 导航

  paintNav() {
    const stats = state.stats || {};
    const pendingProposals = state.conversations.filter((c) => c.pendingProposals > 0).length;

    const items = [
      { group: '核心工作' },
      { id: 'dashboard', label: '概览', icon: '▦', to: '/' },
      {
        id: 'tasks', label: '待办与计划', icon: '☑', to: '/tasks',
        badge: stats.open || null,
      },
      {
        id: 'focus', label: '专注番茄钟', icon: '◷', to: '/focus',
        badge: stats.focusToday || null, quiet: !stats.focusToday,
      },
      {
        id: 'textbooks', label: '教材精读', icon: '▤', to: '/textbooks',
        badge: stats.textbooks || null, quiet: true,
      },
      {
        id: 'chat', label: 'AI 整理空间', icon: '◔', to: '/chat',
        badge: pendingProposals || null,
      },
      { group: '我的' },
      { id: 'archive', label: '我的档案', icon: '▢', to: '/archive', badge: stats.archives || null, quiet: true },
      { id: 'tools', label: '我的工具', icon: '⚒', to: '/tools' },
    ];

    const nav = h('div.nav');
    for (const it of items) {
      if (it.group) {
        nav.appendChild(h('div.nav-group-title', {}, it.group));
        continue;
      }
      nav.appendChild(
        h(`button.nav-item${this.current && this.current.nav === it.id ? '.active' : ''}`, {
          onclick: () => this.navigate(it.to),
        }, [
          h('span.nav-icon', {}, it.icon),
          h('span', {}, it.label),
          it.badge ? h(`span.nav-badge${it.quiet ? '.quiet' : ''}`, {}, String(it.badge)) : null,
        ])
      );
    }

    // 设置放在底部：PRD 规定的一级导航是五项，不在这里多加一项
    nav.appendChild(
      h('button.nav-item', { onclick: () => this.navigate('/settings') }, [
        h('span.nav-icon', {}, '⚙'),
        h('span', {}, '设置与数据'),
      ])
    );

    const old = this.sidebar.querySelector('.nav');
    if (old) old.replaceWith(nav);
    else this.sidebar.appendChild(nav);

    // 侧栏底部：任务完成度（对应参考设计左下角的进度条）
    const foot = this.sidebar.querySelector('.sidebar-foot');
    if (foot) {
      const total = stats.total || 0;
      const doneCount = stats.done || 0;
      const pct = total ? Math.round((doneCount / total) * 1000) / 10 : 0;
      const ai = state.ai || {};
      const provider = (state.settings && state.settings.aiProvider) || 'mock';
      const engineText = provider === 'ollama'
        ? (ai.ollama && ai.ollama.online ? `Ollama · ${ai.ollama.selected || '模型'}` : 'Ollama 未连接')
        : provider === 'real'
          ? '远程模型'
          : '本地规则引擎';

      foot.replaceChildren(
        h('div.side-stat.side-progress', {}, [
          h('div.side-stat-row', {}, [
            h('span.side-stat-label', {}, '任务完成度'),
            h('span.side-stat-num', {}, total ? `${pct}%` : '—'),
          ]),
          h('div.progress', {}, [h('i', { style: { width: `${pct}%` } })]),
          h('div.side-stat-foot', {}, [total ? `${doneCount} / ${total}` : '还没有任务', ' · ', engineText]),
        ])
      );
    }
  },

  openSidebar() {
    this.sidebar.classList.add('open');
    if (!this.scrim) {
      this.scrim = h('div.scrim', { onclick: () => this.closeSidebar() });
      document.body.appendChild(this.scrim);
    }
  },

  closeSidebar() {
    this.sidebar.classList.remove('open');
    if (this.scrim) { this.scrim.remove(); this.scrim = null; }
  },

  // ---------------------------------------------------------------- 启动

  async boot() {
    const sidebar = document.getElementById('sidebar');
    const viewRoot = document.getElementById('view');
    const topbar = document.getElementById('topbar');
    this.sidebar = sidebar;
    this.viewRoot = viewRoot;

    sidebar.replaceChildren(
      h('div.brand', {}, [
        h('div.brand-mark', {}, '缓'),
        h('div', {}, [
          h('div.brand-name', {}, '缓一缓'),
          h('div.brand-sub', {}, '个人学术工作台'),
        ]),
      ]),
      h('div.nav'),
      h('div.sidebar-foot', {}, '')
    );

    topbar.replaceChildren(
      h('button.btn.ghost', { onclick: () => this.openSidebar(), 'aria-label': '打开导航' }, '☰'),
      h('div.brand-name', {}, '缓一缓')
    );

    viewRoot.replaceChildren(h('div.page', {}, [skeleton(3)]));

    // ---- 首屏加载：失败要有明确的恢复指引（PRD 2.1 要求有错误状态）
    try {
      await refresh();
    } catch (err) {
      set({ loading: false, error: err });
      viewRoot.replaceChildren(
        h('div.page', {}, [
          h('div.notice.alert', {}, [
            h('strong', {}, '连不上本地服务。'),
            h('div.small.mt1', {}, err.message || String(err)),
          ]),
          h('div.card', {}, [
            h('h3.mb1', {}, '怎么解决'),
            h('ol.small', {}, [
              h('li', {}, '确认那个命令行窗口还开着（运行 node server/server.js 的那个）。'),
              h('li', {}, '如果它已经关了，重新运行一次：node server/server.js'),
              h('li', {}, '然后刷新这个页面。'),
            ]),
          ]),
          h('div.btn-row', {}, [
            h('button.btn.primary', { onclick: () => location.reload() }, '刷新页面'),
          ]),
        ])
      );
      return;
    }

    // 番茄钟：迷你计时器先挂上，再恢复可能已经在后台走完的计时
    mountFocusWidget();
    window.addEventListener('focus:done', (e) => {
      const detail = e.detail || {};
      if (detail.offline) {
        toast('这一轮专注只记在了本机，等服务恢复后会自动补上。', 'warn');
      } else if (detail.session && detail.session.autoCompleted && detail.task) {
        toast(`专注完成，已勾选「${detail.task.title}」。`);
      } else if (detail.session && detail.session.mode === 'break') {
        toast('休息结束。');
      } else {
        toast('这一轮专注已经记下来了。');
      }
      this.syncAfterFocus();
    });
    window.addEventListener('focus:undone', () => this.syncAfterFocus());
    window.addEventListener('focus:conflict', () => {
      toast('另一个窗口里已经有一轮专注在进行，已经同步过来。', 'warn');
      this.syncAfterFocus();
    });
    window.addEventListener('focus:synced', () => {
      toast('刚才的专注记录已经补上了。');
      this.syncAfterFocus();
    });
    focusStore.init();

    window.addEventListener('hashchange', () => this.renderFromHash());
    await this.renderFromHash();
  },
};

// 未捕获的异常不要静默吞掉，但也不能让界面白掉
window.addEventListener('unhandledrejection', (e) => {
  console.error('未处理的错误', e.reason);
  if (e.reason && e.reason.message) toastError(e.reason);
});

app.boot();

export { app };
