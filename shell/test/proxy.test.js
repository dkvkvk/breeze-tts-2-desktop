'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { test } = require('node:test');
const { start } = require('../server');

test('stopping a client stream closes its inference request', { timeout: 5000 }, async t => {
  const closed = Promise.withResolvers();
  const upstream = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/audio/speech');
    res.once('close', closed.resolve);
    req.resume();
    res.writeHead(200, { 'Content-Type': 'audio/pcm' });
    res.write(Buffer.from([0, 0]));
  });
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  const { server, port } = await start({ port: 32190, srvPort: upstream.address().port });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const controller = new AbortController();
  const response = await fetch('http://127.0.0.1:' + port + '/api/speech', {
    method: 'POST', body: 'test', signal: controller.signal
  });
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, new Uint8Array([0, 0]));
  controller.abort();
  await assert.rejects(reader.read(), { name: 'AbortError' });
  await closed.promise;
});
