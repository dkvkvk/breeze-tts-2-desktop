'use strict';
/* 后端进程管理 + 模型下载。不依赖 Electron，可单独用 node 跑通自测。 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VERSION = '2.0.1';
const MODEL_FILE = 'breeze-tts-2-q4_k.gguf';
const MODEL_URLS = [
  'https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp/resolve/main/' + MODEL_FILE,
  'https://hf-mirror.com/HoppouAI/Breeze-TTS-2.cpp/resolve/main/' + MODEL_FILE
];

const state = {
  serverReady: false, starting: false, backend: '', lastLine: '',
  downloading: false, dlBytes: 0, dlTotal: 0, speedText: '', dlError: '',
  serverLog: []
};

let paths = null;
let child = null;
let pollTimer = null;

function init(opts) {
  const dataDir = opts.dataDir;
  paths = {
    runtime: opts.runtime,
    dataDir,
    voicesDir: path.join(dataDir, 'voices'),
    logsDir: path.join(dataDir, 'logs'),
    modelPath: null,
    srvPort: opts.srvPort || 18099
  };
  for (const d of [paths.dataDir, paths.voicesDir, paths.logsDir]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (e) { log('mkdir ' + d + ' failed: ' + e.message); }
  }
  paths.modelPath = findModel() || path.join(paths.dataDir, 'models', MODEL_FILE);
  try { fs.mkdirSync(path.dirname(paths.modelPath), { recursive: true }); } catch (e) { }
  return paths;
}

/* 模型查找顺序：环境变量 -> model-path.txt -> 各 models 目录（先认标准文件名，再认任意 .gguf） */
function findModel() {
  const cands = [];
  if (process.env.BREEZE_MODEL) cands.push(process.env.BREEZE_MODEL);
  try {
    const marker = fs.readFileSync(path.join(paths.dataDir, 'model-path.txt'), 'utf8').split(/\r?\n/)[0].trim();
    if (marker) cands.push(marker);
  } catch (e) { }
  for (const dir of [path.join(paths.dataDir, 'models'), path.join(paths.runtime, 'models'), paths.runtime]) {
    cands.push(path.join(dir, MODEL_FILE));
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

function status() {
  let bytes = 0;
  try { if (modelPresent()) bytes = fs.statSync(paths.modelPath).size; } catch (e) { }
  return {
    version: VERSION,
    serverPort: paths ? paths.srvPort : 0,
    modelPresent: modelPresent(),
    modelBytes: bytes,
    modelTotal: state.dlTotal,
    downloading: state.downloading,
    downloadBytes: state.dlBytes,
    speedText: state.speedText,
    serverReady: state.serverReady,
    starting: state.starting,
    backend: state.backend,
    error: state.dlError,
    message: state.lastLine
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

/* ---------------- 模型下载：断点续传 + 双源回退 ---------------- */
function startDownload() {
  if (state.downloading) return;
  state.downloading = true;
  state.dlError = '';
  downloadWorker().then(() => { state.downloading = false; state.speedText = ''; })
    .catch(e => { state.dlError = e.message || String(e); state.downloading = false; state.speedText = ''; });
}

async function downloadWorker() {
  const part = paths.modelPath + '.part';
  let have = 0;
  try { if (fs.existsSync(part)) have = fs.statSync(part).size; } catch (e) { }
  let lastErr = null;
  for (let round = 0; round < 6; round++) {
    const url = MODEL_URLS[round % MODEL_URLS.length];
    try {
      if (await fetchTo(url, part, () => { try { return fs.statSync(part).size; } catch (e) { return 0; } })) {
        state.dlBytes = fs.statSync(part).size;
        try { if (fs.existsSync(paths.modelPath)) fs.unlinkSync(paths.modelPath); } catch (e) { }
        fs.renameSync(part, paths.modelPath);
        log('model downloaded: ' + paths.modelPath);
        start();
        return true;
      }
    } catch (e) {
      lastErr = e;
      log('download failed (' + url + '): ' + e.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw lastErr || new Error('所有下载源均失败');
}

async function fetchTo(url, part, haveFn) {
  const have = haveFn();
  const headers = { 'User-Agent': 'BreezeTTS2/' + VERSION };
  if (have > 0) headers.Range = 'bytes=' + have + '-';
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
  const startAt = res.status === 206 ? have : 0;
  const len = Number(res.headers.get('content-length') || 0);
  state.dlTotal = startAt + len;
  state.dlBytes = startAt;
  if (startAt === 0 && have > 0) { try { fs.unlinkSync(part); } catch (e) { } }

  const out = fs.createWriteStream(part, { flags: startAt ? 'a' : 'w' });
  const reader = res.body.getReader();
  let clock = Date.now(), mark = state.dlBytes;
  try {
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      await new Promise((ok, bad) => out.write(Buffer.from(value), e => e ? bad(e) : ok()));
      state.dlBytes += value.length;
      if (Date.now() - clock > 900) {
        state.speedText = ((state.dlBytes - mark) / 1048576 / ((Date.now() - clock) / 1000)).toFixed(1) + ' MB/s';
        clock = Date.now(); mark = state.dlBytes;
      }
    }
  } finally {
    await new Promise(ok => out.end(ok));
  }
  if (state.dlTotal > 0 && state.dlBytes < state.dlTotal) throw new Error('传输中断（已保留进度，可续传）');
  return true;
}

module.exports = { init, getPaths, status, start, stop, startDownload, modelPresent, log, VERSION, MODEL_FILE, state };
