/**
 * 桌面浮窗外壳。
 *
 * 它只做四件事：开一个透明、无边框、置顶的小窗口；加载 /float.html；
 * 把「收起 / 关闭 / 打开网页版 / 置顶」几个窗口级操作转给页面；
 * 记住窗口位置。业务数据全部走本地服务，浮窗和网页看到的是同一份。
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

function boundsFile() {
  return path.join(app.getPath('userData'), 'float-bounds.json');
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
  if (!win || win.isDestroyed()) return;
  try {
    fs.writeFileSync(boundsFile(), JSON.stringify(win.getBounds()));
  } catch { /* 记不住位置不影响使用 */ }
}

function main() {
  app.setAppUserModelId('com.huanyihuan.float');
  Menu.setApplicationMenu(null);

  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    const saved = loadBounds();
    const area = screen.getPrimaryDisplay().workArea;
    const width = saved ? saved.width : 360;
    const height = saved ? saved.height : 500;
    const x = saved ? saved.x : area.x + area.width - width - 24;
    const y = saved ? saved.y : area.y + Math.max(24, Math.round((area.height - height) / 2));

    win = new BrowserWindow({
      width,
      height,
      x,
      y,
      minWidth: 300,
      minHeight: 240,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: true,
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
      saveTimer = setTimeout(saveBounds, 400);
    };
    win.on('move', scheduleSave);
    win.on('resize', scheduleSave);
    win.on('close', saveBounds);
    win.on('closed', () => { win = null; });
  });

  app.on('window-all-closed', () => app.quit());
}

ipcMain.handle('float:info', () => ({ pinned }));

ipcMain.handle('float:toggle-pin', () => {
  pinned = !pinned;
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(pinned, 'floating');
  return { pinned };
});

ipcMain.on('float:close', () => app.quit());

ipcMain.on('float:open-app', () => {
  shell.openExternal(`${BASE_URL}/#/focus`);
});

ipcMain.on('float:resize', (_e, height) => {
  if (!win || win.isDestroyed()) return;
  const h = Math.round(Number(height));
  if (!Number.isFinite(h)) return;
  const [w] = win.getSize();
  win.setSize(w, Math.max(240, Math.min(760, h)), true);
});
