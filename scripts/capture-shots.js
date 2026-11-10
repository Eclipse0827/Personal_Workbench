'use strict';

/**
 * 给提交文档配图：用 Electron 自己的 capturePage 截真实界面。
 *
 * 不用任何第三方截屏/浏览器自动化工具，就是用这个 App 的 Electron 打开
 * 已经跑着的本地服务，逐页截图。窗口默认隐藏（paintWhenInitiallyHidden 打开，
 * 隐藏状态下照样会绘制），如果截出来是空白就自动改成显示模式重截一次。
 *
 *   node scripts/capture-shots.js --base=http://127.0.0.1:5180 --out=submission/readme/images
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');

function arg(name, fallback) {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}

const BASE = arg('base', 'http://127.0.0.1:5180').replace(/\/+$/, '');
const OUT = path.resolve(ROOT, arg('out', 'submission/readme/images'));

/** 要截的页面：hash、文件名、说明 */
const PAGES = [
  { hash: '#/', file: '01-工作台.png' },
  { hash: '#/tasks', file: '02-待办与计划.png' },
  { hash: '#/focus', file: '03-专注番茄钟.png' },
  { hash: '#/textbooks', file: '04-教材精读.png' },
  { hash: '#/articles', file: '05-外刊阅读.png' },
  {
    hash: '#/chat',
    file: '06-AI整理空间.png',
    // 默认进入是空状态，先点开最近一条对话，截图才有内容
    prep: async (win) => {
      await win.webContents.executeJavaScript(
        '(() => { const b = document.querySelector(".cw-list-body"); if (b && b.children[0]) b.children[0].click(); return true; })()',
        true,
      ).catch(() => {});
      await sleep(3500);
      // 消息是异步画上去的，画完会自己滚到底；这里反复压回顶部，
      // 让截图从「用户说的第一句话」开始，读起来是完整的一段。
      let n = -1;
      for (let i = 0; i < 6; i += 1) {
        n = await win.webContents.executeJavaScript(
          '(() => { const t = document.querySelector(".cw-thread");'
          + ' if (t) { t.scrollTop = 0; } document.scrollingElement.scrollTop = 0;'
          + ' return document.querySelectorAll(".msg").length; })()',
          true,
        ).catch(() => -1);
        await sleep(120);
      }
      const st = async () => win.webContents.executeJavaScript(
        '(() => { const t = document.querySelector(".cw-thread"); if (!t) return [-1, -1];'
        + ' return [t.scrollTop, t.scrollHeight - t.clientHeight]; })()',
        true,
      ).catch(() => [-1, -1]);
      console.log(`  … 06 消息 ${n} 条，先 ${JSON.stringify(await st())}`);
      await sleep(500);
      console.log(`  … 06 再 500ms 后 ${JSON.stringify(await st())}`);
    },
  },
];

const WIDTH = 1440;
const HEIGHT = 900;
// 显示器高度有限，窗口再高会被系统裁掉；用缩放换取更大的 CSS 视口，
// 这样截出来的页面是完整的，不会在卡片中间断掉。
const ZOOM = Number(arg('zoom', '0.75'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(win, target, file, { showWindow, prep } = {}) {
  // 先设缩放再加载，加载后再补设一次（缩放在 load 之后可能被重置）
  win.webContents.setZoomFactor(ZOOM);
  await win.loadURL(target);
  win.webContents.setZoomFactor(ZOOM);
  await win.webContents.insertCSS('::-webkit-scrollbar{width:0;height:0}');
  // 等骨架屏全部换成真实内容，再等字体排好、动画落定
  let waited = 0;
  for (let i = 0; i < 60; i += 1) {
    const left = await win.webContents.executeJavaScript(
      'document.querySelectorAll(".skeleton").length', true,
    ).catch(() => -1);
    if (left === 0) break;
    waited += 250;
    await sleep(250);
  }
  if (waited > 2000) console.log(`  … ${file} 等了 ${waited}ms 骨架屏才消失`);
  await sleep(1200);
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)', true).catch(() => {});
  if (prep) await prep(win);
  // 隐藏窗口里改完 DOM 再截图，有时拿到的是改之前的合成帧，强制重绘一次
  win.webContents.invalidate();
  await sleep(260);
  if (showWindow && !win.isVisible()) win.show();
  if (showWindow) await sleep(400);
  const image = await win.webContents.capturePage();
  const png = image.toPNG();
  const dest = path.join(OUT, file);
  fs.writeFileSync(dest, png);
  const { width, height } = image.getSize();
  return { file, bytes: png.length, width, height };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // 单张模式：截一张本地 HTML（用来出架构图这类配图）
  const html = arg('html', '');
  if (html) {
    const src = path.resolve(ROOT, html);
    const file = arg('file', '架构图.png');
    const size = arg('size', '1600x1000').split('x').map(Number);
    // 窗口高度超过屏幕时会被系统裁掉，改用离屏渲染：不受显示器尺寸限制
    const offscreen = size[1] > 950;
    const win = new BrowserWindow({
      width: size[0],
      height: size[1],
      useContentSize: true,
      show: false,
      paintWhenInitiallyHidden: true,
      autoHideMenuBar: true,
      webPreferences: {
        backgroundThrottling: false,
        offscreen: offscreen,
      },
    });
    if (offscreen) win.webContents.setFrameRate(30);
    await win.loadURL(`file:///${src.replace(/\\/g, '/')}`);
    await sleep(offscreen ? 1600 : 900);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, file), image.toPNG());
    const { width, height } = image.getSize();
    console.log(`  OK ${file}  ${width}x${height}  ${Math.round(image.toPNG().length / 1024)} KB${offscreen ? '  (离屏)' : ''}`);
    win.destroy();
    app.exit(0);
    return;
  }

  const results = [];
  let showWindow = false;

  const makeWindow = (visible) => new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: visible,
    paintWhenInitiallyHidden: true,
    backgroundColor: '#e9e3d6',
    autoHideMenuBar: true,
    webPreferences: { backgroundThrottling: false },
  });

  let win = makeWindow(false);

  // 预热：先把应用整体启动起来（拉一次 bootstrap、加载字体），
  // 否则第一张图容易截在启动过程中，只有骨架屏。
  win.webContents.setZoomFactor(ZOOM);
  await win.loadURL(`${BASE}/`);
  win.webContents.setZoomFactor(ZOOM);
  await sleep(4500);

  for (const page of PAGES) {
    let shot = await shoot(win, `${BASE}/${page.hash}`, page.file, { showWindow, prep: page.prep });
    // 空白截图通常只有几 KB；隐藏窗口画不出来时改成显示模式再来一次
    if (shot.bytes < 30000 && !showWindow) {
      console.log(`  ${page.file} 只有 ${shot.bytes} 字节，改成显示模式重截`);
      win.destroy();
      showWindow = true;
      win = makeWindow(true);
      await win.loadURL(`${BASE}/`);
      await sleep(1200);
      shot = await shoot(win, `${BASE}/${page.hash}`, page.file, { showWindow, prep: page.prep });
    }
    results.push(shot);
    console.log(`  OK ${page.file}  ${shot.width}x${shot.height}  ${Math.round(shot.bytes / 1024)} KB`);
  }

  win.destroy();
  console.log(JSON.stringify(results, null, 2));
  app.exit(0);
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
