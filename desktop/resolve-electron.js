/**
 * 找到已经下载好的 Electron 可执行文件。
 *
 * 这里刻意不 require('electron')：那个入口在缺少二进制文件时会同步触发
 * 上百兆的下载，放在 HTTP 请求里会把整个服务卡住。只读 path.txt 和 dist。
 */

const fs = require('fs');
const path = require('path');

function resolveElectron() {
  const pkgDir = path.join(__dirname, '..', 'node_modules', 'electron');

  const override = process.env.ELECTRON_OVERRIDE_DIST_PATH;
  if (override) {
    const exe = path.join(override, process.platform === 'win32' ? 'electron.exe' : 'electron');
    if (isFile(exe)) return exe;
  }

  let rel = null;
  try {
    rel = fs.readFileSync(path.join(pkgDir, 'path.txt'), 'utf8').trim();
  } catch {
    return null;
  }
  if (!rel) return null;

  const exe = path.resolve(pkgDir, 'dist', rel);
  return isFile(exe) ? exe : null;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

module.exports = { resolveElectron };
