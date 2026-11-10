'use strict';

/**
 * 不整服务器：一台电脑，两份完全独立的数据。
 * ---------------------------------------------------------------
 *   实例 A  127.0.0.1:5180  桌面 / 网页用（项目内 data/）
 *   实例 B  0.0.0.0:5181    手机同 Wi-Fi 用（data/.instances/phone/）
 *
 * 两个进程各设各的 WB_DATA_DIR，互不读写；都带自己的 instanceId。
 * 不买云主机、不配域名、不配 HTTPS、不写任何同步逻辑。
 * 代价说在前面：电脑得开着，手机得跟它同一个 Wi-Fi；手机的数据存在电脑的第二份目录里，
 * 不在手机本地。要「手机断网也能用且数据存手机」，得另走离线数据层重写那条路。
 *
 * 用法：
 *   npm run two
 *   node scripts/start-two.js --phone-port=5182 --phone-token=abc123
 */

const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server', 'server.js');
const argv = process.argv.slice(2);

function arg(name, fallback) {
  const pref = `${name}=`;
  const hit = argv.find((a) => a.startsWith(pref));
  if (hit) return hit.slice(pref.length);
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const DESKTOP_PORT = Number(arg('--desktop-port', 5180));
const PHONE_PORT = Number(arg('--phone-port', 5181));
const PHONE_DATA = path.resolve(arg('--phone-data', path.join(ROOT, 'data', '.instances', 'phone')));
const PHONE_TOKEN = String(arg('--phone-token', process.env.WB_ACCESS_TOKEN || '')).trim();

const children = [];

function lanIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '127.0.0.1';
}

function ping(port, token = '') {
  // 设了访问口令的实例，不带口令会回 401；健康检查必须带上，
  // 否则服务明明起来了却一直被判成「没就绪」，最后把自己关掉。
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/bootstrap${query}`, { timeout: 600 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitHealthy(port, child, label, token = '') {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (child.exitCode !== null) throw new Error(`${label} 进程提前退出了`);
    if (await ping(port, token)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} 启动超时`);
}

async function start({ port, host, dataDir, platform, token, label }) {
  const child = spawn(process.execPath, [SERVER, '--port', String(port), '--host', host], {
    cwd: ROOT,
    env: {
      ...process.env,
      WB_DATA_DIR: dataDir,
      WB_PLATFORM: platform,
      WB_ACCESS_TOKEN: token,
    },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  children.push(child);
  await waitHealthy(port, child, label, token);
  console.log(`  ${label} 已就绪：http://${host}:${port}`);
  return child;
}

function shutdown() {
  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      try { child.kill(); } catch { /* 已经退了 */ }
    }
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

(async () => {
  console.log('');
  console.log('  缓一缓 · 一台电脑两份数据（不需要服务器）');
  console.log('  ------------------------------------------');

  const desktopAlive = await ping(DESKTOP_PORT);
  if (desktopAlive) {
    console.log(`  实例 A 复用已在运行的 127.0.0.1:${DESKTOP_PORT}（数据：项目内 data/）`);
  } else {
    await start({
      port: DESKTOP_PORT, host: '127.0.0.1',
      dataDir: path.join(ROOT, 'data'), platform: 'desktop', token: '', label: '实例 A · 桌面',
    });
  }

  await start({
    port: PHONE_PORT, host: '0.0.0.0',
    dataDir: PHONE_DATA, platform: 'phone', token: PHONE_TOKEN, label: '实例 B · 手机',
  });

  const url = `http://${lanIP()}:${PHONE_PORT}${PHONE_TOKEN ? `/?token=${encodeURIComponent(PHONE_TOKEN)}` : ''}`;
  console.log('');
  console.log(`  手机（同 Wi-Fi）打开：  ${url}`);
  console.log(`  手机那份数据存在：      ${PHONE_DATA}`);
  console.log('  浏览器菜单里「添加到主屏幕」即可当 App 用。');
  if (!PHONE_TOKEN) console.log('  提示：没设口令，同一 Wi-Fi 下别人也能访问。加 --phone-token=xxx 更安全。');
  console.log('  按 Ctrl + C 停止两个实例。');
  console.log('');
})().catch((err) => {
  console.error(`启动失败：${err.message || err}`);
  shutdown();
});
