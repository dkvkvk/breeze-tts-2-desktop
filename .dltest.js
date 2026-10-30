const path = require('path');
const fs = require('fs');
const http = require('http');
const backend = require('./shell/backend');

const SIZE = 6 * 1048576;

function slowServer(rateBps) {
  return new Promise(res => {
    const s = http.createServer((req, rep) => {
      rep.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': SIZE });
      let sent = 0;
      const tick = setInterval(() => {
        if (sent >= SIZE) { clearInterval(tick); rep.end(); return; }
        const n = Math.min(rateBps, SIZE - sent);
        rep.write(Buffer.alloc(n, 7));
        sent += n;
      }, 1000);
      req.on('close', () => clearInterval(tick));
    });
    s.listen(0, '127.0.0.1', () => res({ server: s, port: s.address().port }));
  });
}
function fastServer() {
  return new Promise(res => {
    const s = http.createServer((req, rep) => {
      rep.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': SIZE });
      rep.end(Buffer.alloc(SIZE, 9));
    });
    s.listen(0, '127.0.0.1', () => res({ server: s, port: s.address().port }));
  });
}

(async () => {
  const out = [];
  const ok = (n, c, x) => out.push((c ? 'PASS' : 'FAIL') + ' | ' + n + (x ? ' | ' + x : ''));

  const slow = await slowServer(30 * 1024);   // 30 KB/s，低于 200 KB/s 阈值
  const fast = await fastServer();

  const root = path.join(__dirname, '.dltest');
  fs.rmSync(root, { recursive: true, force: true });
  backend.init({ runtime: 'D:\\Breeze TTS 2\\resources\\runtime', dataRoot: root, srvPort: 18099 });

  backend.MIRRORS.length = 0;
  backend.MIRRORS.push({ name: '慢源', base: 'http://127.0.0.1:' + slow.port + '/' });
  backend.MIRRORS.push({ name: '快源', base: 'http://127.0.0.1:' + fast.port + '/' });
  backend.CATALOG.push({ id: 'probe', file: 'probe.bin', size: SIZE });

  backend.startDownload('probe');
  const t0 = Date.now();
  let sawSlow = false, sawFast = false;
  while (Date.now() - t0 < 120000) {
    const d = backend.status().download;
    if (d.mirror === '慢源') sawSlow = true;
    if (d.mirror === '快源') sawFast = true;
    if (!d.running) break;
    await new Promise(x => setTimeout(x, 400));
  }
  const d = backend.status().download;
  const done = fs.existsSync(path.join(root, 'models', 'probe.bin'));

  ok('先用了慢源', sawSlow);
  ok('慢源被判超时并切走', sawFast, '切换 ' + d.fallbacks + ' 次');
  ok('最终由快源下完', done, done ? (fs.statSync(path.join(root, 'models', 'probe.bin')).size / 1048576).toFixed(1) + ' MB' : '未完成');
  ok('完成后状态为未运行', d.running === false);

  slow.server.close(); fast.server.close();
  backend.stop();
  fs.rmSync(root, { recursive: true, force: true });
  console.log('\n=== 慢速切换自测 ===\n' + out.join('\n'));
  process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0);
})();
