/**
 * 打开桌面浮窗。
 * 两个入口（待办页、专注页）共用同一段处理：成功就轻提示，
 * 明确失败就说清原因，不假装窗口已经打开。
 *
 * 正常情况下（桌面 App 里）这里是静默成功的——浮窗由同一个 Electron
 * 再开一个窗口，不需要安装任何东西。只有浏览器里的网页版才会遇到
 * 「本机没有桌面外壳」这一种情况。
 */

import { api } from './api.js';
import { h, modal, toast, toastError } from './ui.js';

let launching = false;

export async function launchFloatWindow() {
  if (launching) return false;
  launching = true;
  try {
    const result = await api.launchFloat();
    toast(result && result.shell
      ? '浮窗已经开好了，就在屏幕右侧。'
      : '浮窗已经打开，拖到顺手的位置就好。');
    return true;
  } catch (err) {
    if (err.code === 'ELECTRON_NOT_INSTALLED') {
      modal({
        title: '网页版没有浮窗',
        body: h('div', {}, [
          h('p', {}, '你现在用的是浏览器里的网页版，浮窗需要有桌面外壳才开得出来。'),
          h('p', {}, [
            '最省事的办法：直接用桌面版，浮窗是自带的，不用再装东西。',
          ]),
          h('p', {}, [
            '如果就想在网页版里用，在本机装一次 Electron：',
            h('code', {}, 'npm install --save-dev electron'),
            '（约 100MB）。',
          ]),
          h('p.mb0.small', {}, '网页版其余功能不受影响。'),
        ]),
        actions: [{ label: '知道了', primary: true }],
      });
    } else {
      toastError(err);
    }
    return false;
  } finally {
    launching = false;
  }
}
