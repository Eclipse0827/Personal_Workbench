/**
 * npm run float 的启动器。
 *
 * 优先连上已经开着的本地服务；没有就顺手起一个（只监听 127.0.0.1），
 * 然后用 Electron 打开浮窗。Electron 没装时给出明确的安装命令，不假装成功。
 */

const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { resolveElectron } = require('./resolve-electron');

const ROOT = path.join(__dirname, '..');
const ELECTRON = resolveElectron();

function argValue(name, fallback) {
  const pref = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}

function ping(base) {
  return new Promise((resolve) => {
    const req = http.get(`${base}/api/bootstrap`, { timeout: 700 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

function waitFor(fn, timeoutMs, child) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      if (await fn()) return resolve();
      if (child && child.exitCode !== null) return reject(new Error('本地服务启动失败'));
      if (Date.now() - started > timeoutMs) return reject(new Error('等本地服务启动超时'));
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function main() {
  if (!ELECTRON) {
    console.error('');
    console.error('桌面浮窗需要 Electron，但本机还没有下载它的运行文件。');
    console.error('请先在这个目录运行：npm install --save-dev electron');
    console.error('（大约 100MB，只需装一次。网页版不受影响，照常 node server/server.js 就能用。）');
    console.error('');
    process.exit(1);
  }

  const fixedUrl = argValue('--url', '');
  const basePort = Number(argValue('--port', process.env.PORT || 5180));

  let base = fixedUrl ? fixedUrl.replace(/\/+$/, '') : '';
  let server = null;

  if (!base) {
    for (let port = basePort; port < basePort + 20; port += 1) {
      const candidate = `http://127.0.0.1:${port}`;
      if (await ping(candidate)) { base = candidate; break; }
      if (!(await portFree(port))) continue;

      server = spawn(process.execPath, [
        path.join(ROOT, 'server', 'server.js'),
        '--port', String(port),
      ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

      let stderr = '';
      server.stdout.on('data', (c) => process.stdout.write(c));
      server.stderr.on('data', (c) => { stderr += c; process.stderr.write(c); });
      try {
        await waitFor(() => ping(candidate), 20000, server);
        base = candidate;
      } catch (err) {
        server.kill();
        server = null;
        if (stderr) continue;
        throw err;
      }
      break;
    }
  }

  if (!base) throw new Error('没有找到可用的端口，也没有连上本地服务');

  const finish = (code) => {
    // 服务是随浮窗一起起的，就一起收掉；原来就开着的服务不动
    if (server && !server.killed) server.kill();
    process.exit(code === null ? 0 : code);
  };

  const start = (extra, canRetry) => {
    const child = spawn(ELECTRON, [
      ...extra,
      path.join(__dirname, 'float-main.js'),
      `--url=${base}`,
    ], { cwd: ROOT, stdio: 'inherit' });

    child.on('error', (err) => {
      console.error('[浮窗] 启动失败：', err.message);
      finish(1);
    });
    child.on('exit', (code) => {
      // 少数受限环境里 Chromium 沙箱不可用，Electron 会静默退出：
      // Git Bash 里看到的是 3，Node 直接拿到的是 Windows 的 0x80000003（STATUS_BREAKPOINT）
      if ((code === 3 || code === 2147483651) && canRetry) {
        console.warn('[浮窗] 当前环境不允许 Chromium 沙箱，改用 --no-sandbox 重试。');
        start(['--no-sandbox'], false);
        return;
      }
      finish(code);
    });
  };

  start([], true);
}

main().catch((err) => {
  console.error(`[浮窗] ${err.message}`);
  process.exit(1);
});
