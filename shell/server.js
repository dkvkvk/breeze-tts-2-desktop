'use strict';
/* 本地 UI 服务：静态资源 + /api 反代 + /local/* 控制面。纯 Node，无 Electron 依赖。 */
const http = require('http');
const fs = require('fs');
const path = require('path');

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
    upRes.pipe(res);
  });
  upReq.setTimeout(600000, () => upReq.destroy(new Error('upstream timeout')));
  upReq.on('error', e => {
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
  let port = opts.port || 18080;
  let server = null;

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    try {
      if (p.startsWith('/api/')) return proxy(req, res, url, srvPort);
      if (p === '/local/status') return json(res, backend.status());
      if (p === '/local/download' && req.method === 'POST') { backend.startDownload(); return json(res, { ok: true }); }
      if (p === '/local/quit' && req.method === 'POST') { json(res, { ok: true }); setTimeout(() => hooks && hooks.quit && hooks.quit(), 200); return; }
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
