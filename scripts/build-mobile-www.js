'use strict';

/**
 * 组装手机版 Capacitor 的 webDir（mobile/www）。
 *
 *   mobile/www/              静态资源，WebView 本地加载
 *   mobile/www/nodejs/       插件要运行的 Node 项目
 *     index.js               入口（从 mobile/nodejs-entry.js 复制）
 *     server/                server/*.js 原样带进去
 *     public/                让 Node 服务也能直接提供静态页（备用的 server.url 方案）
 *
 * 纯本地文件复制，不装依赖、不联网、不产出 APK。
 * 用法：npm run mobile:www
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'mobile', 'www');
const NODE_DIR = path.join(WWW, 'nodejs');

if (!WWW.startsWith(path.join(ROOT, 'mobile'))) {
  throw new Error('构建目录路径不对，拒绝清理');
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function countFiles(dir) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    n += fs.statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}

fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(NODE_DIR, { recursive: true });

copyDir(path.join(ROOT, 'public'), WWW);
copyDir(path.join(ROOT, 'server'), path.join(NODE_DIR, 'server'));
copyDir(path.join(ROOT, 'public'), path.join(NODE_DIR, 'public'));

fs.copyFileSync(
  path.join(ROOT, 'mobile', 'nodejs-entry.js'),
  path.join(NODE_DIR, 'index.js')
);
fs.writeFileSync(
  path.join(NODE_DIR, 'package.json'),
  `${JSON.stringify({ name: 'huan-yihuan-nodejs', version: '1.0.0', main: 'index.js' }, null, 2)}\n`
);

// 兜底首页：正常走 Capacitor 本地静态资源，这个文件只在 Node 还没起来时显示
fs.writeFileSync(
  path.join(WWW, 'boot.html'),
  '<!doctype html><meta charset="utf-8"><title>缓一缓</title><p>正在启动本地服务…</p>'
);

console.log(`已生成 ${WWW}`);
console.log(`  静态资源 ${countFiles(WWW) - countFiles(NODE_DIR)} 个文件`);
console.log(`  Node 项目 ${countFiles(NODE_DIR)} 个文件`);
