'use strict';

/**
 * 桌面版主进程（Electron）
 * ---------------------------------------------------------------
 * 这个项目的页面全是相对 /api/*，必须有同源的 Node 服务才能跑，
 * 所以桌面壳不是「把网页塞进窗口」，而是：
 *   1. 以 ELECTRON_RUN_AS_NODE 模式用同一个 Electron 二进制拉起 server/server.js；
 *   2. 只监听 127.0.0.1 + 随机端口，不暴露到局域网；
 *   3. 数据目录指到 app.getPath('userData')/data —— 与网页版、手机版完全独立；
 *   4. 窗口加载这个本地地址，退出时把服务子进程一起收掉。
 *
 * 现在只是可运行的壳；真正出安装包（electron-builder）需要单独装依赖并执行，
 * 不会在启动或自测时自动发生。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');

const floatWindow = require('./float-window');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'server.js');

app.setName('huan-yihuan-desktop');

/** 受限环境下默认 userData 可能不可写，逐个探测可写目录（沿用浮窗的做法） */
function pickUserData() {
  const candidates = [
    app.getPath('userData'),
    path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'huan-yihuan-desktop'),
    path.join(os.tmpdir(), 'huan-yihuan-desktop'),
  ];
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.write-probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return dir;
    } catch { /* 换下一个 */ }
  }
  return app.getPath('userData');
}

const USER_DATA = pickUserData();
app.setPath('userData', USER_DATA);
const DATA_DIR = path.join(USER_DATA, 'data');

/**
 * 打包之后要能自己验一遍「装出来的东西真的跑得起来」，所以留两个只在
 * 自动化里用的后门（普通双击运行时完全不生效）：
 *   WB_DESKTOP_URL_FILE  把本地服务地址写进这个文件
 *   WB_DESKTOP_SMOKE=1   不开窗，服务起来就算成功，3 秒后自动退出
 */
const URL_FILE = String(process.env.WB_DESKTOP_URL_FILE || '').trim();
const SMOKE = process.env.WB_DESKTOP_SMOKE === '1';
const SMOKE_MS = Number(process.env.WB_DESKTOP_SMOKE_MS || 3000);

let win = null;
let serverProc = null;

/**
 * 浮窗控制通道
 * ---------------------------------------------------------------
 * 页面点「浮到桌面」→ 服务端 POST /api/float/launch → 服务端再打到下面这个小
 * HTTP 服务 → 由这里（主进程）开第二个 BrowserWindow。
 *
 * 为什么要绕这一圈：浮窗必须活在这个 Electron 进程里。打包后的目录没有
 * node_modules/electron，spawn 自己的 exe 也只会再开一个主窗口。走进程内，
 * 用户不需要额外安装任何东西。
 *
 * 端口随机、只监听 127.0.0.1、带一次性令牌，服务端进程拿不到令牌就打不进来。
 */
const SHELL_TOKEN = crypto.randomBytes(18).toString('hex');
let shellServer = null;
let shellPort = 0;
let serverBase = '';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 主窗口关了但浮窗还开着时，点桌面图标应该把主窗口叫回来，而不是毫无反应
    if (!win && serverBase) {
      createMainWindow(serverBase);
      return;
    }
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(main).catch((err) => {
    dialog.showErrorBox('缓一缓启动失败', String((err && err.message) || err));
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    stopServer();
    stopShell();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/bootstrap`, { timeout: 700 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitHealthy(port, child, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error('本地服务进程提前退出了');
    if (await ping(port)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('等本地服务启动超时');
}

/** 浮窗要用的两个动作：把浮窗叫出来、关掉浮窗。只接受带令牌的本机请求。 */
function floatHooks() {
  return {
    // 浮窗里的「打开网页版」：直接把已经开着的主窗口切到专注页，
    // 不再去拉起系统浏览器 —— 用户用的就是这个 App。
    openApp: () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.executeJavaScript("location.hash = '#/focus'").catch(() => {});
    },
    // 浮窗里的「关闭」只关浮窗本身，主窗口继续留着
    closeApp: () => floatWindow.destroy(),
  };
}

function startShell() {
  return new Promise((resolve, reject) => {
    shellServer = http.createServer((req, res) => {
      const reply = (code, body) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(body));
      };
      if (req.headers['x-wb-shell'] !== SHELL_TOKEN) return reply(401, { ok: false });

      let pathname = '/';
      try {
        pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      } catch { /* 保持 / */ }

      if (pathname === '/ping') {
        return reply(200, { ok: true, electron: process.versions.electron });
      }
      if (pathname === '/float/open') {
        try {
          const result = floatWindow.open(serverBase, { hooks: floatHooks() });
          console.log(`[浮窗] ${result.opened ? '已新开窗口' : '叫回已有窗口'}`);
          return reply(200, { ok: true, ...result });
        } catch (err) {
          console.error('[浮窗] 开窗失败：', err.message);
          return reply(500, { ok: false, message: String((err && err.message) || err) });
        }
      }
      if (pathname === '/float/close') {
        floatWindow.destroy();
        return reply(200, { ok: true });
      }
      return reply(404, { ok: false });
    });

    shellServer.once('error', reject);
    shellServer.listen(0, '127.0.0.1', () => {
      shellPort = shellServer.address().port;
      resolve(shellPort);
    });
  });
}

function stopShell() {
  if (shellServer) {
    try { shellServer.close(); } catch { /* 已经关了 */ }
  }
  shellServer = null;
}

async function startServer() {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--host', '127.0.0.1'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      WB_DATA_DIR: DATA_DIR,
      WB_PLATFORM: 'desktop',
      // 告诉服务端「你在桌面壳里」：浮窗由壳自己开，别再去找 node_modules/electron
      WB_DESKTOP_SHELL: '1',
      WB_DESKTOP_SHELL_URL: `http://127.0.0.1:${shellPort}`,
      WB_DESKTOP_SHELL_TOKEN: SHELL_TOKEN,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  serverProc = child;
  child.stderr.on('data', (d) => process.stderr.write(String(d)));
  await waitHealthy(port, child);
  return `http://127.0.0.1:${port}`;
}

function stopServer() {
  if (serverProc && serverProc.exitCode === null && !serverProc.killed) {
    try { serverProc.kill(); } catch { /* 已经退了 */ }
  }
  serverProc = null;
}

async function main() {
  Menu.setApplicationMenu(null);

  // 浮窗的 IPC 必须在开窗口之前绑定好，页面一加载就会 invoke
  floatWindow.registerIpc();

  let base;
  try {
    await startShell();
    base = await startServer();
    serverBase = base;
  } catch (err) {
    dialog.showErrorBox(
      '缓一缓启动失败',
      `${String((err && err.message) || err)}\n\n可以先在浏览器里用 npm start 确认服务是否正常。`
    );
    app.quit();
    return;
  }

  if (URL_FILE) {
    try { fs.writeFileSync(URL_FILE, base, 'utf8'); } catch { /* 只是给自动化看的 */ }
  }

  // 冒烟模式：只验证「解包出来的这份代码能把本地服务拉起来」，不弹主窗口。
  // 停留时长可以调：冒烟脚本要在这个窗口里顺手验一下浮窗通道。
  if (SMOKE) {
    console.log(`[smoke] server ready at ${base}`);
    console.log(`[smoke] data dir ${DATA_DIR}`);
    console.log(`[smoke] shell channel 127.0.0.1:${shellPort}`);
    setTimeout(() => { stopServer(); stopShell(); app.exit(0); }, SMOKE_MS);
    return;
  }

  createMainWindow(base);
}

/** 主窗口。单独拆出来，是因为浮窗开着的时候主窗口可能被关掉，还要能再叫回来。 */
function createMainWindow(base) {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return win;
  }

  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    title: '缓一缓 · 个人学术工作台',
    backgroundColor: '#f7f3ec',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(base);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => { win = null; });
  return win;
}
