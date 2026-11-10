'use strict';

/**
 * 真 App 里 Node 运行时的入口模板。
 * 由 scripts/build-mobile-www.js 复制到 mobile/www/nodejs/index.js。
 *
 * 插件：@capawesome/capacitor-nodejs（内嵌 Node.js for Mobile Apps 运行时）
 * 它在 App 后台线程跑一个完整 Node，我们把现有的 server/server.js 原样带进去，
 * 监听 127.0.0.1，数据写到 App 私有目录 —— 84 个接口一行都不用重写。
 */

const path = require('path');

let bridge = { app: null, channel: { post() {} } };
try { bridge = require('bridge'); } catch { /* 用 node 直接调试时没有 bridge */ }

// 真 App 里 app.datadir() 是可写的私有目录；用 node 直接调试时退到 .runtime/
const dataDir = bridge.app ? bridge.app.datadir() : path.join(__dirname, '.runtime');
process.env.WB_DATA_DIR = path.join(dataDir, 'data');
process.env.WB_PLATFORM = 'mobile-app';
/** 插件不支持 child_process：关掉桌面浮窗与 Windows 本机 OCR */
process.env.WB_DISABLE_NATIVE = '1';
/** WebView 从 capacitor://localhost 跨域访问 127.0.0.1，需要 CORS */
process.env.WB_ALLOW_CORS = '1';
/** 只在 App 内回环，不监听公网，也不设访问口令 */
process.env.WB_ACCESS_TOKEN = '';
process.env.PORT = process.env.PORT || '5180';

const server = require('./server/server.js');
server.start().catch((err) => {
  console.error('App 内本地服务启动失败：', err);
});
bridge.channel.post('ready', { port: Number(process.env.PORT) });
