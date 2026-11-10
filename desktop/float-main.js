/**
 * 独立浮窗进程的入口（只在「网页版 + 本机装了 Electron」这条路上用）。
 *
 * 桌面 App 里不再走这里：那边由 desktop/main.js 在同一个进程里直接开第二个窗口，
 * 不需要 node_modules/electron，也不需要再起一个 exe。
 *
 * 所以这个文件只负责三件壳级别的事——定数据目录、抢单实例锁、把窗口交出去；
 * 窗口本身的全部行为都在 desktop/float-window.js 里，和桌面 App 共用一份。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, Menu } = require('electron');

const floatWindow = require('./float-window');

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
  app.on('second-instance', () => floatWindow.focus());
  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(() => {
    app.setAppUserModelId('com.huanyihuan.float');
    Menu.setApplicationMenu(null);
    floatWindow.registerIpc();
    floatWindow.open(BASE_URL, {
      // 独立进程里，「关闭浮窗」就等于结束这个进程
      hooks: { closeApp: () => app.quit() },
    });
  });
}
