'use strict';

/**
 * 把一张本地 HTML 渲染成 PDF（用于出架构图这类整页配图）。
 *
 * 为什么不直接截图：窗口高度超过屏幕时会被系统裁掉，而配图需要固定画布尺寸。
 * Chromium 的打印管线按 CSS @page 的尺寸出页，不受显示器大小限制，
 * 文字还是矢量的，后面按任意倍率转成 PNG 都清晰。
 *
 *   electron scripts/html-to-pdf.js --html=xxx.html --out=xxx.pdf
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

const HTML = path.resolve(ROOT, arg('html', 'submission/readme/images/架构图.html'));
const OUT = path.resolve(ROOT, arg('out', '.doc-preview/figure.pdf'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const win = new BrowserWindow({
    width: 1200,
    height: 900,
    show: false,
    paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });

  await win.loadURL(`file:///${HTML.replace(/\\/g, '/')}`);
  await sleep(1500);

  const pdf = await win.webContents.printToPDF({
    printBackground: true,
    preferCSSPageSize: true,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });

  fs.writeFileSync(OUT, pdf);
  console.log(`  OK ${path.basename(OUT)}  ${Math.round(pdf.length / 1024)} KB`);
  win.destroy();
  app.exit(0);
}

app.whenReady().then(main).catch((err) => {
  console.error(err);
  app.exit(1);
});
