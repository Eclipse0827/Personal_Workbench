'use strict';

/**
 * 给 `npx cap add android` 生成出来的原生工程打上「我们自己的」配置。
 *
 * 为什么不直接改 app/build.gradle：
 *   mobile/android 是生成物（没进版本库），下次 `cap add android` 会整个重来。
 *   所以这里每次 sync 后重新写一份 app/custom.gradle，再在 app/build.gradle
 *   末尾挂一行 apply —— 那一行有标记，重复执行不会叠加。
 *
 * 干的事：
 *   · release 包用 mobile/keystore 里的密钥签名（不然装不上手机）
 *   · 版本号跟 package.json 对齐
 *   · 只打 arm64-v8a / armeabi-v7a 两个 ABI（真机就这两种；
 *     带上 x86_64 只会让安装包多三十兆，模拟器测试时才临时加回来）
 *   · 写 local.properties 指向本机 Android SDK
 *
 * 用法：node scripts/patch-android.js [--abi all]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ANDROID = path.join(ROOT, 'mobile', 'android');
const APP = path.join(ANDROID, 'app');
const MARK = '// >>> huan-yihuan overrides';

if (!fs.existsSync(ANDROID)) {
  console.error('还没生成安卓工程，先跑：cd mobile && npx cap add android');
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const versionName = pkg.version || '2.0.0';
const [maj, min, patch] = versionName.split('.').map((n) => Number(n) || 0);
const versionCode = maj * 10000 + min * 100 + patch;

const abiAll = process.argv.includes('--abi') && process.argv.includes('all');
const abis = abiAll
  ? "'arm64-v8a', 'armeabi-v7a', 'x86_64'"
  : "'arm64-v8a', 'armeabi-v7a'";

const custom = `// 由 scripts/patch-android.js 生成，每次 cap sync 后重写，不要手改。
def keystorePropsFile = rootProject.file('../keystore.properties')

android {
    defaultConfig {
        versionCode ${versionCode}
        versionName "${versionName}"
        ndk {
            abiFilters ${abis}
        }
    }

    signingConfigs {
        release {
            if (keystorePropsFile.exists()) {
                def props = new Properties()
                keystorePropsFile.withInputStream { props.load(it) }
                storeFile file(props['storeFile'])
                storePassword props['storePassword']
                keyAlias props['keyAlias']
                keyPassword props['keyPassword']
            }
        }
    }

    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled false
            shrinkResources false
        }
    }

    packagingOptions {
        jniLibs {
            // libnode.so 一个 ABI 就八十多兆。默认不压缩存进 APK，包体直接翻倍；
            // 改成安装时解压，APK 小一半多，运行时没有区别。
            useLegacyPackaging true
        }
    }
}
`;

fs.writeFileSync(path.join(APP, 'custom.gradle'), custom);

const buildGradlePath = path.join(APP, 'build.gradle');
let buildGradle = fs.readFileSync(buildGradlePath, 'utf8');
if (!buildGradle.includes(MARK)) {
  buildGradle += `\n${MARK}\napply from: 'custom.gradle'\n`;
  fs.writeFileSync(buildGradlePath, buildGradle);
}

// local.properties：SDK 位置。这个文件本来就不进版本库，属于机器相关配置。
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (sdk) {
  const sdkDir = sdk.replace(/\\/g, '/');
  fs.writeFileSync(path.join(ANDROID, 'local.properties'), `sdk.dir=${sdkDir}\n`);
}

// 构建内存给足，否则 CMake 编 libnode 那一步容易 OOM
const gradlePropsPath = path.join(ANDROID, 'gradle.properties');
let gradleProps = fs.existsSync(gradlePropsPath) ? fs.readFileSync(gradlePropsPath, 'utf8') : '';
if (!/org\.gradle\.jvmargs/.test(gradleProps)) {
  gradleProps += `${gradleProps.endsWith('\n') ? '' : '\n'}org.gradle.jvmargs=-Xmx3072m -Dfile.encoding=UTF-8\n`;
}

/**
 * Node 运行时（libnode.so）那 96MB 压缩包默认从 GitHub Releases 拉，
 * 国内直连基本必挂（连接超时），代理也常常 502。
 * 所以：本地缓存里没有的话，改走镜像下载；插件会用官方 SHA256 校验，
 * 镜像就算被投毒也装不进去。
 */
const LIB_VERSION = '18.20.4-capawesome.3';
const gradleHome = process.env.GRADLE_USER_HOME || path.join(os.homedir(), '.gradle');
const libZip = path.join(
  gradleHome, 'caches', 'capawesome-capacitor-nodejs',
  `nodejs-mobile-v${LIB_VERSION}-android.zip`
);
if (!fs.existsSync(libZip) && !/nodejsMobileAndroidUrl/.test(gradleProps)) {
  const mirror = `https://ghfast.top/https://github.com/capawesome-team/nodejs-mobile/releases/download/v${LIB_VERSION}/nodejs-mobile-v${LIB_VERSION}-android.zip`;
  gradleProps += `\n# libnode 在国内直连 GitHub 下不动，走镜像；SHA256 校验仍然由插件自己把关\nnodejsMobileAndroidUrl=${mirror}\n`;
  console.log('本地没有 libnode 缓存，已把下载地址切到镜像。');
}

fs.writeFileSync(gradlePropsPath, gradleProps);

console.log(`已写入安卓工程覆盖配置：versionCode ${versionCode} / ${versionName} / ABI ${abis}`);
