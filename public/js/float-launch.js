/**
 * 打开桌面浮窗。
 * 两个入口（待办页、专注页）共用同一段处理：成功就轻提示，
 * 没装 Electron 就给出可执行的安装命令，不假装窗口已经打开。
 */

import { api } from './api.js';
import { h, modal, toast, toastError } from './ui.js';

let launching = false;

export async function launchFloatWindow() {
  if (launching) return false;
  launching = true;
  try {
    await api.launchFloat();
    toast('浮窗已经打开，拖到顺手的位置就好。');
    return true;
  } catch (err) {
    if (err.code === 'ELECTRON_NOT_INSTALLED') {
      modal({
        title: '浮窗还差一个桌面外壳',
        body: h('div', {}, [
          h('p', {}, '网页版不受影响。桌面浮窗需要 Electron，只需装一次（约 100MB）。'),
          h('p', {}, ['在项目目录运行：', h('code', {}, 'npm install --save-dev electron')]),
          h('p.mb0.small', {}, '装好后再点一次「浮到桌面」。'),
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
