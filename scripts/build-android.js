'use strict';

/**
 * 一键出安卓包。
 *
 *   node scripts/build-android.js               正式包（arm64 + armv7，release 签名）
 *   node scripts/build-android.js --abi all     连 x86_64 一起打（给模拟器验货用）
 *   node scripts/build-android.js --debug       debug 包（不签名，装得快）
 *   node scripts/build-android.js --sync-only   只组装 www 并同步原生工程，不编译
 *
 * 产物统一拷到 dist-mobile/，文件名带版本号和 ABI，发人不会发错。
 *
 * 用到的环境变量（不设就用系统默认）：
 *   JAVA_HOME   需要 JDK 21（AGP 8.13 的要求）
 *   ANDROID_HOME  Android SDK
 *   GRADLE_BIN  指向某个 gradle 可执行文件，跳过 wrapper 下载
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MOBILE = path.join(ROOT, 'mobile');
const ANDROID = path.join(MOBILE, 'android');
const OUT = path.join(ROOT, 'dist-mobile');

const argv = process.argv.slice(2);
const syncOnly = argv.includes('--sync-only');
const wantDebug = argv.includes('--debug');
const abiAll = argv.includes('--abi') && argv.includes('all');

function run(cmd, args, cwd, extraEnv) {
  console.log(`\n$ ${path.basename(cmd)} ${args.join(' ')}  (${path.relative(ROOT, cwd) || '.'})`);
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...extraEnv },
  });
  if (res.status !== 0) {
    console.error(`\n失败：${path.basename(cmd)} 退出码 ${res.status}`);
    process.exit(res.status || 1);
  }
}

// 1. 组装 webDir（静态页 + 内嵌 Node 项目）
run(process.execPath, [path.join(ROOT, 'scripts', 'build-mobile-www.js')], ROOT);

// 2. 同步进原生工程
if (!fs.existsSync(ANDROID)) {
  run(process.execPath, [path.join(MOBILE, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor'), 'add', 'android'], MOBILE);
}
run(process.execPath, [path.join(MOBILE, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor'), 'sync', 'android'], MOBILE);

// 3. 覆盖签名/版本/ABI
run(process.execPath, [path.join(ROOT, 'scripts', 'patch-android.js'), ...(abiAll ? ['--abi', 'all'] : [])], ROOT);

if (syncOnly) {
  console.log('\n已同步，未编译。');
  process.exit(0);
}

// 4. 编译
const gradleBin = process.env.GRADLE_BIN;
const gradleCmd = gradleBin || path.join(ANDROID, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
const task = wantDebug ? 'assembleDebug' : 'assembleRelease';
run(gradleCmd, [task, '--no-daemon', '-q'], ANDROID);

// 5. 收产物
const apkDir = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', wantDebug ? 'debug' : 'release');
const apks = fs.existsSync(apkDir) ? fs.readdirSync(apkDir).filter((f) => f.endsWith('.apk')) : [];
if (!apks.length) {
  console.error(`没找到 APK，去 ${apkDir} 看看`);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
for (const name of apks) {
  const tag = abiAll ? 'universal' : 'arm';
  const target = path.join(OUT, `HuanYiHuan-${pkg.version}-${tag}${wantDebug ? '-debug' : ''}.apk`);
  fs.copyFileSync(path.join(apkDir, name), target);
  const mb = (fs.statSync(target).size / 1024 / 1024).toFixed(1);
  console.log(`\n打包完成：${path.relative(ROOT, target)}  (${mb} MB)`);
}
