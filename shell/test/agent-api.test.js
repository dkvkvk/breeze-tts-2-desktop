'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { start } = require('../server');
const { splitSelection } = require('../../src/ui/chapter');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

test('authenticated chapter API resumes stored audio on restart and exports role subtitles', { timeout: 10000 }, async t => {
  const baseDir = path.resolve(os.tmpdir());
  const dataRoot = fs.mkdtempSync(path.join(baseDir, 'voicetrack-api-test-'));
  assert.equal(path.dirname(dataRoot), baseDir);
  assert.match(path.basename(dataRoot), /^voicetrack-api-test-[a-zA-Z0-9]+$/);
  const clients = [];
  let failOnce = true;
  let engineBusy = false;
  const calls = [];
  const token = 'test-token-only-0000000000';
  const desktopToken = 'test-desktop-only-0000000000';
  const upstream = http.createServer(async (req, res) => {
    try {
      if (req.url === '/v1/voices') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify([{ id: 'voice-linxia', saved: true }, { id: 'temp', saved: false }]));
      }
      const buffers = [];
      for await (const buffer of req) buffers.push(buffer);
      const form = await new Request('http://localhost/', {
        method: 'POST', headers: req.headers, body: Buffer.concat(buffers)
      }).formData();
      const text = form.get('text');
      if (engineBusy) {
        engineBusy = false;
        res.writeHead(409);
        return res.end('busy');
      }
      calls.push([text, form.get('voice_id')]);
      if (text === '门开了。' && failOnce) {
        failOnce = false;
        res.writeHead(503);
        return res.end('try later');
      }
      res.writeHead(200, { 'Content-Type': 'audio/pcm' });
      return res.end(Buffer.alloc(48000, calls.length));
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  t.after(async () => {
    for (const server of [...clients, upstream]) {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');

  async function boot(agentToken) {
    const { port, server } = await start({
      port: 32220 + clients.length, srvPort: upstream.address().port, agentToken, desktopToken,
      uiDir: path.resolve(__dirname, '../../src/ui'),
      backend: {
        getPaths: () => ({ dataRoot, modelPath: 'demo.gguf' }),
        status: () => ({ modelPresent: true, serverReady: true })
      }
    });
    clients.push(server);
    return {
      server, port,
      desktop: (suffix, options = {}) => fetch('http://127.0.0.1:' + port + '/api/v1' + suffix, {
        ...options, headers: { 'X-VoiceTrack-Desktop': desktopToken, Connection: 'close', ...options.headers }
      }),
      send: (suffix, options = {}) => fetch('http://127.0.0.1:' + port + '/api/v1' + suffix, {
        ...options, headers: { Authorization: 'Bearer ' + token, Connection: 'close', ...options.headers }
      })
    };
  }

  async function until(client, id, state) {
    const limit = Date.now() + 3000;
    while (Date.now() < limit) {
      const response = await client.send('/jobs/' + id);
      const job = await response.json();
      if (job.state === state) return job;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.fail('Job never reached the requested state: ' + state);
  }

  const disabled = await boot('');
  assert.equal((await disabled.send('/health')).status, 404);
  const client = await boot(token);
  const draftResponse = await disabled.desktop('/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '待核对', source: '“你好。”', ranges: [[1, 4]], mode: 'novel', draft: true, pauseMs: 500,
      roles: [{ id: 'narrator', name: '旁白', voiceId: '', instruction: '' }],
      segments: [{ speakerId: null, text: '你好。' }]
    })
  });
  assert.equal(draftResponse.status, 201);
  const draftId = (await draftResponse.json()).id;
  assert.equal((await client.send('/health', { headers: { Authorization: 'Bearer incorrect' } })).status, 401);
  assert.equal((await client.send('/health', { headers: { Origin: 'https://external.example' } })).status, 403);
  assert.deepEqual(await (await client.send('/voices')).json(), [{ id: 'voice-linxia' }]);

  const spec = {
    pauseMs: 250,
    includeSpeakers: true,
    roles: [{ id: 'narrator', name: '旁白', voiceId: '', instruction: '' },
      { id: 'linxia', name: '林夏', voiceId: 'voice-linxia', instruction: '' }],
    segments: [{ speakerId: 'narrator', text: '下雨了。' }, { speakerId: 'linxia', text: '门开了。' }]
  };
  const submit = (payload, key = 'test-chapter') => client.send('/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(payload)
  });
  const created = await submit(spec);
  assert.equal(created.status, 202);
  const id = (await created.json()).id;
  assert.equal((await (await submit(spec)).json()).id, id);
  assert.equal((await submit({ ...spec, pauseMs: 1000 })).status, 409);
  assert.equal((await submit({ ...spec, segments: [{ text: '未确认', speakerId: null }] }, 'bad-chapter')).status, 400);
  const failed = await until(client, id, 'failed');
  assert.equal(failed.completed, 1);
  assert.equal((await client.send('/jobs/' + id + '/artifacts/chapter.wav')).status, 404);

  const manifestPath = path.join(dataRoot, 'chapter-jobs', id, 'job.json');
  const interrupted = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  interrupted.state = 'running';
  fs.writeFileSync(manifestPath, JSON.stringify(interrupted));
  client.server.closeAllConnections();
  await new Promise(resolve => client.server.close(resolve));
  const restarted = await boot(token);
  assert.equal((await (await restarted.send('/jobs/' + id)).json()).state, 'interrupted');
  const jobRoute = '/jobs/' + id;
  const readDraft = await (await restarted.desktop('/jobs/' + draftId + '/project')).json();
  assert.equal(readDraft.job.state, 'draft');
  assert.equal(readDraft.editor.source, '“你好。”');
  assert.deepEqual(readDraft.editor.ranges, [[1, 4]]);
  assert.equal(readDraft.chapter.segments[0].speakerId, null);
  assert.equal((await restarted.send('/jobs')).status, 404);
  assert.equal((await restarted.send(jobRoute + '/project')).status, 404);
  assert.equal((await restarted.desktop('/jobs', { headers: { Origin: 'https://external.example' } })).status, 403);
  const projects = await (await restarted.desktop('/jobs')).json();
  assert.equal(projects.find(project => project.id === id).source, 'agent');
  assert.equal(projects.find(project => project.id === draftId).source, 'desktop');
  const project = await (await restarted.desktop(jobRoute + '/project')).json();
  assert.deepEqual(project.chapter.segments, spec.segments);
  assert.deepEqual(project.job.readySegments, [0]);
  const partial = Buffer.from(await (await restarted.desktop(jobRoute + '/partial/chapter.wav')).arrayBuffer());
  assert.equal(partial.readUInt32LE(40), 48000);
  engineBusy = true;
  await restarted.desktop(jobRoute + '/resume', { method: 'POST' });
  const complete = await until(restarted, id, 'complete');
  assert.equal(complete.completed, 2);
  assert.equal(engineBusy, false);
  assert.deepEqual(calls, [['下雨了。', null], ['门开了。', 'voice-linxia'], ['门开了。', 'voice-linxia']]);

  const list = await (await restarted.send('/jobs/' + id + '/artifacts')).json();
  assert.deepEqual(list.map(item => item.name), ['chapter.wav', 'chapter.srt']);
  const wavRes = await restarted.send('/jobs/' + id + '/artifacts/chapter.wav');
  assert.equal(wavRes.headers.get('content-type'), 'audio/wav');
  const wav = Buffer.from(await wavRes.arrayBuffer());
  assert.equal(wav.readUInt32LE(40), 108000);
  const srt = await (await restarted.send('/jobs/' + id + '/artifacts/chapter.srt')).text();
  assert.match(srt, /00:00:01,250 --> 00:00:02,250\r\n林夏：门开了。/);
  assert.equal((await restarted.send('/jobs/' + id + '/artifacts/private.txt')).status, 404);

  const changed = { ...spec, title: '同一个章节', segments: [spec.segments[0],
    { speakerId: 'linxia', text: '门已经开了。' }], redoSegment: 1 };
  const edited = await restarted.desktop(jobRoute, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changed)
  });
  assert.equal(edited.status, 202);
  assert.equal((await edited.json()).id, id);
  assert.deepEqual((await until(restarted, id, 'complete')).readySegments, [0, 1]);
  assert.deepEqual(calls.slice(3), [['门已经开了。', 'voice-linxia']]);
  const preview = Buffer.from(await (await restarted.desktop(jobRoute + '/preview/0')).arrayBuffer());
  assert.deepEqual(preview.subarray(44), wav.subarray(44, 48044));
  const revisedSrt = await (await restarted.send(jobRoute + '/artifacts/chapter.srt')).text();
  assert.match(revisedSrt, /00:00:01,250 --> 00:00:02,250\r\n林夏：门已经开了。/);

  const renamed = await (await restarted.desktop(jobRoute, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...changed, title: '改名后的章节', draft: true })
  })).json();
  assert.equal(renamed.state, 'complete');
  assert.equal(renamed.title, '改名后的章节');
  assert.deepEqual(renamed.readySegments, [0, 1]);

  const preserved = Buffer.from(await (await restarted.desktop(jobRoute + '/preview/1')).arrayBuffer());
  const split = splitSelection(changed.segments, 0, 0, 2, 'linxia');
  const editedSelection = await restarted.desktop(jobRoute, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...spec, segments: split })
  });
  assert.equal(editedSelection.status, 202);
  assert.deepEqual((await until(restarted, id, 'complete')).readySegments, [0, 1, 2]);
  assert.deepEqual(calls.slice(4), [['下雨', 'voice-linxia'], ['了。', null]]);
  const shifted = Buffer.from(await (await restarted.desktop(jobRoute + '/preview/2')).arrayBuffer());
  assert.deepEqual(shifted, preserved);

  const mcp = new Client({ name: 'chapter-api-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(__dirname, '../agent/voicetrack-mcp.cjs')],
    env: { VOICETRACK_AGENT_TOKEN: token, VOICETRACK_API_BASE: 'http://127.0.0.1:' + restarted.port + '/' }
  });
  t.after(() => mcp.close());
  await mcp.connect(transport);
  assert((await mcp.listTools()).tools.some(tool => tool.name === 'breeze_create_job'));
  const queued = await mcp.callTool({
    name: 'breeze_create_job', arguments: { text: '由 Agent 提交。', title: 'MCP 单音色章节', requestId: 'test-mcp' }
  });
  assert(!queued.isError, JSON.stringify(queued));
  const agentId = queued.structuredContent.result.id;
  await until(restarted, agentId, 'complete');
  const status = await mcp.callTool({ name: 'breeze_get_job', arguments: { id: agentId } });
  assert.equal(status.structuredContent.result.state, 'complete');
  assert.equal(status.structuredContent.result.title, 'MCP 单音色章节');
  const assets = await mcp.callTool({ name: 'breeze_get_artifacts', arguments: { id: agentId } });
  const wavUrl = assets.structuredContent.result.find(item => item.name === 'chapter.wav').url;
  const downloaded = await fetch(wavUrl, { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(downloaded.status, 200);
  assert.equal(Buffer.from(await downloaded.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');
});
