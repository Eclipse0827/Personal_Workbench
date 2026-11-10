'use strict';

/**
 * 一键安装 / 环境检查脚本（被 readme/一键安装.bat 调用）
 *
 * 为什么不把逻辑写在 .bat 里：cmd.exe 按系统 ANSI 代码页（中文 Windows 是 936）
 * 解析批处理文件，非 ASCII 字节会被读错，脚本直接报「不是内部或外部命令」。
 * 所以 .bat 只做 10 行 ASCII 启动器，中文提示全部由 Node 输出（UTF-8 + chcp 65001）。
 *
 *   node readme/scripts/install.js                 启动（默认 5180，自动开浏览器）
 *   node readme/scripts/install.js /port=5200      指定端口
 *   node readme/scripts/install.js /no-browser     只起服务
 *   node readme/scripts/install.js /check          只检查环境，不启动
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ARGS = process.argv.slice(2);

/**
 * 参数归一化：/check、--check、check 都认。
 * 另外 Git Bash / MSYS 会把以斜杠开头的参数当成路径，`/check` 会变成
 * `C:/Program Files/Git/check`，这里取最后一段，免得用户换个终端就失效。
 */
function argName(raw) {
  let s = String(raw).trim();
  if (s.startsWith('--')) s = s.slice(2);
  else if (s.startsWith('/')) s = s.slice(1);
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (slash >= 0) s = s.slice(slash + 1);
  return s.toLowerCase();
}

function flag(name) {
  return ARGS.some((a) => argName(a) === name);
}
function value(name, fallback) {
  for (const a of ARGS) {
    const norm = argName(a);
    if (norm.startsWith(`${name}=`)) return norm.slice(name.length + 1);
  }
  return fallback;
}

const PORT = Number(value('port', '5180'));
const NO_BROWSER = flag('no-browser');
const CHECK_ONLY = flag('check');

const MIN_NODE_MAJOR = 18;

function line(text = '') {
  process.stdout.write(`${text}\n`);
}
function ok(text) {
  line(`  [OK]   ${text}`);
}
function warn(text) {
  line(`  [!!]   ${text}`);
}
function bad(text) {
  line(`  [X ]   ${text}`);
}
function head(text) {
  line('');
  line(`  ${text}`);
  line(`  ${'-'.repeat(Math.max(20, text.length + 4))}`);
}

/** 在几个可能的位置里找真正的应用根目录（含 server/server.js） */
function findAppDir() {
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, '..', '..'),   // readme/scripts -> 项目根
    path.resolve(__dirname, '..'),         // 脚本被拷到项目根时
    path.resolve(__dirname, '..', '..', '..'),
  ];

  // 提交包结构：readme/ 与 project/ 平级，源码在 project/ 下面
  const projectDir = path.resolve(__dirname, '..', '..', 'project');
  for (const base of [projectDir, path.join(projectDir, '源码')]) {
    if (!fs.existsSync(base)) continue;
    for (const entry of safeReaddir(base)) {
      candidates.push(path.join(base, entry));
      candidates.push(path.join(base, entry, '源码'));
    }
  }

  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'server', 'server.js'))) return dir;
  }
  return '';
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function pickPort(start) {
  for (let port = start; port < start + 20; port += 1) {
    if (await portFree(port)) return port;
    warn(`端口 ${port} 被占用，试下一个`);
  }
  return start;
}

function openBrowser(url) {
  try {
    const cmd = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch {
    warn('没能自动打开浏览器，请手动访问上面的地址');
  }
}

async function main() {
  line('');
  line('  缓一缓 · 个人学术工作台 —— 一键安装 / 环境检查');
  line('  ==================================================');

  head('1 / 6  检查 Node.js');
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    bad(`当前 Node.js 版本是 ${process.versions.node}，需要 ${MIN_NODE_MAJOR} 或更高`);
    line('');
    line('  请到 https://nodejs.org 下载 LTS 版本安装后，重新双击本文件。');
    line('');
    process.exit(1);
  }
  ok(`Node.js ${process.versions.node}`);

  head('2 / 6  定位应用目录');
  const appDir = findAppDir();
  if (!appDir) {
    bad('没找到 server/server.js');
    line('');
    line('  请把本脚本放在「缓一缓」项目根目录下运行，或从项目根目录双击启动。');
    line('  如果你下载的是源码压缩包，请先解压，再在解压出来的目录里运行。');
    line('');
    process.exit(1);
  }
  ok(`应用目录：${appDir}`);

  head('3 / 6  检查程序文件');
  const required = ['server/server.js', 'server/db.js', 'public/index.html'];
  const missing = required.filter((f) => !fs.existsSync(path.join(appDir, f)));
  if (missing.length) {
    bad(`缺少文件：${missing.join('、')}`);
    line('');
    line('  压缩包可能没有解压完整，请重新解压后再试。');
    line('');
    process.exit(1);
  }
  ok('程序文件齐全');

  head('4 / 6  准备数据目录');
  const dataDir = path.join(appDir, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    ok('已创建 data/ 目录（第一次运行）');
  } else {
    ok('data/ 目录已存在，原有数据不会被覆盖');
  }
  const settingsFile = path.join(dataDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({ aiProvider: 'mock' }, null, 2), 'utf8');
    ok('已写入默认设置（规则引擎，功能完整可用）');
  } else {
    ok('沿用已有设置，未做改动');
  }

  head('5 / 6  检查端口');
  const port = await pickPort(PORT);
  if (port === PORT) ok(`端口 ${PORT} 可用`);
  else ok(`改用端口 ${port}`);

  head('6 / 6  启动');
  if (CHECK_ONLY) {
    ok('只做检查，不启动（/check）');
    line('');
    line('  一切正常。去掉 /check 再运行一次即可启动。');
    line('');
    return;
  }

  const url = `http://127.0.0.1:${port}`;
  line('');
  line(`  地址：${url}`);
  line('  停止：在这个窗口按 Ctrl + C，或直接关掉窗口');
  line('  数据：' + dataDir);
  line('');
  line('  ==================================================');
  line('');

  if (!NO_BROWSER) openBrowser(url);

  const child = spawn(process.execPath, [
    path.join(appDir, 'server', 'server.js'),
    '--port', String(port),
    '--host', '127.0.0.1',
  ], { cwd: appDir, stdio: 'inherit' });

  child.on('exit', (code) => process.exit(code === null ? 0 : code));
}

main().catch((err) => {
  bad(String((err && err.message) || err));
  process.exit(1);
});
