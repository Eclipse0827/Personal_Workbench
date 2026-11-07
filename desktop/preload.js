/**
 * 浮窗页能用到的桌面能力，只暴露这几个方法。
 * 页面拿不到 Node，也拿不到任意系统调用。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopFloat', {
  info: () => ipcRenderer.invoke('float:info'),
  togglePin: () => ipcRenderer.invoke('float:toggle-pin'),
  setSnap: (enabled) => ipcRenderer.invoke('float:set-snap', Boolean(enabled)),
  expand: () => ipcRenderer.invoke('float:expand'),
  close: () => ipcRenderer.send('float:close'),
  openApp: () => ipcRenderer.send('float:open-app'),
  resize: (height) => ipcRenderer.send('float:resize', height),
  dragStart: (x, y) => ipcRenderer.send('float:drag-start', x, y),
  dragMove: (x, y) => ipcRenderer.send('float:drag-move', x, y),
  dragEnd: () => ipcRenderer.send('float:drag-end'),
  onState: (cb) => {
    const handler = (_e, data) => cb(data);
    ipcRenderer.on('float:state', handler);
    return () => ipcRenderer.removeListener('float:state', handler);
  },
});
