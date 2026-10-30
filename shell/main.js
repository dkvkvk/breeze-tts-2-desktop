'use strict';
/* Breeze TTS 2 桌面端主进程：窗口 / 托盘 / 菜单 / 单实例 / 后端生命周期 */
const { app, BrowserWindow, Tray, Menu, shell, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const backend = require('./backend');
const uiServer = require('./server');

const SELFTEST = process.argv.includes('--selftest');
const DEV = !app.isPackaged;

let win = null;
let tray = null;
let uiPort = 0;
let paths = null;
let quitting = false;

function runtimeDir() {
  if (!DEV) return path.join(process.resourcesPath, 'runtime');
  return process.env.BREEZE_RUNTIME || 'D:\\Breeze TTS 2\\resources\\runtime';
}

function uiDir() {
  const packed = path.join(__dirname, 'ui');
  return fs.existsSync(packed) ? packed : path.join(__dirname, '..', 'src', 'ui');
}

function iconPath() {
  const cands = [path.join(__dirname, 'assets', 'icon.ico'), path.join(__dirname, '..', 'assets', 'icon.ico')];
  return cands.find(p => fs.existsSync(p));
}

/* 所有数据只放安装目录：模型 / 音色 / 日志 / Chromium 缓存都不落 C 盘用户目录 */
function dataRoot() {
  if (process.env.BREEZE_DATA) return process.env.BREEZE_DATA;
  return app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..', '.data');
}

/* 把旧版（C# 外壳、数据在 %LOCALAPPDATA%）的音色与模型路径带过来 */
function migrateLegacy(root) {
  const legacy = path.join(process.env.LOCALAPPDATA || '', 'BreezeTTS2');
  if (!legacy || !fs.existsSync(legacy)) return;
  try {
    const src = path.join(legacy, 'voices');
    const dst = path.join(root, 'voices');
    if (fs.existsSync(src)) {
      const files = fs.readdirSync(src);
      const empty = !fs.existsSync(dst) || fs.readdirSync(dst).length === 0;
      if (empty && files.length) {
        fs.mkdirSync(dst, { recursive: true });
        for (const f of files) fs.copyFileSync(path.join(src, f), path.join(dst, f));
        backend.log('已迁移 ' + files.length + ' 个音色到 ' + dst);
      }
    }
    const oldMarker = path.join(legacy, 'model-path.txt');
    const newMarker = path.join(root, 'model-path.txt');
    if (fs.existsSync(oldMarker) && !fs.existsSync(newMarker)) {
      const target = fs.readFileSync(oldMarker, 'utf8').split(/\r?\n/)[0].trim();
      if (target && fs.existsSync(target)) {
        fs.writeFileSync(newMarker, target + '\r\n', 'utf8');
        backend.log('已接管旧模型路径 ' + target);
      }
    }
  } catch (e) { backend.log('迁移旧数据失败: ' + e.message); }
}

/* 让用户直接选本地 gguf，不必把 2.4 GB 挪来挪去 */
async function pickModel() {
  const r = await dialog.showOpenDialog(win, {
    title: '选择本地模型文件（.gguf）',
    properties: ['openFile'],
    defaultPath: paths ? paths.modelsDir : undefined,
    filters: [{ name: 'GGUF 模型', extensions: ['gguf'] }]
  });
  if (r.canceled || !r.filePaths.length) return false;
  backend.stop();
  const ok = backend.setModelPath(r.filePaths[0]);
  if (ok) backend.start();
  return ok;
}

/* Chromium 的缓存/GPUCache 也改到安装目录，别写 C 盘 */
try {
  const cache = path.join(dataRoot(), 'cache');
  fs.mkdirSync(cache, { recursive: true });
  app.setPath('userData', cache);
} catch (e) { }

/* ---------------- 单实例 ---------------- */
if (!SELFTEST) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { app.quit(); }
  app.on('second-instance', () => showWindow());
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '打开音色目录', click: () => shell.openPath(paths.voicesDir) },
        { label: '打开日志目录', click: () => shell.openPath(paths.logsDir) },
        { type: 'separator' },
        { label: '退出', accelerator: 'Alt+F4', click: () => { quitting = true; app.quit(); } }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', accelerator: 'Ctrl+R', click: () => win && win.reload() },
        { label: '开发者工具', accelerator: 'Ctrl+Shift+I', click: () => win && win.webContents.toggleDevTools() },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '接口说明', click: () => { showWindow(); win && win.webContents.executeJavaScript("document.getElementById('api-open').click()"); } },
        { label: '版本信息', click: () => dialog.showMessageBox(win, {
            type: 'info', title: 'Breeze TTS 2', message: 'Breeze TTS 2 ' + backend.VERSION,
            detail: 'Electron ' + process.versions.electron + ' / Chromium ' + process.versions.chrome +
              '\n模型：' + backend.MODEL_FILE + '\n后端端口：' + (paths ? paths.srvPort : '?') +
              '　界面端口：' + uiPort + '\n\n权重仅限研究与非商业用途。'
          }) }
      ]
    }
  ]);
}

function buildTray() {
  const icon = iconPath();
  if (!icon) return;
  tray = new Tray(nativeImage.createFromPath(icon));
  tray.setToolTip('Breeze TTS 2');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showWindow() },
    { type: 'separator' },
    { label: '打开音色目录', click: () => shell.openPath(paths.voicesDir) },
    { label: '打开日志目录', click: () => shell.openPath(paths.logsDir) },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => showWindow());
}

function createWindow(show) {
  win = new BrowserWindow({
    width: 1280, height: 880, minWidth: 960, minHeight: 640,
    show: false, backgroundColor: '#ffffff',
    title: 'Breeze TTS 2',
    icon: iconPath(),
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false }
  });
  win.once('ready-to-show', () => { if (show) win.show(); });
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://127.0.0.1:' + uiPort)) { e.preventDefault(); shell.openExternal(url); }
  });
  win.loadURL('http://127.0.0.1:' + uiPort + '/');
  return win;
}

async function boot() {
  const root = dataRoot();
  fs.mkdirSync(root, { recursive: true });
  paths = backend.init({ runtime: runtimeDir(), dataRoot: root, srvPort: 18099 });
  migrateLegacy(root);
  backend.log('Breeze TTS 2 ' + backend.VERSION + ' starting, data=' + root + ', runtime=' + paths.runtime);
  const bound = await uiServer.start({
    uiDir: uiDir(), port: 18080, srvPort: paths.srvPort, backend,
    hooks: {
      quit: () => { quitting = true; app.quit(); },
      openVoices: () => shell.openPath(paths.voicesDir),
      openLogs: () => shell.openPath(paths.logsDir),
      pickModel: pickModel
    }
  });
  uiPort = bound.port;
  backend.log('UI listening on ' + uiPort);
  backend.start();
}

/* ---------------- 自测：不需要显示器也能跑 ---------------- */
async function selftest() {
  const out = [];
  const check = (name, ok, extra) => out.push((ok ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : ''));
  try {
    fs.mkdirSync(dataRoot(), { recursive: true });
    paths = backend.init({ runtime: runtimeDir(), dataRoot: dataRoot(), srvPort: 18099 });
    check('路径解析', !!paths.modelPath, paths.modelPath);
    check('模型存在', backend.modelPresent(), fs.existsSync(paths.modelPath) ? (fs.statSync(paths.modelPath).size / 1e9).toFixed(2) + ' GB' : 'missing');
    const bound = await uiServer.start({ uiDir: uiDir(), port: 18080, srvPort: paths.srvPort, backend, hooks: {} });
    uiPort = bound.port;
    check('本地服务启动', uiPort > 0, 'port ' + uiPort);

    const st = await (await fetch('http://127.0.0.1:' + uiPort + '/local/status')).json();
    check('/local/status 字段完整', ['modelPresent', 'serverReady', 'version', 'serverPort'].every(k => k in st),
      'version=' + st.version + ' model=' + st.modelPresent);

    const md = await (await fetch('http://127.0.0.1:' + uiPort + '/local/models')).json();
    check('模型列表接口', Array.isArray(md.models) && md.models.length > 0, 'models=' + md.models.length + ' active=' + String(md.active || '').split(/[\\/]/).pop());
    check('下载档位目录', Array.isArray(md.catalog) && md.catalog.length === 7, 'catalog=' + (md.catalog || []).length);
    check('下载源列表', Array.isArray(md.mirrors) && md.mirrors.length >= 2, (md.mirrors || []).join('/'));
    const bad = await (await fetch('http://127.0.0.1:' + uiPort + '/local/model-use', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: 'no-such.gguf' })
    })).json();
    check('切换不存在文件被拒绝', bad.ok === false, bad.error || '');

    const idx = await fetch('http://127.0.0.1:' + uiPort + '/');
    check('静态页面可达', idx.ok, (await idx.text()).length + ' bytes');
    const js = await fetch('http://127.0.0.1:' + uiPort + '/audio.js');
    check('audio.js 可达', js.ok);

    if (backend.modelPresent()) {
      backend.start();
      const t0 = Date.now();
      while (Date.now() - t0 < 180000) {
        const s = backend.status();
        if (s.serverReady) break;
        await new Promise(r => setTimeout(r, 700));
      }
      const s2 = backend.status();
      check('后端就绪', s2.serverReady, 'backend=' + (s2.backend || '?'));
      if (s2.serverReady) {
        const v = await (await fetch('http://127.0.0.1:' + uiPort + '/api/voices')).json();
        check('反代 /api 可用', Array.isArray(v), 'voices=' + v.length);
      }
      createWindow(false);
      const w = win;
      await new Promise(r => w.webContents.once('did-finish-load', r));
      let booted = false;
      for (let i = 0; i < 60; i++) {
        booted = await w.webContents.executeJavaScript('!!document.getElementById("boot") && document.getElementById("boot").hidden === true');
        if (booted) break;
        await new Promise(r => setTimeout(r, 500));
      }
      check('界面完成启动进入主视图', booted === true);
      const info = await w.webContents.executeJavaScript(
        'JSON.stringify({api:document.getElementById("api-base").textContent, imp:!!document.getElementById("imp-drop"), count:document.getElementById("libCount").textContent})');
      const o = JSON.parse(info);
      check('API 地址已注入', o.api === ('http://127.0.0.1:' + uiPort + '/api'), o.api);
      check('导入音色区存在', o.imp === true);
      check('音色列表已渲染', typeof o.count === 'string', 'count=' + o.count);
      const mjson = await w.webContents.executeJavaScript(
        '(function(){var mo=document.getElementById("model-modal");if(mo.hidden)document.getElementById("model-open").click();' +
        'return new Promise(function(res){var n=0,t=setInterval(function(){' +
        'var l=document.querySelectorAll("#model-list .md-row").length;' +
        'var c=document.querySelectorAll("#model-catalog .md-row").length;' +
        'if((l>0&&c>0)||++n>25){clearInterval(t);' +
        'res(JSON.stringify({list:l,catalog:c,active:document.getElementById("model-active").textContent}));}},200);});})()');
      const mo = JSON.parse(mjson);
      check('模型弹窗列出本地模型', mo.list > 0, 'rows=' + mo.list + ' active=' + mo.active);
      check('模型弹窗列出下载档位', mo.catalog === 7, 'catalog=' + mo.catalog);
      backend.stop();
    }
  } catch (e) {
    check('自测异常', false, (e && e.message) || String(e));
  }
  console.log('\n=== SELFTEST ===\n' + out.join('\n'));
  app.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0);
}

if (SELFTEST) {
  app.whenReady().then(selftest);
} else {
  app.whenReady().then(async () => {
    try {
      await boot();
      Menu.setApplicationMenu(buildMenu());
      buildTray();
      createWindow(true);
    } catch (e) {
      dialog.showErrorBox('Breeze TTS 2 启动失败', (e && e.message) || String(e));
      app.quit();
    }
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') { quitting = true; app.quit(); } });
  app.on('before-quit', () => { if (tray) { tray.destroy(); tray = null; } backend.stop(); });
}
