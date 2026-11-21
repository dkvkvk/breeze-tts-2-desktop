'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const chapter = require('../../src/ui/chapter');
const { start } = require('../server');

const input = {
  title: '夜雨', pauseMs: 500,
  roles: [{ id: 'narrator', name: '旁白', voiceId: '', instruction: '' },
    { id: 'hero', name: '许舟', voiceId: 'user-custom', instruction: '轻声' }],
  segments: [
    { space: 'kept', text: '门外有人。', speakerId: 'narrator' },
    { text: '我来开门。', speakerId: null },
    { text: '等等。', speakerId: 'hero' }
  ]
};

const plan = {
  roles: [{ id: 'narrator', voiceId: 'voicetrack-narrator' },
    { id: 'hero', voiceId: 'voicetrack-narrator' },
    { id: 'ai-1', name: '林岚', voiceId: 'voicetrack-young-woman' }],
  marks: [{ index: 1, speakerId: 'ai-1' }]
};

test('one-click voices fill gaps and keep existing selections and instructions', () => {
  const roles = structuredClone(input.roles);
  roles.push({ id: 'extra', name: '林岚', voiceId: '', instruction: '自然' });
  assert.equal(chapter.fillDefaultVoices(roles, chapter.defaultVoices), 2);
  assert.deepEqual(roles.map(({ voiceId }) => voiceId),
    ['voicetrack-narrator', 'user-custom', 'voicetrack-young-woman']);
  assert.equal(roles[2].instruction, '自然');
  assert.equal(chapter.fillDefaultVoices(roles, chapter.defaultVoices), 0);
});

test('OpenCode uses the configured provider and a scoped MCP token only opens the chosen chapter', { timeout: 15000 }, async t => {
  const baseDir = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(baseDir, 'voicetrack-ai-test-'));
  assert.equal(path.dirname(root), baseDir);
  assert.match(path.basename(root), /^voicetrack-ai-test-[a-zA-Z0-9]+$/);
  const key = 'mock-provider-key';
  const desktopToken = 'desktop-token-only-for-test';
  const encrypted = Buffer.from('encrypted-test-fixture');
  let providerRequest;
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/v1/voices') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(chapter.defaultVoices.map(id => ({ id, saved: true }))));
    }
    if (req.url !== '/compatible/v1/chat/completions') {
      res.writeHead(404);
      return res.end();
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    providerRequest = {
      auth: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
    };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const choice of [
      { index: 0, delta: { role: 'assistant', content: JSON.stringify(plan) }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: 'stop' }
    ]) {
      res.write('data: ' + JSON.stringify({
        id: 'mock-chat', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [choice]
      }) + '\n\n');
    }
    return res.end('data: [DONE]\n\n');
  });
  let server;
  const mcp = new Client({ name: 'chapter-review-test', version: '1.0.0' });
  t.after(async () => {
    await mcp.close();
    for (const listener of [server, upstream]) {
      if (!listener?.listening) continue;
      listener.closeAllConnections();
      await new Promise(resolve => listener.close(resolve));
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const bound = await start({
    port: 32380, srvPort: upstream.address().port, agentToken: '', desktopToken,
    uiDir: path.resolve(__dirname, '../../src/ui'),
    backend: { getPaths: () => ({ dataRoot: root }) },
    secureStorage: {
      isEncryptionAvailable: () => true,
      encryptString: value => { assert.equal(value, key); return encrypted; },
      decryptString: value => { assert.deepEqual(value, encrypted); return key; }
    }
  });
  server = bound.server;
  const base = 'http://127.0.0.1:' + bound.port;
  const api = (route, method, body, headers) => fetch(base + '/api/v1/' + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const desktop = (route, method = 'GET', body, headers) =>
    api('chapter-ai/' + route, method, body, { 'X-VoiceTrack-Desktop': desktopToken, ...headers });
  assert.equal((await api('chapter-ai/settings', 'GET')).status, 404);
  const baseURL = 'http://127.0.0.1:' + upstream.address().port + '/compatible/v1';
  const configured = await desktop('settings', 'PUT', { baseURL, model: 'test-model', apiKey: key });
  assert.equal(configured.status, 200);
  assert.deepEqual(await configured.json(), { baseURL, model: 'test-model', hasKey: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'ai-provider.json'), 'utf8')).encryptedKey, encrypted.toString('base64'));

  const suggested = await desktop('suggest', 'POST', input);
  const cleanPlan = await suggested.json();
  assert.equal(suggested.status, 200, JSON.stringify(cleanPlan));
  assert.deepEqual(cleanPlan.roles.map(role => role.id), ['narrator', 'ai-1']);
  assert.deepEqual(cleanPlan.marks, plan.marks);
  assert.equal(providerRequest.auth, 'Bearer ' + key);
  assert.equal(providerRequest.body.model, 'test-model');
  const forwarded = JSON.parse(providerRequest.body.messages.find(message => message.role === 'user').content);
  assert.deepEqual(forwarded.segments[1], { index: 1, text: '我来开门。', speakerId: null });

  const { token } = await (await desktop('share', 'POST', input)).json();
  const owner = { 'X-VoiceTrack-Review': token };
  const bearer = { Authorization: 'Bearer ' + token };
  assert.equal((await api('health', 'GET', undefined, bearer)).status, 404);
  assert.equal((await api('chapter-review', 'GET', undefined, { ...bearer, Origin: 'https://outside.example' })).status, 403);
  assert.equal((await api('chapter-review', 'POST', { roles: [], marks: [{ index: 2, speakerId: 'hero' }] }, bearer)).status, 400);
  assert.equal(await (await desktop('share', 'GET', undefined, owner)).json(), null);

  await mcp.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(__dirname, '../agent/voicetrack-mcp.cjs')],
    env: { VOICETRACK_API_BASE: base + '/' }
  }));
  const read = await mcp.callTool({ name: 'breeze_read_chapter_review', arguments: { token } });
  assert.equal(read.structuredContent.result.title, input.title);
  const submit = await mcp.callTool({ name: 'breeze_submit_chapter_review', arguments: { token, ...plan } });
  assert.equal(submit.structuredContent.result.received, true);
  assert.deepEqual(await (await desktop('share', 'GET', undefined, owner)).json(), cleanPlan);
  assert.equal((await desktop('share', 'DELETE', undefined, owner)).status, 200);
  assert.equal((await api('chapter-review', 'GET', undefined, bearer)).status, 404);
});
