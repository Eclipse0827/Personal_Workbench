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
import renderChat from './views/chat.js';
import renderFocus from './views/focus.js';
import renderTextbooks from './views/textbooks.js';
import renderTextbook from './views/textbook.js';
import renderArticles from './views/articles.js';
import renderArticle from './views/article.js';
import renderProjects from './views/projects.js';
import renderProjectDetail from './views/project-detail.js';
import renderSettings from './views/settings.js';

// ---------------------------------------------------------------- 图标

/** 侧栏图标：线稿，1.5px 描边，跟文字同色（currentColor） */
const ICON_PATHS = {
  dashboard: ['M3.5 3.5h6.5v6.5H3.5z', 'M14 3.5h6.5v6.5H14z', 'M3.5 14h6.5v6.5H3.5z', 'M14 14h6.5v6.5H14z'],
  tasks: ['M4 5h16v15H4z', 'M8 3v3.5', 'M16 3v3.5', 'M8 12l2.2 2.2L15.5 9.5'],
  focus: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 7.5V12l3 2'],
  chat: ['M4 5h16v10.5H9.5L4 19z', 'M8 9h8', 'M8 12.5h5'],
  projects: ['M3 7.5h5.5L10.5 10.5H21v9H3z', 'M3 7.5v-3.5h5l2 3'],
  textbooks: ['M5 3.5h8.5a3 3 0 0 1 3 3V21H8a3 3 0 0 1-3-3z', 'M16.5 8.5H19V21h-8'],
  articles: ['M5 4h14v16H5z', 'M8 8.5h8', 'M8 12.5h8', 'M8 16.5h5'],
  settings: ['M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z', 'M12 2.5V5', 'M12 19v2.5', 'M2.5 12H5', 'M19 12h2.5', 'M5.2 5.2L7 7', 'M17 17l1.8 1.8', 'M18.8 5.2L17 7', 'M7 17l-1.8 1.8'],
};

function navIcon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const paths = ICON_PATHS[name] || ICON_PATHS.dashboard;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of paths) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

// ---------------------------------------------------------------- 路由表

const ROUTES = [
  { pattern: /^\/$/, view: renderDashboard, nav: 'dashboard', title: '工作台' },
  { pattern: /^\/tasks$/, view: renderTasks, nav: 'tasks', title: '待办与计划' },
  { pattern: /^\/plan\/([^/]+)$/, view: renderPlanDetail, nav: 'tasks', title: '计划' },
  { pattern: /^\/focus$/, view: renderFocus, nav: 'focus', title: '专注' },
  { pattern: /^\/projects$/, view: renderProjects, nav: 'projects', title: '学习项目' },
  { pattern: /^\/projects\/([^/]+)$/, view: renderProjectDetail, nav: 'projects', title: '学习项目' },
  { pattern: /^\/textbooks$/, view: renderTextbooks, nav: 'textbooks', title: '教材精读' },
  { pattern: /^\/textbook\/([^/]+)$/, view: renderTextbook, nav: 'textbooks', title: '教材精读' },
  { pattern: /^\/articles$/, view: renderArticles, nav: 'articles', title: '外刊阅读' },
  { pattern: /^\/article\/([^/]+)$/, view: renderArticle, nav: 'articles', title: '外刊阅读' },
  { pattern: /^\/chat$/, view: renderChat, nav: 'chat', title: 'AI 整理空间', shell: 'chat', fixed: true },
  { pattern: /^\/chat\/([^/]+)$/, view: renderChat, nav: 'chat', title: 'AI 整理空间', shell: 'chat', fixed: true },
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
  /** 已挂载的「带壳页面」：同一个壳内换参数时只更新，不重建 DOM */
  mounted: null,

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
      document.body.classList.remove('reading-book', 'reading-article');
      viewRoot.classList.remove('view-fixed');
      this.mounted = null;
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

    // 同一个壳内换参数：保留页面自己的 DOM 与滚动位置，只更新内容
    if (found.route.shell && this.mounted && this.mounted.shell === found.route.shell && this.mounted.update) {
      try {
        await this.mounted.update(merged);
      } catch (err) {
        console.error(err);
        toastError(err);
      }
      this.closeSidebar();
      return;
    }

    // 打开一本书就进入沉浸阅读：隐藏全局侧栏，整屏留给这本书
    document.body.classList.toggle('reading-book', Boolean(found.route.view === renderTextbook));
    document.body.classList.toggle('reading-article', Boolean(found.route.view === renderArticle));
    viewRoot.classList.toggle('view-fixed', Boolean(found.route.fixed));

    if (this.cleanup) {
      try { this.cleanup(); } catch (err) { console.error('清理上一页失败', err); }
      this.cleanup = null;
    }
    this.mounted = null;

    if (keepScroll) this.scroller = viewRoot.scrollTop;
    clear(viewRoot);

    const ctx = {
      args: merged,
      navigate: (to) => this.navigate(to),
      rerender: (opts) => this.rerender(opts),
      refresh: () => refresh(),
    };

    try {
      const result = await found.route.view(viewRoot, ctx);
      if (typeof result === 'function') {
        this.cleanup = result;
      } else if (result && typeof result === 'object') {
        this.cleanup = typeof result.cleanup === 'function' ? result.cleanup : null;
        if (found.route.shell) {
          this.mounted = { shell: found.route.shell, update: result.update || null };
        }
      }
    } catch (err) {
      console.error(err);
      this.cleanup = null;
      this.mounted = null;
      viewRoot.replaceChildren(
        h('div.page', {}, [
          h('div.notice.alert', {}, [
            h('strong', {}, '这一页没能打开。'),
            h('div.small.mt1', {}, err.message || String(err)),
          ]),
          h('div.btn-row', {}, [
            h('button.btn.primary', { onclick: () => this.renderFromHash() }, '重试'),
            h('button.btn', { onclick: () => this.navigate('/') }, '回到工作台'),
          ]),
        ])
      );
    }

    // 重点：滚动的是容器，不是窗口。窗口永远不滚，页面才不会整屏乱跳。
    viewRoot.scrollTop = keepScroll ? this.scroller : 0;
    this.closeSidebar();
  },

  // ---------------------------------------------------------------- 导航

  paintNav() {
    const stats = state.stats || {};
    const pendingProposals = state.conversations.filter((c) => c.pendingProposals > 0).length;

    const items = [
      { group: '核心工作' },
      { id: 'dashboard', label: '概览', icon: 'dashboard', to: '/' },
      {
        id: 'tasks', label: '待办与计划', icon: 'tasks', to: '/tasks',
        badge: stats.open || null,
      },
      {
        id: 'focus', label: '专注番茄钟', icon: 'focus', to: '/focus',
        badge: stats.focusToday || null, quiet: !stats.focusToday,
      },
      {
        id: 'chat', label: 'AI 整理空间', icon: 'chat', to: '/chat',
        badge: pendingProposals || null,
      },
      { group: '学习工具' },
      {
        id: 'projects', label: '学习项目', icon: 'projects', to: '/projects',
        badge: stats.projects || null, quiet: !stats.projects,
      },
      {
        id: 'textbooks', label: '教材精读', icon: 'textbooks', to: '/textbooks',
        badge: stats.textbooks || null, quiet: true,
      },
      {
        id: 'articles', label: '外刊阅读', icon: 'articles', to: '/articles',
      },
    ];

    const nav = h('div.nav');
    for (const it of items) {
      if (it.group) {
        nav.appendChild(h('div.nav-group-title', {}, it.group));
        continue;
      }
      const active = this.current && this.current.nav === it.id;
      nav.appendChild(
        h(`button.nav-item${active ? '.active' : ''}`, {
          title: it.label,
          onclick: () => this.navigate(it.to),
        }, [
          h('span.nav-icon', {}, [navIcon(it.icon)]),
          h('span', {}, it.label),
          it.badge ? h(`span.nav-badge${it.quiet ? '.quiet' : ''}`, {}, String(it.badge)) : null,
        ])
      );
    }

    // 设置放在底部：PRD 规定的一级导航是五项，不在这里多加一项
    nav.appendChild(
      h('button.nav-item', { onclick: () => this.navigate('/settings') }, [
        h('span.nav-icon', {}, [navIcon('settings')]),
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
