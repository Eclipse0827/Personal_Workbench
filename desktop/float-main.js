/**
 * 桌面浮窗外壳。
 *
 * 它只做几件事：开一个透明、无边框、置顶的小窗口；加载 /float.html；
 * 把「收起 / 关闭 / 打开网页版 / 置顶 / 吸边」几个窗口级操作转给页面；
 * 记住窗口位置和吸边偏好。业务数据全部走本地服务，浮窗和网页看到的是同一份。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, screen, Menu } = require('electron');

const URL_ARG = process.argv.find((a) => a.startsWith('--url='));
const BASE_URL = URL_ARG ? URL_ARG.slice('--url='.length).replace(/\/+$/, '') : 'http://127.0.0.1:5180';

// 必须在拿单实例锁之前把数据目录定下来：锁文件和 GPU 缓存都写在 userData 里。
// 默认的 %APPDATA%\Electron 在受限环境里可能不可写，会导致窗口静默退出，
// 所以优先用项目内的 data 目录，再退回用户目录。
app.setName('huan-yihuan-float');
function pickUserData() {
  const candidates = [
    path.join(__dirname, '..', 'data', '.float-runtime'),
    path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'huan-yihuan-float'),
    path.join(os.tmpdir(), 'huan-yihuan-float'),
  ];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return dir;
    } catch { /* 换下一个可写目录 */ }
  }
  return null;
}
const userDataDir = pickUserData();
if (userDataDir) app.setPath('userData', userDataDir);

// 同一时间只留一个浮窗；重复点「浮到桌面」就把已有的窗口叫回来
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

let win = null;
let pinned = true;
let snapEnabled = false;
let collapsed = false;
let expandedBounds = null;
let dragOffset = null;

const BALL_SIZE = 112;
const BALL_MARGIN = 10;

function boundsFile() {
  return path.join(app.getPath('userData'), 'float-bounds.json');
}

function ballFile() {
  return path.join(app.getPath('userData'), 'float-ball.json');
}

function prefsFile() {
  return path.join(app.getPath('userData'), 'float-prefs.json');
}

function loadPrefs() {
  try {
    const p = JSON.parse(fs.readFileSync(prefsFile(), 'utf8'));
    snapEnabled = Boolean(p && p.snapEnabled);
  } catch {
    snapEnabled = false;
  }
}

function savePrefs() {
  try {
    fs.writeFileSync(prefsFile(), JSON.stringify({ snapEnabled }));
  } catch { /* 记不住偏好不影响使用 */ }
}

function loadBounds() {
  try {
    const b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return null;
    const area = screen.getDisplayMatching({
      x: b.x || 0, y: b.y || 0, width: b.width, height: b.height,
    }).workArea;
    const visible = b.x < area.x + area.width - 80
      && b.x + b.width > area.x + 80
      && b.y < area.y + area.height - 60
      && b.y + b.height > area.y;
    return visible ? b : null;
  } catch {
    return null;
  }
}

function saveBounds() {
  if (!win || win.isDestroyed() || collapsed) return;
  try {
    fs.writeFileSync(boundsFile(), JSON.stringify(win.getBounds()));
  } catch { /* 记不住位置不影响使用 */ }
}

function loadBallPosition() {
  try {
    const b = JSON.parse(fs.readFileSync(ballFile(), 'utf8'));
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
    return clampBall(b.x, b.y);
  } catch {
    return null;
  }
}

function saveBallPosition() {
  if (!win || win.isDestroyed() || !collapsed) return;
  try {
    const [x, y] = win.getPosition();
    fs.writeFileSync(ballFile(), JSON.stringify({ x, y }));
  } catch { /* 记不住位置不影响使用 */ }
}

function clampBall(x, y) {
  const b = { x: Math.round(x), y: Math.round(y), width: BALL_SIZE, height: BALL_SIZE };
  const area = screen.getDisplayMatching(b).workArea;
  return {
    x: Math.max(area.x, Math.min(area.x + area.width - BALL_SIZE, b.x)),
    y: Math.max(area.y, Math.min(area.y + area.height - BALL_SIZE, b.y)),
  };
}

// 吸边：按小球中心落在屏幕哪半边，贴到左或右，纵向保持当前位置。
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

function collapseToBall() {
  if (!win || win.isDestroyed()) return { collapsed, snapEnabled };
  if (collapsed) return { collapsed, snapEnabled };

  expandedBounds = win.getBounds();
  saveBounds();

  const pos = snapPosition(expandedBounds);
  collapsed = true;
  win.setMinimumSize(80, 80);
  win.setBounds({ x: pos.x, y: pos.y, width: BALL_SIZE, height: BALL_SIZE }, false);
  win.setResizable(false);
  saveBallPosition();
  return { collapsed, snapEnabled };
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

function expandWindow() {
  if (!win || win.isDestroyed()) return { collapsed, snapEnabled };
  if (!collapsed) {
    if (!win.isVisible()) win.show();
    win.focus();
    return { collapsed, snapEnabled };
  }

  const target = positionWithinDisplay(expandedBounds || defaultBounds());
  collapsed = false;
  win.setResizable(true);
  win.setMinimumSize(300, 240);
  win.setBounds(target, false);
  win.show();
  win.focus();
  return { collapsed, snapEnabled };
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

function broadcastState() {
  if (!win || win.isDestroyed() || win.webContents.isLoading()) return;
  win.webContents.send('float:state', { pinned, snapEnabled, collapsed });
}

function main() {
  app.setAppUserModelId('com.huanyihuan.float');
  Menu.setApplicationMenu(null);

  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (collapsed) expandWindow();
    if (!win.isVisible()) win.show();
    win.focus();
    broadcastState();
  });

  app.whenReady().then(() => {
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
    win.loadURL(`${BASE_URL}/float.html`);
    win.once('ready-to-show', () => {
      win.show();
      win.setAlwaysOnTop(pinned, 'floating');
    });

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith(`${BASE_URL}/`)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, target) => {
      if (!target.startsWith(BASE_URL)) e.preventDefault();
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
  });

  app.on('window-all-closed', () => app.quit());
}

ipcMain.handle('float:info', () => ({ pinned, snapEnabled, collapsed }));

ipcMain.handle('float:toggle-pin', () => {
  pinned = !pinned;
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(pinned, 'floating');
  return { pinned, snapEnabled, collapsed };
});

ipcMain.handle('float:set-snap', (_e, enabled) => {
  snapEnabled = Boolean(enabled);
  savePrefs();
  if (snapEnabled) {
    collapseToBall();
  } else if (collapsed) {
    expandWindow();
  }
  return { pinned, snapEnabled, collapsed };
});

ipcMain.handle('float:expand', () => {
  expandWindow();
  return { pinned, snapEnabled, collapsed };
});

ipcMain.on('float:close', () => app.quit());

ipcMain.on('float:open-app', () => {
  shell.openExternal(`${BASE_URL}/#/focus`);
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
