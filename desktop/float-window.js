'use strict';

/**
 * 桌面浮窗（可被复用的窗口模块）
 * ---------------------------------------------------------------
 * 以前浮窗是一个**独立的 Electron 进程**（desktop/float-main.js），
 * 由服务端 spawn 出去。那套在网页版里没问题，但装成桌面 App 之后就崩了：
 * 打包后的目录里没有 node_modules/electron，spawn 自己又只会再开一个主窗口。
 *
 * 现在拆成两用：
 *   · 桌面壳内（desktop/main.js）——直接 require 这个模块，在同一个进程里
 *     开第二个 BrowserWindow。一个 Electron、一份内存，不需要装任何东西。
 *   · 网页版（desktop/float-main.js）——仍然可以独立起一个进程，入口极薄。
 *
 * 窗口行为（透明、无边框、置顶、收起成小球、吸边、位置记忆）全部留在这里，
 * 两个入口共用同一份实现，不会各自漂移。
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');

const BALL_SIZE = 112;
const BALL_MARGIN = 10;

let win = null;
let baseUrl = 'http://127.0.0.1:5180';
let pinned = true;
let snapEnabled = false;
let collapsed = false;
let expandedBounds = null;
let dragOffset = null;
let ipcBound = false;

/**
 * 两个入口的差异只有这两处，其余全部共用：
 *   openApp  点「打开网页版」——桌面壳里聚焦主窗口，网页版里交给系统浏览器
 *   closeApp 点关闭——桌面壳里只关这个窗口，网页版里关掉整个浮窗进程
 */
let hooks = { openApp: null, closeApp: null };

// ---------------------------------------------------------------- 状态文件

function stateFile(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  try {
    fs.writeFileSync(file, JSON.stringify(value));
  } catch { /* 记不住位置不影响使用 */ }
}

function loadPrefs() {
  const p = readJson(stateFile('float-prefs.json'));
  snapEnabled = Boolean(p && p.snapEnabled);
}

function savePrefs() {
  writeJson(stateFile('float-prefs.json'), { snapEnabled });
}

function loadBounds() {
  const b = readJson(stateFile('float-bounds.json'));
  if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return null;
  const area = screen.getDisplayMatching({
    x: b.x || 0, y: b.y || 0, width: b.width, height: b.height,
  }).workArea;
  const visible = b.x < area.x + area.width - 80
    && b.x + b.width > area.x + 80
    && b.y < area.y + area.height - 60
    && b.y + b.height > area.y;
  return visible ? b : null;
}

function saveBounds() {
  if (!win || win.isDestroyed() || collapsed) return;
  writeJson(stateFile('float-bounds.json'), win.getBounds());
}

function loadBallPosition() {
  const b = readJson(stateFile('float-ball.json'));
  if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
  return clampBall(b.x, b.y);
}

function saveBallPosition() {
  if (!win || win.isDestroyed() || !collapsed) return;
  const [x, y] = win.getPosition();
  writeJson(stateFile('float-ball.json'), { x, y });
}

// ---------------------------------------------------------------- 几何计算

function clampBall(x, y) {
  const b = { x: Math.round(x), y: Math.round(y), width: BALL_SIZE, height: BALL_SIZE };
  const area = screen.getDisplayMatching(b).workArea;
  return {
    x: Math.max(area.x, Math.min(area.x + area.width - BALL_SIZE, b.x)),
    y: Math.max(area.y, Math.min(area.y + area.height - BALL_SIZE, b.y)),
  };
}

/** 吸边：按小球中心落在屏幕哪半边，贴到左或右，纵向保持当前位置 */
function snapPosition(bounds) {
  const area = screen.getDisplayMatching(bounds).workArea;
  const centerX = bounds.x + bounds.width / 2;
  const right = centerX >= area.x + area.width / 2;
  const x = right
    ? area.x + area.width - BALL_SIZE - BALL_MARGIN
    : area.x + BALL_MARGIN;
  const y = Math.max(
    area.y + BALL_MARGIN,
    Math.min(
      area.y + area.height - BALL_SIZE - BALL_MARGIN,
      Math.round(bounds.y + bounds.height / 2 - BALL_SIZE / 2),
    ),
  );
  return { x, y };
}

function defaultBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = 360;
  const height = 500;
  return {
    width,
    height,
    x: area.x + area.width - width - 24,
    y: area.y + Math.max(24, Math.round((area.height - height) / 2)),
  };
}

function positionWithinDisplay(b) {
  const area = screen.getDisplayMatching(b).workArea;
  const width = Math.max(300, Math.min(640, Math.round(b.width)));
  const height = Math.max(240, Math.min(760, Math.round(b.height)));
  return {
    width,
    height,
    x: Math.max(area.x, Math.min(area.x + area.width - width, Math.round(b.x))),
    y: Math.max(area.y, Math.min(area.y + area.height - height, Math.round(b.y))),
  };
}

function collapseToBall() {
  if (!win || win.isDestroyed() || collapsed) return state();
  expandedBounds = win.getBounds();
  saveBounds();

  const pos = snapPosition(expandedBounds);
  collapsed = true;
  win.setMinimumSize(80, 80);
  win.setBounds({ x: pos.x, y: pos.y, width: BALL_SIZE, height: BALL_SIZE }, false);
  win.setResizable(false);
  saveBallPosition();
  return state();
}

function expandWindow() {
  if (!win || win.isDestroyed()) return state();
  if (!collapsed) {
    if (!win.isVisible()) win.show();
    win.focus();
    return state();
  }

  const target = positionWithinDisplay(expandedBounds || defaultBounds());
  collapsed = false;
  win.setResizable(true);
  win.setMinimumSize(300, 240);
  win.setBounds(target, false);
  win.show();
  win.focus();
  return state();
}

function endBallDrag() {
  dragOffset = null;
  if (!win || win.isDestroyed() || !collapsed) return;
  if (snapEnabled) {
    const pos = snapPosition(win.getBounds());
    win.setBounds({ x: pos.x, y: pos.y, width: BALL_SIZE, height: BALL_SIZE }, false);
  }
  saveBallPosition();
}

function state() {
  return { pinned, snapEnabled, collapsed };
}

function broadcastState() {
  if (!win || win.isDestroyed() || win.webContents.isLoading()) return;
  win.webContents.send('float:state', state());
}

// ---------------------------------------------------------------- 开窗

function createWindow() {
  if (win && !win.isDestroyed()) return win;

  loadPrefs();

  const saved = loadBounds();
  expandedBounds = saved || defaultBounds();
  collapsed = snapEnabled;

  let width;
  let height;
  let x;
  let y;
  if (collapsed) {
    const ball = loadBallPosition() || snapPosition(expandedBounds);
    width = BALL_SIZE;
    height = BALL_SIZE;
    x = ball.x;
    y = ball.y;
  } else {
    width = expandedBounds.width;
    height = expandedBounds.height;
    x = expandedBounds.x;
    y = expandedBounds.y;
  }

  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    minWidth: collapsed ? 80 : 300,
    minHeight: collapsed ? 80 : 240,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: !collapsed,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: '缓一缓 · 浮窗',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  try {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch { /* Windows 上不一定实现，不影响置顶 */ }

  win.loadURL(`${baseUrl}/float.html`);
  win.webContents.on('did-finish-load', () => {
    console.log('[浮窗] 页面已加载');
  });
  win.webContents.on('did-fail-load', (_e, code, desc, failedUrl) => {
    console.error(`[浮窗] 页面加载失败 ${code} ${desc} ${failedUrl}`);
  });
  win.once('ready-to-show', () => {
    win.show();
    win.setAlwaysOnTop(pinned, 'floating');
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(baseUrl)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(baseUrl)) e.preventDefault();
  });

  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (collapsed) saveBallPosition();
      else saveBounds();
    }, 400);
  };
  win.on('move', scheduleSave);
  win.on('resize', scheduleSave);
  win.on('close', () => {
    if (collapsed) saveBallPosition();
    else saveBounds();
  });
  win.on('closed', () => { win = null; });

  return win;
}

/**
 * 打开（或叫回）浮窗。已经开着就只把它拎到前面，不会开出第二个。
 * 返回 { opened, focused } 给调用方判断是「新开的」还是「叫回来的」。
 */
function open(base, options) {
  if (base) baseUrl = String(base).replace(/\/+$/, '');
  if (options && options.hooks) hooks = { ...hooks, ...options.hooks };

  if (win && !win.isDestroyed()) {
    if (collapsed) expandWindow();
    else {
      if (!win.isVisible()) win.show();
      win.focus();
    }
    broadcastState();
    return { opened: false, focused: true };
  }

  createWindow();
  return { opened: true, focused: true };
}

function isOpen() {
  return Boolean(win && !win.isDestroyed());
}

function focus() {
  if (!isOpen()) return false;
  if (collapsed) expandWindow();
  if (!win.isVisible()) win.show();
  win.focus();
  broadcastState();
  return true;
}

function destroy() {
  if (win && !win.isDestroyed()) win.close();
  win = null;
}

// ---------------------------------------------------------------- IPC

/** 只绑定一次；两个入口都可能调用，重复绑定会报错 */
function registerIpc() {
  if (ipcBound) return;
  ipcBound = true;

  ipcMain.handle('float:info', () => state());

  ipcMain.handle('float:toggle-pin', () => {
    pinned = !pinned;
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(pinned, 'floating');
    return state();
  });

  ipcMain.handle('float:set-snap', (_e, enabled) => {
    snapEnabled = Boolean(enabled);
    savePrefs();
    if (snapEnabled) collapseToBall();
    else if (collapsed) expandWindow();
    return state();
  });

  ipcMain.handle('float:expand', () => {
    expandWindow();
    return state();
  });

  ipcMain.on('float:close', () => {
    if (typeof hooks.closeApp === 'function') hooks.closeApp();
    else destroy();
  });

  ipcMain.on('float:open-app', () => {
    if (typeof hooks.openApp === 'function') hooks.openApp();
    else shell.openExternal(`${baseUrl}/#/focus`);
  });

  ipcMain.on('float:resize', (_e, height) => {
    if (!win || win.isDestroyed() || collapsed) return;
    const h = Math.round(Number(height));
    if (!Number.isFinite(h)) return;
    const [w] = win.getSize();
    win.setSize(w, Math.max(240, Math.min(760, h)), true);
  });

  ipcMain.on('float:drag-start', (_e, x, y) => {
    if (!win || win.isDestroyed() || !collapsed) return;
    const sx = Number(x);
    const sy = Number(y);
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;
    const [wx, wy] = win.getPosition();
    dragOffset = { dx: sx - wx, dy: sy - wy };
  });

  ipcMain.on('float:drag-move', (_e, x, y) => {
    if (!win || win.isDestroyed() || !collapsed || !dragOffset) return;
    const sx = Number(x);
    const sy = Number(y);
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) return;
    win.setPosition(Math.round(sx - dragOffset.dx), Math.round(sy - dragOffset.dy));
  });

  ipcMain.on('float:drag-end', () => {
    endBallDrag();
  });
}

module.exports = {
  open,
  close: destroy,
  destroy,
  isOpen,
  focus,
  registerIpc,
  BALL_SIZE,
};
