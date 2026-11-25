'use strict';

/* 预加载脚本：把"打开书 / 保存笔记"需要的几个函数交给页面。
   页面本身仍然拿不到 node 能力（nodeIntegration 关着、contextIsolation 开着）。
   打包版必须走这条原生通道，原因是 Electron 里 File System Access 的句柄权限
   不跨会话保留：历史记录重开书、笔记写入都会退化成"每次都弹选择框"。 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nativeBook', {
  // 弹系统"打开文件"对话框，返回 {ok,name,path,data}
  open: function () { return ipcRenderer.invoke('book:open'); },
  // 按真实路径直接读取，不弹任何框；文件不在了返回 {ok:false,missing:true}
  openPath: function (p) { return ipcRenderer.invoke('book:openPath', p); }
});

contextBridge.exposeInMainWorld('nativeNote', {
  save: function (payload) { return ipcRenderer.invoke('note:save', payload); },
  pickDir: function () { return ipcRenderer.invoke('note:pickDir'); },
  getDir: function () { return ipcRenderer.invoke('note:getDir'); },
  clearDir: function () { return ipcRenderer.invoke('note:clearDir'); },
  // 读入笔记文件：返回 {ok,name,path,dir,text}，主进程同时把保存目录改成该文件所在文件夹
  importFile: function () { return ipcRenderer.invoke('note:import'); }
});

/* 锁屏：密码哈希存在主进程的 userData\lock.json，
   onSystemLock 是系统锁屏 / 睡眠时主进程推过来的通知。 */
contextBridge.exposeInMainWorld('nativeLock', {
  get: function () { return ipcRenderer.invoke('lock:get'); },
  set: function (h) { return ipcRenderer.invoke('lock:set', { h: h }); },
  clear: function () { return ipcRenderer.invoke('lock:clear'); },
  // 睡眠前没来得及锁？醒来时查这个标记补锁
  pending: function () { return ipcRenderer.invoke('lock:pending'); },
  ack: function () { return ipcRenderer.invoke('lock:ack'); },
  onSystemLock: function (cb) {
    if (typeof cb !== 'function') return;
    ipcRenderer.on('sys:lock', function (e, reason) { try { cb(reason || ''); } catch (err) {} });
  }
});

/* 授权：机器码 / 激活 / 购买链接，全部在主进程里做（RSA 公钥不能放页面）。
   页面只拿到"已授权/未授权 + 开通了哪几项"。 */
contextBridge.exposeInMainWorld('nativeLicense', {
  status: function () { return ipcRenderer.invoke('license:status'); },
  activate: function (code) { return ipcRenderer.invoke('license:activate', code); }
});

/* 文档密码上锁：只存哈希，明文不出页面（页面传上来的就是散列值） */
contextBridge.exposeInMainWorld('nativeDocLock', {
  get: function (key) { return ipcRenderer.invoke('doclock:get', key); },
  list: function () { return ipcRenderer.invoke('doclock:list'); },
  set: function (p) { return ipcRenderer.invoke('doclock:set', p); },
  clear: function (key) { return ipcRenderer.invoke('doclock:clear', key); }
});

/* 笔记上锁：主进程只存哈希 + salt，密钥由页面派生，主进程全程不碰明文 */
contextBridge.exposeInMainWorld('nativeNoteLock', {
  get: function () { return ipcRenderer.invoke('notelock:get'); },
  set: function (p) { return ipcRenderer.invoke('notelock:set', p); },
  clear: function () { return ipcRenderer.invoke('notelock:clear'); }
});
