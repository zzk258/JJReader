'use strict';

/* 极简阅读器 —— Electron 主进程
   Electron 22.3.27：最后一个还支持 Windows 7/8 的版本（Chromium 102）。
   页面走自定义协议 app:// 而不是 file://：
   - app:// 是安全上下文，浏览器才会给出"记住上次目录"那套文件选择器能力；
   - standard:true 让 localStorage / IndexedDB 能正常持久化（阅读进度、笔记草稿）。 */

const { app, BrowserWindow, protocol, screen, shell, dialog, ipcMain, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const execFileSync = require('child_process').execFileSync;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

/* ---- 笔记保存：原生通道 ----
   File System Access 的权限在 Electron 里跨会话留不住，页面每次保存都要重新选目录、
   还要再授权一次（两次弹框）。这里改成主进程用 fs 直接写：文件夹路径存在 userData 里，
   选过一次就一直有效，之后保存完全静默。 */

function cfgPath() {
  return path.join(app.getPath('userData'), 'note-dir.json');
}

function readCfg() {
  try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) || {}; }
  catch (e) { return {}; }
}
function writeCfg(cfg) {
  try {
    fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
    fs.writeFileSync(cfgPath(), JSON.stringify(cfg || {}), 'utf8');
  } catch (e) {}
}
function safeName(n) {
  return String(n || 'notes').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
}

// 建议目录：文档\极简阅读器笔记（弹框时预先停在这里，用户想换就换）
function defaultDir() {
  const base = app.getPath('documents') || app.getPath('home') || '.';
  return path.join(base, '极简阅读器笔记');
}

/* 规则：
   - 记住的目录里已经存在「书名.md」：直接覆盖，一声不吭；
   - 目录里找不到这个文件（这本书头一次存，或者目录换过/选错了）：弹一次系统保存框，
     默认停在记住的目录；压根没记住过就停在建议目录「文档\极简阅读器笔记」；
   - 用户选完位置，把所在文件夹记下来，这本书以后都走静默覆盖。 */

ipcMain.handle('note:getDir', function () {
  const cfg = readCfg();
  const d = (cfg.dir && fs.existsSync(cfg.dir)) ? cfg.dir : '';
  return { dir: d, suggest: defaultDir() };
});

ipcMain.handle('note:clearDir', function () {
  const c = readCfg();
  delete c.dir;
  writeCfg(c);
  return { ok: true };
});

ipcMain.handle('note:pickDir', async function () {
  const r = await dialog.showOpenDialog(win || undefined, {
    title: '选择笔记保存文件夹',
    defaultPath: readCfg().dir || defaultDir(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) { return { ok: false }; }
  const c = readCfg();
  c.dir = r.filePaths[0];                              // 只改笔记目录，别把 bookDir 冲掉
  writeCfg(c);
  return { ok: true, dir: c.dir };
});

ipcMain.handle('note:save', async function (e, p) {
  const name = safeName(p && p.name);
  const text = '\ufeff' + String((p && p.text) || '');   // BOM：记事本也按 UTF-8 打开
  const cfg = readCfg();
  const remembered = (cfg.dir && fs.existsSync(cfg.dir)) ? cfg.dir : '';

  // ① 记住的目录里有这本书的文件 → 静默覆盖，不弹任何框
  if (remembered) {
    const fp = path.join(remembered, name);
    if (fs.existsSync(fp)) {
      try {
        fs.writeFileSync(fp, text, 'utf8');
        return { ok: true, silent: true, overwrite: true, path: fp, dir: remembered };
      } catch (err) {
        return { ok: false, error: String(err && err.message || err) };
      }
    }
  }

  // ② 目录里没这个文件（新书 / 目录换过）→ 弹一次保存框让用户定位置
  let start = remembered;
  if (!start) {                                  // 从没选过：建议「文档\极简阅读器笔记」
    start = defaultDir();
    try { fs.mkdirSync(start, { recursive: true }); }
    catch (e) { start = app.getPath('documents') || app.getPath('home') || ''; }
  }
  try {
    const r = await dialog.showSaveDialog(win || undefined, {
      title: remembered ? '这本书还没存过笔记 —— 确认保存位置' : '选择笔记保存位置',
      defaultPath: path.join(start, name),
      filters: [{ name: '读书笔记', extensions: ['md', 'txt'] }]
    });
    if (r.canceled || !r.filePath) { return { canceled: true }; }
    fs.writeFileSync(r.filePath, text, 'utf8');
    const dir = path.dirname(r.filePath);
    const c = readCfg();
    c.dir = dir;                                       // 记下这次的文件夹，这本书以后静默覆盖
    writeCfg(c);
    return { ok: true, silent: false, first: true, path: r.filePath, dir: dir };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

/* 读入已有的笔记：顺带把它的所在文件夹记成保存目录。
   这样「读入旧笔记 → 改完再保存」会回到同一个文件夹，不会另存到别处。 */
ipcMain.handle('note:import', async function () {
  const r = await dialog.showOpenDialog(win || undefined, {
    title: '读入笔记文件',
    defaultPath: readCfg().dir || defaultDir(),
    properties: ['openFile'],
    filters: [{ name: '读书笔记', extensions: ['md', 'markdown', 'txt'] }]
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) { return { canceled: true }; }
  const p = r.filePaths[0];
  try {
    let txt = fs.readFileSync(p, 'utf8');
    if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);   // 去掉 BOM，别把不可见字符塞进编辑框
    const dir = path.dirname(p);
    const c = readCfg();
    c.dir = dir;                                          // 保存目录跟着读入的文件走
    writeCfg(c);
    return { ok: true, name: path.basename(p), path: p, dir: dir, text: txt };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

/* ---- 打开书：同样绕开 FSA ----
   系统对话框给出真实路径，主进程直接 fs.readFileSync 把字节交给页面。
   路径记在 localStorage 里，下次点历史记录按路径静默重开，不再弹框。 */

const BOOK_EXT = ['epub', 'mobi', 'azw', 'azw3', 'pdb', 'pdf', 'txt', 'text'];

function readBookFile(p) {
  return {
    ok: true,
    name: path.basename(p),
    path: p,
    data: new Uint8Array(fs.readFileSync(p))
  };
}

ipcMain.handle('book:open', async function () {
  const r = await dialog.showOpenDialog(win || undefined, {
    title: '打开电子书',
    defaultPath: readCfg().bookDir || app.getPath('documents'),
    properties: ['openFile'],
    filters: [{ name: '电子书', extensions: BOOK_EXT }]
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { canceled: true };
  const p = r.filePaths[0];
  try {
    const cfg = readCfg();
    cfg.bookDir = path.dirname(p);              // 下次打开书还从这个文件夹开始
    writeCfg(cfg);
    return readBookFile(p);
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

ipcMain.handle('book:openPath', async function (e, p) {
  try {
    if (!p || !fs.existsSync(p)) return { ok: false, missing: true };
    return readBookFile(p);
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
});

/* ---- 锁屏密码 ----
   只存 4 位密码的哈希（页面对 4 位数字做了一遍散列再传过来），文件在 userData\lock.json。
   单独放一个文件，好处是：真的忘了密码，删掉 lock.json 就能重置，阅读进度 / 笔记目录都不受影响。
   页面那边也拿不到明文密码，DevTools 里看不到（只能看到一串十六进制）。 */

function lockCfgPath() {
  return path.join(app.getPath('userData'), 'lock.json');
}

ipcMain.handle('lock:get', function () {
  try {
    const o = JSON.parse(fs.readFileSync(lockCfgPath(), 'utf8')) || {};
    return { ok: true, enabled: !!(o.enabled && o.h), off: !!o.off, h: String(o.h || '') };
  } catch (e) {
    return { ok: true, enabled: false, off: false, h: '' };
  }
});

ipcMain.handle('lock:set', function (e, p) {
  const h = String((p && p.h) || '');
  if (!/^[0-9a-f]{8,64}$/.test(h)) return { ok: false, error: '密码校验值不合法' };
  try {
    fs.mkdirSync(path.dirname(lockCfgPath()), { recursive: true });
    fs.writeFileSync(lockCfgPath(), JSON.stringify({ enabled: true, off: false, h: h }), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('lock:clear', function () {
  try {
    fs.writeFileSync(lockCfgPath(), JSON.stringify({ enabled: false, off: true }), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* 系统锁屏 / 睡眠 → 通知页面回到锁屏态。
   另外把"待锁定"标记留在主进程：万一页面还没来得及处理就被挂起了，
   醒来后窗口一获得焦点，页面调 lock:pending 一看还有标记，就补锁一次。 */
let lockPending = false;

ipcMain.handle('lock:pending', function () { return { pending: lockPending }; });
ipcMain.handle('lock:ack', function () { lockPending = false; return { ok: true }; });

function tellLock(reason) {
  lockPending = true;
  BrowserWindow.getAllWindows().forEach(function (w) {
    try { w.webContents.send('sys:lock', String(reason || '')); } catch (err) {}
  });
}

/* ================= 授权（付费高级功能） =================
   基础阅读永久免费；付费功能只有「文档密码上锁」「笔记上锁」两项。
   云发卡卖出去的是一行授权码（JJLIC1.payload.sig），发卡工具用私钥签名，
   程序里只放公钥，本地验签，不联网。授权码校验通过后存成
   %APPDATA%\极简阅读器\license.lic（内容就是那一行授权码，纯离线校验）。
   换成自己的密钥：跑 发卡工具\make-keys.js 生成，把 public.pem 贴到下面，
   私钥只留在发卡工具目录，绝不能进程序包。 */

const LICENSE_PUBLIC_KEY = [
  '-----BEGIN PUBLIC KEY-----',
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuN6L7UPGYWs+oGCTuh+x',
  'kLlZPpB9mlqI0fZNkMCe7GWW4aK7AWQ8KqMW/98Mn/7UomSULGlPdAoZnjdDg+3R',
  'PP7NQmuEOd6gsBlXMilxlGIf/SzCvNRhYN91+wGruvEV1dlFPmwPL6zUtRdgoWUE',
  'sgJfcm1SKBKnZzMpyZ7VnDUjJ84hEPMxlwldfDp2RlcVf+VhccpOC1cZVdHRfgN0',
  'Wl0W66voT90phnKH6cj7o8S427c74XOkeqmtzIacxeCqrjrI2D+r54vXkPHjv1pb',
  '8p8fE3cU0MHxwwO1wRqEqmJYeQQa/va/x3WC/79+20dQ52ddqJa0PPwEJ3j8yu/e',
  'CQIDAQAB',
  '-----END PUBLIC KEY-----'
].join('\n');

// 收费模型：两项高级功能免费试用 30 天；到期后由作者一对一发授权码（不再走云发卡）。
// ↓ 换成你自己的联系方式，会显示在激活弹窗里
const SELLER_CONTACT = '微信：请改成你的微信号';
const TRIAL_DAYS = 30;

const FEATURES = ['docLock', 'noteLock'];

function licPath() { return path.join(app.getPath('userData'), 'license.lic'); }

/* 试用期起点：第一次启动写 userData\trial.json，之后只读。
   删掉这个文件就等于重新试用 —— 这个模型靠人工发码，不做更狠的防篡改。 */
function trialPath() { return path.join(app.getPath('userData'), 'trial.json'); }

function ensureTrialStart() {
  let t = {};
  try { t = JSON.parse(fs.readFileSync(trialPath(), 'utf8')) || {}; } catch (e) {}
  const now = Date.now();
  const valid = typeof t.start === 'number' && t.start > 0 && t.start <= now + 60000;
  if (valid) return t.start;
  const start = now;
  try {
    fs.mkdirSync(path.dirname(trialPath()), { recursive: true });
    fs.writeFileSync(trialPath(), JSON.stringify({ start: start, v: 1 }), 'utf8');
  } catch (e) {}
  return start;
}

function trialInfo() {
  const start = ensureTrialStart();
  const end = start + TRIAL_DAYS * 86400000;
  const left = end - Date.now();
  return {
    start: start,
    end: end,
    left: left,
    active: left > 0,
    daysLeft: left > 0 ? Math.ceil(left / 86400000) : 0
  };
}

/* 机器码：主机名 + CPU 型号 + 系统 MachineGuid 混一个 SHA-256，取前 16 位。
   不含任何隐私明文；重装系统（MachineGuid 变了）会变，换内存/硬盘不会变。 */
let _machineCode = '';
function machineCode() {
  if (_machineCode) return _machineCode;
  const raw = [];
  try { raw.push('h:' + os.hostname()); } catch (e) {}
  try { const c = os.cpus(); raw.push('c:' + ((c[0] && c[0].model) || '')); } catch (e) {}
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { windowsHide: true, timeout: 3000 }).toString();
    const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{20,})/);
    if (m) raw.push('g:' + m[1].trim().toLowerCase());
  } catch (e) {}
  raw.push('a:' + os.arch());
  const h = crypto.createHash('sha256').update(raw.join('|') + '|jijian-reader-v1').digest('hex').toUpperCase();
  _machineCode = h.slice(0, 4) + '-' + h.slice(4, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16);
  return _machineCode;
}

function b64u(s) { return Buffer.from(String(s), 'base64url'); }

/* 只信"签名通过 + 机器码对上 + 没过期"这三件事，其他字段一律当参考 */
function verifyLicenseText(text) {
  const code = String(text || '').replace(/\s+/g, '');
  const parts = code.split('.');
  if (parts.length !== 3 || parts[0] !== 'JJLIC1') {
    return { ok: false, error: '授权码格式不对，请重新复制（应以 JJLIC1. 开头）' };
  }
  let sigOk = false;
  try {
    sigOk = crypto.verify('sha256', Buffer.from(parts[1]), { key: LICENSE_PUBLIC_KEY }, b64u(parts[2]));
  } catch (e) { sigOk = false; }
  if (!sigOk) return { ok: false, error: '授权码校验失败：签名无效或已被改动' };

  let payload = null;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (e) {}
  if (!payload || typeof payload !== 'object') return { ok: false, error: '授权码内容损坏' };

  if (String(payload.mc || '').toUpperCase() !== machineCode()) {
    return { ok: false, error: '这份授权码属于另一台机器（' + (payload.mc || '未知') + '）' };
  }
  if (payload.exp && Date.now() > Number(payload.exp)) {
    return { ok: false, error: '授权已过期' };
  }
  const feats = (Array.isArray(payload.f) ? payload.f : []).filter(function (f) {
    return FEATURES.indexOf(f) >= 0;
  });
  return { ok: true, code: code, features: feats, exp: payload.exp || null };
}

function currentLicense() {
  let text = '';
  try { text = fs.readFileSync(licPath(), 'utf8'); } catch (e) { return null; }
  const r = verifyLicenseText(text);
  return r.ok ? r : null;
}

function licenseStatus() {
  const lic = currentLicense();
  const tr = trialInfo();
  const trialActive = !lic && tr.active;      // 正式授权优先，没有授权才看试用
  return {
    ok: true,
    machine: machineCode(),
    licensed: !!lic || trialActive,
    trial: trialActive,
    trialDaysLeft: tr.daysLeft,
    trialEnd: tr.end,
    features: lic ? lic.features : (trialActive ? FEATURES.slice() : []),
    exp: lic ? lic.exp : null,
    contact: SELLER_CONTACT,
    file: licPath()
  };
}

ipcMain.handle('license:status', function () { return licenseStatus(); });

ipcMain.handle('license:activate', function (e, text) {
  const r = verifyLicenseText(text);
  if (!r.ok) return { ok: false, error: r.error };
  try {
    fs.mkdirSync(path.dirname(licPath()), { recursive: true });
    fs.writeFileSync(licPath(), r.code + '\n', 'utf8');
    return licenseStatus();
  } catch (err) {
    return { ok: false, error: '保存授权失败：' + String((err && err.message) || err) };
  }
});

/* ---- 文档密码上锁 ----
   一本书一个 4 位密码，只存密码哈希；文件在 userData\doclocks.json。
   键是书名（文件名），换文件夹也能认出来。没授权不能"新增"锁，
   但已有锁的书照样能输密码打开、也能解锁（解锁=移除锁，不受授权限制）。 */

function docLockPath() { return path.join(app.getPath('userData'), 'doclocks.json'); }

function readDocLocks() {
  try { return JSON.parse(fs.readFileSync(docLockPath(), 'utf8')) || {}; }
  catch (e) { return {}; }
}
function writeDocLocks(o) {
  fs.mkdirSync(path.dirname(docLockPath()), { recursive: true });
  fs.writeFileSync(docLockPath(), JSON.stringify(o || {}), 'utf8');
}

ipcMain.handle('doclock:get', function (e, key) {
  const locks = readDocLocks();
  return { ok: true, lock: locks[String(key || '')] || null };
});

ipcMain.handle('doclock:list', function () {
  return { ok: true, locks: readDocLocks() };
});

ipcMain.handle('doclock:set', function (e, p) {
  const key = String((p && p.key) || '');
  const h = String((p && p.h) || '');
  if (!key) return { ok: false, error: '没有书名，没法上锁' };
  if (!/^[0-9a-f]{8,64}$/.test(h)) return { ok: false, error: '密码校验值不合法' };
  try {
    const locks = readDocLocks();
    locks[key] = { h: h, name: String((p && p.name) || key), ts: Date.now() };
    writeDocLocks(locks);
    return { ok: true, lock: locks[key] };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('doclock:clear', function (e, key) {
  try {
    const locks = readDocLocks();
    delete locks[String(key || '')];
    writeDocLocks(locks);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* ---- 笔记上锁 ----
   只存密码哈希 + 加密用的 salt；真正的密钥由页面用 PBKDF2 从密码派生，
   主进程不接触明文，也不接触密钥。 */

function noteLockPath() { return path.join(app.getPath('userData'), 'notelock.json'); }

ipcMain.handle('notelock:get', function () {
  try {
    const o = JSON.parse(fs.readFileSync(noteLockPath(), 'utf8')) || {};
    return { ok: true, enabled: !!o.enabled, h: String(o.h || ''), salt: String(o.salt || '') };
  } catch (e) {
    return { ok: true, enabled: false, h: '', salt: '' };
  }
});

ipcMain.handle('notelock:set', function (e, p) {
  const h = String((p && p.h) || '');
  const salt = String((p && p.salt) || '');
  if (!/^[0-9a-f]{8,64}$/.test(h)) return { ok: false, error: '密码校验值不合法' };
  if (!/^[0-9a-f]{16,64}$/.test(salt)) return { ok: false, error: '加密参数不合法' };
  try {
    fs.mkdirSync(path.dirname(noteLockPath()), { recursive: true });
    fs.writeFileSync(noteLockPath(), JSON.stringify({ enabled: true, h: h, salt: salt }), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('notelock:clear', function () {
  try {
    fs.writeFileSync(noteLockPath(), JSON.stringify({ enabled: false }), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

let win = null;

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const w = Math.min(1280, Math.max(900, Math.round(area.width * 0.82)));
  const h = Math.min(900, Math.max(620, Math.round(area.height * 0.88)));

  win = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 720,
    minHeight: 480,
    title: '极简阅读器',
    backgroundColor: '#fafbfc',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,                    // Electron 20+ 默认沙箱会掐掉 preload 的 require，桥接会静默失效
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.removeMenu();                       // Win7 上藏掉菜单栏，界面更干净
  win.loadURL('app://./index.html');
  win.once('ready-to-show', function () { win.show(); });

  // 页面里的外链交给系统浏览器，别在应用里跳
  win.webContents.on('will-navigate', function (e, url) {
    if (url && url.indexOf('app://') !== 0) { e.preventDefault(); shell.openExternal(url); }
  });
  win.webContents.setWindowOpenHandler(function (details) {
    if (details && details.url) shell.openExternal(details.url);
    return { action: 'deny' };
  });

  win.on('closed', function () { win = null; });
}

app.whenReady().then(function () {
  protocol.registerFileProtocol('app', function (req, cb) {
    let p = decodeURIComponent(req.url.replace(/^app:\/\//i, '').split('?')[0].split('#')[0]);
    if (p === '' || p === '/' || p === './') p = 'index.html';
    if (p.indexOf('./') === 0) p = p.slice(2);
    cb({ path: path.join(__dirname, p) });
  });

  createWindow();

  // 系统锁屏 / 睡眠 / 唤醒：三种都往页面推一次"锁上"
  ['lock-screen', 'suspend', 'resume'].forEach(function (ev) {
    try {
      powerMonitor.on(ev, function () { tellLock(ev); });
    } catch (e) {}
  });

  /* 兜底：个别系统（老版本 Windows）不一定把锁屏事件报上来，
     那就每隔几秒问一次系统空闲状态，从"没锁"变成 "locked" 时补发一次。
     只在状态跳变时发，避免锁屏期间反复打扰页面。 */
  let lastIdle = '';
  setInterval(function () {
    let st = 'unknown';
    try { st = powerMonitor.getSystemIdleState(60) || 'unknown'; } catch (e) { return; }
    if (st === 'locked' && lastIdle !== 'locked') tellLock('idle-locked');
    lastIdle = st;
  }, 4000);

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', function () { app.quit(); });
