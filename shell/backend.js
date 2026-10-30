'use strict';
/* 后端进程管理 + 模型切换 + 多源下载。不依赖 Electron，可单独用 node 跑通自测。 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VERSION = '2.1.1';
const DEFAULT_FILE = 'breeze-tts-2-q4_k.gguf';

/* 官方 HoppouAI/Breeze-TTS-2.cpp 的 7 个量化档，字节数取自 HF 文件树 */
const CATALOG = [
  { id: 'q4_k-dd2', file: 'breeze-tts-2-q4_k-dd2.gguf', size: 2460266176, label: 'Q4_K · dd2', note: '体积最小，短句最快；超过约 45 秒声音会发闷' },
  { id: 'q4_k', file: 'breeze-tts-2-q4_k.gguf', size: 2538909376, label: 'Q4_K · 推荐', note: '体积与质量最平衡，低配机器首选' },
  { id: 'q6_k', file: 'breeze-tts-2-q6_k.gguf', size: 3069969664, label: 'Q6_K · 质量优先', note: '质量明显更好，速度慢约 20%' },
  { id: 'q8_0-dd2', file: 'breeze-tts-2-q8_0-dd2.gguf', size: 3322429120, label: 'Q8_0 · dd2', note: '接近无损，比纯 Q8_0 小一点' },
  { id: 'q8_0-dd4', file: 'breeze-tts-2-q8_0-dd4.gguf', size: 3401072320, label: 'Q8_0 · dd4', note: 'dd4 更激进，比 dd2 再快一些' },
  { id: 'q8_0', file: 'breeze-tts-2-q8_0.gguf', size: 3568844480, label: 'Q8_0 · 接近无损', note: '实用档里质量最好的一档' },
  { id: 'f16', file: 'breeze-tts-2-f16.gguf', size: 6279630784, label: 'F16 · 原始精度', note: '无量化损失，最慢，吃内存' }
];

/* 三个都实测能返回文件内容（206）。顺序即优先级，慢了自己换下一个。 */
const MIRRORS = [
  { name: 'HuggingFace', base: 'https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp/resolve/main/' },
  { name: 'hf-mirror', base: 'https://hf-mirror.com/HoppouAI/Breeze-TTS-2.cpp/resolve/main/' },
  { name: 'hf-mirror.net', base: 'https://hf-mirror.net/HoppouAI/Breeze-TTS-2.cpp/resolve/main/' }
];

const MIN_SPEED = 200 * 1024;   /* 低于这个速度就考虑换源 */
const SLOW_ROUNDS = 3;          /* 连续 3 个采样窗口都慢才换，避免误判 */
const SAMPLE_MS = 1500;

const state = {
  serverReady: false, starting: false, backend: '', lastLine: '',
  dlFile: '', dlMirror: '', dlBytes: 0, dlTotal: 0, dlSpeed: 0,
  dlFallbacks: 0, dlError: '', downloading: false,
  serverLog: []
};

let paths = null;
let child = null;
let pollTimer = null;
let dlAbort = null;
let dlStopFlag = false;

function init(opts) {
  const root = opts.dataRoot || opts.dataDir;
  paths = {
    runtime: opts.runtime,
    dataRoot: root,
    modelsDir: path.join(root, 'models'),
    voicesDir: path.join(root, 'voices'),
    logsDir: path.join(root, 'logs'),
    cacheDir: path.join(root, 'cache'),
    markerFile: path.join(root, 'model-path.txt'),
    modelPath: null,
    srvPort: opts.srvPort || 18099
  };
  for (const d of [paths.modelsDir, paths.voicesDir, paths.logsDir]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { log('mkdir ' + d + ' failed: ' + e.message); }
  }
  paths.modelPath = findModel() || path.join(paths.modelsDir, DEFAULT_FILE);
  return paths;
}

/* 模型查找顺序：环境变量 -> model-path.txt -> 各 models 目录（先认标准文件名，再认任意 .gguf） */
function findModel() {
  const cands = [];
  if (process.env.BREEZE_MODEL) cands.push(process.env.BREEZE_MODEL);
  try {
    const marker = fs.readFileSync(paths.markerFile, 'utf8').split(/\r?\n/)[0].trim();
    if (marker) cands.push(marker);
  } catch (e) { }
  for (const dir of [paths.modelsDir, path.join(paths.runtime, 'models'), paths.runtime]) {
    cands.push(path.join(dir, DEFAULT_FILE));
    try {
      for (const f of fs.readdirSync(dir)) if (/\.gguf$/i.test(f)) cands.push(path.join(dir, f));
    } catch (e) { }
  }
  return cands.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
}

function log(text) {
  const line = new Date().toISOString().slice(0, 19) + '  ' + text + '\n';
  for (const p of [paths && path.join(paths.logsDir, 'launcher.log'), paths && path.join(paths.runtime, 'launcher.log')]) {
    if (!p) continue;
    try { fs.appendFileSync(p, line, 'utf8'); return; } catch (e) { }
  }
}

function getPaths() { return paths; }
function modelPresent() { try { return fs.existsSync(paths.modelPath); } catch (e) { return false; } }
function sizeOf(p) { try { return fs.statSync(p).size; } catch (e) { return 0; } }

/* ---------------- 模型列表 / 切换 ---------------- */
function scanDir(dir, out) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return; }
  for (const n of names) {
    if (!/\.gguf$/i.test(n)) continue;
    const full = path.join(dir, n);
    const bytes = sizeOf(full);
    if (!bytes) continue;
    if (out.some(x => x.path.toLowerCase() === full.toLowerCase())) continue;
    const known = CATALOG.find(c => c.file.toLowerCase() === n.toLowerCase());
    out.push({
      file: n, path: full, bytes,
      label: known ? known.label : n.replace(/\.gguf$/i, ''),
      note: known ? known.note : '本地文件',
      known: !!known,
      active: paths.modelPath && full.toLowerCase() === paths.modelPath.toLowerCase()
    });
  }
}

function listModels() {
  const out = [];
  scanDir(paths.modelsDir, out);
  /* 当前模型若在别处（用户自己挑的路径），把它所在目录也列出来 */
  if (paths.modelPath) scanDir(path.dirname(paths.modelPath), out);
  scanDir(path.join(paths.runtime, 'models'), out);
  scanDir(paths.runtime, out);
  out.sort((a, b) => b.bytes - a.bytes);
  return out;
}

/* 切换模型：写 model-path.txt，重启后端 */
function useModel(fileOrPath) {
  if (!fileOrPath) return { ok: false, error: '没有指定文件' };
  let full = fileOrPath;
  if (!path.isAbsolute(full)) full = path.join(paths.modelsDir, fileOrPath);
  if (!fs.existsSync(full)) return { ok: false, error: '文件不存在: ' + full };
  if (!/\.gguf$/i.test(full)) return { ok: false, error: '只支持 .gguf' };

  stop();
  paths.modelPath = full;
  try { fs.writeFileSync(paths.markerFile, full + '\r\n', 'utf8'); } catch (e) { log('写 model-path.txt 失败: ' + e.message); }
  state.backend = '';
  state.lastLine = '';
  log('model switched to ' + full);
  start();
  return { ok: true, model: full };
}

/* ---------------- 后端进程 ---------------- */
function status() {
  const bytes = modelPresent() ? sizeOf(paths.modelPath) : 0;
  return {
    version: VERSION,
    serverPort: paths ? paths.srvPort : 0,
    modelPresent: modelPresent(),
    modelFile: paths && paths.modelPath ? path.basename(paths.modelPath) : '',
    modelPath: paths ? paths.modelPath : '',
    modelBytes: bytes,
    modelsDir: paths ? paths.modelsDir : '',
    serverReady: state.serverReady,
    starting: state.starting,
    backend: state.backend,
    message: state.lastLine,
    /* 兼容旧字段 */
    modelTotal: state.dlTotal,
    downloading: state.downloading,
    downloadBytes: state.dlBytes,
    speedText: state.dlSpeed ? state.dlSpeed.toFixed(1) + ' MB/s' : '',
    error: state.dlError,
    download: {
      file: state.dlFile,
      mirror: state.dlMirror,
      bytes: state.dlBytes,
      total: state.dlTotal,
      speed: state.dlSpeed,
      fallbacks: state.dlFallbacks,
      error: state.dlError,
      running: state.downloading
    },
    log: state.serverLog.slice(-12)
  };
}

function note(line) {
  if (!line) return;
  state.lastLine = line;
  state.serverLog.push(new Date().toTimeString().slice(0, 8) + ' ' + line);
  if (state.serverLog.length > 300) state.serverLog.shift();
  if (!state.backend && /vulkan/i.test(line)) state.backend = 'Vulkan';
  if (/CPU backend/i.test(line)) state.backend = 'CPU';
}

function serverExe() { return path.join(paths.runtime, 'breeze-server.exe'); }

function start() {
  if (state.serverReady || state.starting) return;
  if (!modelPresent()) return;
  if (!fs.existsSync(serverExe())) { note('找不到 breeze-server.exe: ' + serverExe()); return; }
  state.starting = true;
  stop(true);

  const args = [paths.modelPath, '--port', String(paths.srvPort), '--host', '127.0.0.1',
    '--no-warmup', '--voices-dir', paths.voicesDir];
  log('spawn ' + serverExe() + ' ' + args.join(' '));
  try {
    child = spawn(serverExe(), args, { cwd: paths.runtime, windowsHide: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => String(d).split(/\r?\n/).forEach(note));
    child.stderr.on('data', d => String(d).split(/\r?\n/).forEach(note));
    child.on('exit', (code) => { state.serverReady = false; state.starting = false; log('server exited code=' + code); });
  } catch (e) {
    log('spawn failed: ' + e.message);
    state.starting = false;
    return;
  }
  pollHealth();
}

function pollHealth() {
  if (pollTimer) clearTimeout(pollTimer);
  let tries = 0;
  const tick = async () => {
    tries++;
    try {
      const r = await fetch('http://127.0.0.1:' + paths.srvPort + '/health', { signal: AbortSignal.timeout(1500) });
      if (r.ok) { state.serverReady = true; state.starting = false; log('backend ready on ' + paths.srvPort); return; }
    } catch (e) { }
    if (!child || child.exitCode !== null) { state.starting = false; return; }
    if (tries > 900) { state.starting = false; log('backend health timeout'); return; }
    pollTimer = setTimeout(tick, 500);
  };
  pollTimer = setTimeout(tick, 400);
}

function stop(quiet) {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (child) {
    try { child.kill(); } catch (e) { }
    child = null;
    if (!quiet) log('backend stopped');
  }
  state.serverReady = false;
  state.starting = false;
}

/* ---------------- 下载：多源 + 慢速自动切换 + 断点续传 ---------------- */
function startDownload(fileOrId) {
  if (state.downloading) return { ok: false, error: '已有下载在进行' };
  const item = CATALOG.find(c => c.id === fileOrId || c.file === fileOrId)
    || CATALOG.find(c => c.file === DEFAULT_FILE);
  if (!item) return { ok: false, error: '未知模型' };

  state.dlFile = item.file;
  state.dlBytes = 0;
  state.dlTotal = item.size;
  state.dlSpeed = 0;
  state.dlFallbacks = 0;
  state.dlError = '';
  state.dlMirror = '';
  state.downloading = true;
  dlStopFlag = false;

  downloadWorker(item).then(() => { state.downloading = false; state.dlSpeed = 0; })
    .catch(e => {
      state.dlError = (e && e.message) || String(e);
      state.downloading = false;
      state.dlSpeed = 0;
    });
  return { ok: true, file: item.file };
}

function stopDownload() {
  dlStopFlag = true;
  if (dlAbort) { try { dlAbort.abort(); } catch (e) { } }
  state.downloading = false;
  state.dlSpeed = 0;
  state.dlError = '已取消';
  return { ok: true };
}

async function downloadWorker(item) {
  const dest = path.join(paths.modelsDir, item.file);
  const part = dest + '.part';
  let lastErr = null;
  let mirrorIdx = 0;
  const maxAttempts = MIRRORS.length * 3;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (dlStopFlag) throw new Error('已取消');
    const mirror = MIRRORS[mirrorIdx % MIRRORS.length];
    state.dlMirror = mirror.name;
    try {
      await fetchTo(mirror.base + item.file, part, item.size);
      try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (e) { }
      fs.renameSync(part, dest);
      log('model downloaded: ' + dest);
      state.dlBytes = sizeOf(dest);
      state.dlSpeed = 0;
      /* 下完就切过去，省得用户再点一次 */
      useModel(dest);
      return true;
    } catch (e) {
      if (dlStopFlag) throw new Error('已取消');
      lastErr = e;
      state.dlFallbacks++;
      log('download 换源 (' + mirror.name + '): ' + e.message);
      mirrorIdx++;
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  throw lastErr || new Error('所有下载源均失败');
}

/* 单源下载：边下边测速，连续慢就抛错让外层换源；进度写入 .part 可续传 */
async function fetchTo(url, part, expectSize) {
  const have = sizeOf(part);
  const headers = { 'User-Agent': 'BreezeTTS2/' + VERSION };
  if (have > 0) headers.Range = 'bytes=' + have + '-';

  dlAbort = new AbortController();
  const res = await fetch(url, { headers, redirect: 'follow', signal: dlAbort.signal });
  if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);

  const startAt = res.status === 206 ? have : 0;
  if (startAt === 0 && have > 0) { try { fs.unlinkSync(part); } catch (e) { } }
  state.dlBytes = startAt;
  state.dlTotal = expectSize || (startAt + Number(res.headers.get('content-length') || 0));

  const out = fs.createWriteStream(part, { flags: startAt ? 'a' : 'w' });
  const reader = res.body.getReader();
  let windowBytes = 0, windowStart = Date.now(), slowRounds = 0;

  try {
    for (; ;) {
      if (dlStopFlag) throw new Error('已取消');
      const { done, value } = await reader.read();
      if (done) break;
      await new Promise((ok, bad) => out.write(Buffer.from(value), e => e ? bad(e) : ok()));
      state.dlBytes += value.length;
      windowBytes += value.length;

      const dt = Date.now() - windowStart;
      if (dt >= SAMPLE_MS) {
        const speed = windowBytes / (dt / 1000);
        state.dlSpeed = speed / 1048576;
        windowBytes = 0;
        windowStart = Date.now();

        /* 已经下了不少就不折腾，只在前段判断慢 */
        const early = state.dlTotal === 0 || state.dlBytes < state.dlTotal * 0.5;
        if (early && speed < MIN_SPEED) {
          slowRounds++;
          if (slowRounds >= SLOW_ROUNDS) throw new Error('速度过慢（' + (speed / 1024).toFixed(0) + ' KB/s），切换下载源');
        } else {
          slowRounds = 0;
        }
      }
    }
  } finally {
    await new Promise(ok => out.end(ok));
    dlAbort = null;
  }

  const got = sizeOf(part);
  if (expectSize && got < expectSize) throw new Error('传输中断（已保留 ' + (got / 1e9).toFixed(2) + ' GB，可续传）');
  return true;
}

module.exports = {
  init, getPaths, status, start, stop, listModels, useModel,
  startDownload, stopDownload, modelPresent, log,
  VERSION, CATALOG, MIRRORS, DEFAULT_FILE, state
};
