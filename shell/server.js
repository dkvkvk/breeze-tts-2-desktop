'use strict';
/* 本地 UI 服务：静态资源 + /api 反代 + /local/* 控制面。纯 Node，无 Electron 依赖。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { createAgentApi } = require('./agent-api');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml'
};

function json(res, body, code) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(code || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((ok, bad) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => ok(Buffer.concat(chunks)));
    req.on('error', bad);
  });
}

function readDesignPresets(file) {
  try {
    const presets = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(presets) || !presets.every(preset =>
      preset && typeof preset.name === 'string' && typeof preset.instruction === 'string')) {
      throw new Error('预设文件格式无效');
    }
    return presets;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

function writeDesignPresets(file, presets) {
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(presets, null, 2) + '\n', 'utf8');
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/* /api/xxx -> 后端 /v1/xxx 的显式映射（其余按 /api/ -> /v1/ 替换） */
function upstreamPath(p) {
  if (p === '/api/health') return '/health';
  if (p === '/api/speech') return '/v1/audio/speech';
  if (p === '/api/convert') return '/v1/audio/convert';
  if (p.startsWith('/api/voices')) return '/v1/voices' + p.slice('/api/voices'.length);
  return p.replace('/api/', '/v1/');
}

function proxy(req, res, url, srvPort) {
  const up = upstreamPath(url.pathname);
  const opts = {
    host: '127.0.0.1', port: srvPort, path: up + (url.search || ''), method: req.method,
    headers: { ...req.headers, host: '127.0.0.1:' + srvPort }
  };
  delete opts.headers['accept-encoding'];
  delete opts.headers['connection'];

  const upReq = http.request(opts, upRes => {
    const headers = { ...upRes.headers, 'Cache-Control': 'no-store' };
    delete headers['transfer-encoding'];
    delete headers['connection'];
    res.writeHead(upRes.statusCode || 502, headers);
    upRes.on('error', error => res.destroy(error));
    upRes.pipe(res);
  });
  res.once('close', () => {
    if (!res.writableEnded) upReq.destroy();
  });
  upReq.setTimeout(600000, () => upReq.destroy(new Error('upstream timeout')));
  upReq.on('error', e => {
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    json(res, { error: '后端未就绪: ' + e.message }, 502);
  });
  req.pipe(upReq);
}

function serveStatic(res, uiDir, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.join(uiDir, rel);
  if (!file.startsWith(uiDir)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}

function start(opts) {
  const { uiDir, srvPort, backend, hooks } = opts;
  const agentApi = createAgentApi({ token: opts.agentToken ?? process.env.VOICETRACK_AGENT_TOKEN, uiDir, backend, srvPort, json });
  let port = opts.port || 18080;
  let server = null;

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    try {
      if (p.startsWith('/api/v1/')) return agentApi(req, res, p);
      if (p.startsWith('/api/')) return proxy(req, res, url, srvPort);
      if (p === '/local/status') return json(res, backend.status());
      if (p === '/local/design-presets') {
        const file = path.join(backend.getPaths().dataRoot, 'design-presets.json');
        if (req.method === 'GET') return json(res, readDesignPresets(file));
        if (req.method === 'POST') {
          if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
            return json(res, { error: '预设必须使用 JSON 格式' }, 415);
          }
          const raw = await readBody(req);
          let body;
          try { body = JSON.parse(raw); }
          catch (e) { return json(res, { error: '预设格式无效' }, 400); }
          const name = typeof body?.name === 'string' ? body.name.trim() : '';
          const instruction = typeof body?.instruction === 'string' ? body.instruction.trim() : '';
          if (!name || name.length > 60) return json(res, { error: '请输入 1–60 字的预设名称' }, 400);
          if (!instruction || instruction.length > 8192) {
            return json(res, { error: '请输入 1–8192 字的音色描述' }, 400);
          }
          const presets = readDesignPresets(file);
          if (presets.some(preset => preset.name === name)) {
            return json(res, { error: '已有同名预设，请换一个名称' }, 409);
          }
          presets.push({ name, instruction });
          writeDesignPresets(file, presets);
          return json(res, presets, 201);
        }
        if (req.method === 'DELETE') {
          const name = url.searchParams.get('name');
          const presets = readDesignPresets(file);
          const remaining = presets.filter(preset => preset.name !== name);
          if (remaining.length === presets.length) return json(res, { error: '找不到该预设' }, 404);
          writeDesignPresets(file, remaining);
          return json(res, remaining);
        }
        return json(res, { error: '不支持的请求方法' }, 405);
      }
      if (p === '/local/models') return json(res, {
        models: backend.listModels(),
        catalog: backend.CATALOG,
        mirrors: backend.MIRRORS.map(m => m.name),
        active: backend.getPaths().modelPath,
        modelsDir: backend.getPaths().modelsDir
      });
      if (p === '/local/model-use' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        return json(res, backend.useModel(body.path || body.file));
      }
      if (p === '/local/download' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        return json(res, backend.startDownload(body.id || body.file));
      }
      if (p === '/local/download-stop' && req.method === 'POST') return json(res, backend.stopDownload());
      if (p === '/local/quit' && req.method === 'POST') { json(res, { ok: true }); setTimeout(() => hooks && hooks.quit && hooks.quit(), 200); return; }
      if (p === '/local/pick-model' && req.method === 'POST') {
        const ok = hooks && hooks.pickModel ? await hooks.pickModel() : false;
        return json(res, { ok, status: backend.status() });
      }
      if (p === '/local/voices-dir' && req.method === 'POST') { hooks && hooks.openVoices && hooks.openVoices(); return json(res, { ok: true }); }
      if (p === '/local/logs-dir' && req.method === 'POST') { hooks && hooks.openLogs && hooks.openLogs(); return json(res, { ok: true }); }
      return serveStatic(res, uiDir, p);
    } catch (e) {
      try { json(res, { error: e.message }, 500); } catch (x) { }
    }
  };

  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryBind = () => {
      attempts++;
      const s = http.createServer(handler);
      s.on('error', err => {
        if (err.code === 'EADDRINUSE' && attempts < 40) { port++; tryBind(); return; }
        reject(err);
      });
      s.listen(port, '127.0.0.1', () => { server = s; resolve({ server: s, port }); });
    };
    tryBind();
  });
}

module.exports = { start, upstreamPath };
