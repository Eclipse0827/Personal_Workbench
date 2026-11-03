/**
 * 浮窗页能用到的桌面能力，只暴露这几个方法。
 * 页面拿不到 Node，也拿不到任意系统调用。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopFloat', {
  info: () => ipcRenderer.invoke('float:info'),
  togglePin: () => ipcRenderer.invoke('float:toggle-pin'),
  close: () => ipcRenderer.send('float:close'),
  openApp: () => ipcRenderer.send('float:open-app'),
  resize: (height) => ipcRenderer.send('float:resize', height),
});
