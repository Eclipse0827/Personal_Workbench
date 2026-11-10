'use strict';

/**
 * 桌面版冒烟测试：不看窗口，只看「这份壳能不能把应用真的跑起来」。
 *
 * 做法：用 WB_DESKTOP_SMOKE=1 启动 Electron（打包后的 exe 或 node_modules 里的
 * 开发版都支持），主进程把本地服务地址写进一个临时文件，这里读出来直接请求：
 *   GET /            静态首页
 *   GET /api/bootstrap  应用初始化数据
 *   GET /api/tasks   一个真实业务接口
 * 三项都通才算通过，然后让进程自己退出。
 *
 * 用法：
 *   node scripts/desktop-smoke.js              # 有打包产物就测产物，否则测开发版
 *   node scripts/desktop-smoke.js <exe 路径>    # 指定某个 exe
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'desktop-dist');

function findTarget() {
  const arg = process.argv[2];
  if (arg) return { exe: path.resolve(arg), cwd: path.dirname(path.resolve(arg)), packaged: true };

  if (fs.existsSync(DIST)) {
    const hits = fs.readdirSync(DIST).filter((f) => /\.exe$/i.test(f));
    const portable = hits.find((f) => /portable/i.test(f));
    const picked = portable || hits[0];
    if (picked) return { exe: path.join(DIST, picked), cwd: DIST, packaged: true };
  }

  const dev = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  if (fs.existsSync(dev)) return { exe: dev, cwd: ROOT, packaged: false };
  throw new Error('既没有 desktop-dist 下的 exe，也没有 electron 开发版');
}

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 8000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        type: res.headers['content-type'] || '',
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
  });
}

function post(url, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload || {}));
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        type: res.headers['content-type'] || '',
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
    req.end(body);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFile(file, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8').trim();
      if (text) return text;
    }
    await sleep(300);
  }
  return '';
}

async function main() {
  const target = findTarget();
  const urlFile = path.join(os.tmpdir(), `wb-desktop-url-${process.pid}.txt`);
  try { fs.unlinkSync(urlFile); } catch { /* 本来就没有 */ }

  console.log(`启动：${target.exe}`);
  // 必须把这两个变量「删掉」而不是置空：ELECTRON_RUN_AS_NODE 只要存在（哪怕是空串）
  // Electron 就会按纯 Node 跑，窗口和 app 模块都不会起来。
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  env.WB_DESKTOP_SMOKE = '1';
  // 给足停留时间，好让下面的浮窗检查能在这个进程里跑完
  env.WB_DESKTOP_SMOKE_MS = '25000';
  env.WB_DESKTOP_URL_FILE = urlFile;

  const child = spawn(target.exe, target.packaged ? [] : ['.'], {
    cwd: target.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });
  child.stdout.on('data', () => {});

  const base = await waitFile(urlFile, 45000);
  if (!base) {
    try { child.kill(); } catch { /* 已退 */ }
    console.error('失败：等不到本地服务地址');
    if (stderr.trim()) console.error(stderr.trim().split('\n').slice(-6).join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(`本地服务：${base}`);

  const checks = [
    ['GET /', `${base}/`, (r) => r.status === 200 && /<html/i.test(r.body)],
    ['GET /api/bootstrap', `${base}/api/bootstrap`, (r) => r.status === 200 && r.type.includes('json')],
    ['GET /api/tasks', `${base}/api/tasks`, (r) => r.status === 200 && r.type.includes('json')],
  ];

  let failed = 0;
  for (const [label, url, ok] of checks) {
    try {
      const r = await get(url);
      const pass = ok(r);
      if (!pass) failed += 1;
      console.log(`  ${pass ? 'OK  ' : 'FAIL'} ${label}  (${r.status}, ${r.body.length} 字节)`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL ${label}  ${err.message}`);
    }
  }

  // 浮窗：安装版最容易坏的一环。走 shell 通道 = 在同一个 Electron 进程里开窗口，
  // 返回 shell:true 说明主进程接住了请求、窗口也建起来了（不然会是 5xx）。
  try {
    const r = await post(`${base}/api/float/launch`, {});
    let body = null;
    try { body = JSON.parse(r.body); } catch { /* 保持 null，下面判失败 */ }
    const pass = r.status === 202 && body && body.shell === true;
    if (!pass) failed += 1;
    console.log(`  ${pass ? 'OK  ' : 'FAIL'} POST /api/float/launch  (${r.status}, ${body && body.shell ? '进程内开窗' : r.body.slice(0, 80)})`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL POST /api/float/launch  ${err.message}`);
  }

  if (child.exitCode === null) {
    try { child.kill(); } catch { /* 已退 */ }
  }
  try { fs.unlinkSync(urlFile); } catch { /* 无所谓 */ }

  if (failed) {
    console.error(`冒烟未通过：${failed} 项失败`);
    process.exitCode = 1;
  } else {
    console.log('冒烟通过：桌面壳能拉起本地服务并正常响应。');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
