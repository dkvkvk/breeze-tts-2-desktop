'use strict';

const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');
const { createChapterJobs, JobError } = require('./chapter-jobs');
const { createChapterAI } = require('./chapter-ai');

const maxBody = 1024 * 1024;

function equalToken(expected, received) {
  const bytes = Buffer.from(received);
  return bytes.length === expected.length && timingSafeEqual(expected, bytes);
}

async function jsonBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new JobError(415, 'invalid_content_type', '请以 JSON 提交任务。');
  }
  const chunks = [];
  let size = 0;
  for await (const part of req.iterator({ destroyOnReturn: false })) {
    size += part.byteLength;
    if (size > maxBody) {
      req.resume();
      throw new JobError(413, 'payload_too_large', '请求超过体积限制。');
    }
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch (error) { throw new JobError(400, 'invalid_json', '请求 JSON 无效。'); }
}

function createAgentApi({ token, desktopToken, uiDir, backend, srvPort, json, foregroundBusy, secureStorage }) {
  const enabled = typeof token === 'string' && token.length >= 24;
  const tokenBytes = Buffer.from(enabled ? token : '');
  const desktopBytes = Buffer.from(desktopToken || '');
  const infer = 'http://127.0.0.1:' + srvPort;
  let jobs;
  let chapter;
  let audio;
  let chapterAI;

  function init() {
    if (jobs) return;
    chapter = require(path.resolve(uiDir, 'chapter.js'));
    audio = require(path.resolve(uiDir, 'longform.js'));
    jobs = createChapterJobs({
      root: path.join(backend.getPaths().dataRoot, 'chapter-jobs'),
      chapter, audio,
      modelPath: () => backend.getPaths().modelPath || '',
      request: async (piece, signal) => {
        const form = new FormData();
        form.append('text', piece.text);
        if (piece.voiceId) form.append('voice_id', piece.voiceId);
        if (piece.instruction) form.append('instruction', piece.instruction);
        const upstreamSignal = AbortSignal.any([signal, AbortSignal.timeout(600000)]);
        // An aborted HTTP request can leave the engine finishing that turn in the background.
        while (true) {
          const response = await fetch(infer + '/v1/audio/speech', { method: 'POST', body: form, signal: upstreamSignal });
          if (response.status !== 409) return response;
          await response.body?.cancel();
          await sleep(500, undefined, { signal: upstreamSignal });
        }
      }
    });
  }

  async function listVoices() {
    try {
      const upstream = await fetch(infer + '/v1/voices', { signal: AbortSignal.timeout(5000) });
      if (!upstream.ok) throw new Error('Voice list unavailable');
      const voices = await upstream.json();
      return voices.filter(voice => voice.saved);
    } catch {
      throw new JobError(503, 'engine_unavailable', '请先加载配音模型，读取可用音色。');
    }
  }

  function initAI() {
    chapterAI ??= createChapterAI({
      root: backend.getPaths().dataRoot,
      chapter: require(path.resolve(uiDir, 'chapter.js')),
      secureStorage,
      listVoices: async () => (await listVoices()).map(({ id, metadata }) => ({
        id, name: typeof metadata?.display_name === 'string' ? metadata.display_name : id
      }))
    });
    return chapterAI;
  }

  function checkOrigin(req) {
    const host = req.headers.host;
    const allowed = ['127.0.0.1:' + req.socket.localPort, 'localhost:' + req.socket.localPort];
    if (!allowed.includes(host) || (req.headers.origin && !allowed.some(entry => req.headers.origin === 'http://' + entry))) {
      throw new JobError(403, 'invalid_origin', '接口仅接受本机请求。');
    }
  }

  function check(req) {
    const desktop = req.headers['x-voicetrack-desktop'];
    if (desktopBytes.length && typeof desktop === 'string' && equalToken(desktopBytes, desktop)) return 'desktop';
    if (!enabled) throw new JobError(404, 'agent_disabled', '本机 Agent 接口尚未启用。');
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || !equalToken(tokenBytes, auth.slice(7))) {
      throw new JobError(401, 'invalid_token', '请提供有效的访问令牌。');
    }
    return 'agent';
  }

  function normalize(body) {
    if (typeof body?.text !== 'string') return body;
    return {
      title: body.title,
      includeSpeakers: body.includeSpeakers,
      pauseMs: body.pauseMs ?? 500,
      roles: [{ id: chapter.narratorId, name: '旁白', voiceId: body.voiceId ?? '', instruction: body.instruction ?? '' }],
      segments: [{ speakerId: chapter.narratorId, text: body.text }]
    };
  }

  function checkAvailable() {
    if (!backend.status().serverReady) throw new JobError(503, 'engine_unavailable', '请先在应用中加载模型。');
    if (foregroundBusy?.()) throw new JobError(409, 'foreground_active', '请等当前语音合成结束后再提交章节。');
  }

  async function sendArtifact(res, id, name, options) {
    const bytes = await jobs.artifact(id, name, options);
    res.writeHead(200, {
      'Content-Type': name === 'chapter.wav' ? 'audio/wav' : 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + name + '"',
      'Content-Length': bytes.byteLength,
      'Cache-Control': 'no-store'
    });
    return res.end(bytes);
  }

  async function handle(req, res, url) {
    try {
      const pathname = url.pathname;
      const method = req.method;
      checkOrigin(req);
      if (pathname === '/api/v1/chapter-review' && ['GET', 'POST'].includes(method)) {
        const bearer = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization || '')?.[1];
        if (!bearer) throw new JobError(401, 'invalid_token', '请提供单章授权令牌。');
        const ai = initAI();
        if (method === 'GET') return json(res, ai.read(bearer));
        return json(res, ai.submit(bearer, await jsonBody(req)));
      }
      const origin = check(req);
      if (pathname.startsWith('/api/v1/chapter-ai/') && origin === 'desktop') {
        const ai = initAI();
        const action = pathname.slice('/api/v1/chapter-ai/'.length);
        if (action === 'settings' && method === 'GET') return json(res, ai.settings());
        if (action === 'settings' && method === 'PUT') return json(res, ai.saveSettings(await jsonBody(req)));
        if (action === 'suggest' && method === 'POST') {
          const body = await jsonBody(req);
          const controller = new AbortController();
          res.once('close', () => controller.abort());
          return json(res, await ai.suggest(body, controller.signal));
        }
        if (action === 'share' && method === 'POST') return json(res, await ai.share(await jsonBody(req)), 201);
        if (action === 'share' && method === 'GET') return json(res, ai.review(req.headers['x-voicetrack-review']));
        if (action === 'share' && method === 'DELETE') return json(res, { revoked: ai.revoke(req.headers['x-voicetrack-review']) });
      }
      if (pathname === '/api/v1/health' && method === 'GET') {
        const status = backend.status();
        return json(res, { apiVersion: 1, modelPresent: status.modelPresent, serverReady: status.serverReady });
      }
      if (pathname === '/api/v1/voices' && method === 'GET') {
        return json(res, (await listVoices()).map(({ id }) => ({ id })));
      }
      if (pathname === '/api/v1/jobs' && method === 'POST') {
        init();
        const body = normalize(await jsonBody(req));
        const draft = origin === 'desktop' && body?.draft === true;
        if (!draft) checkAvailable();
        const id = req.headers['idempotency-key'];
        return json(res, jobs.create(body, id, { origin, draft }), draft ? 201 : 202);
      }
      if (pathname === '/api/v1/jobs' && method === 'GET' && origin === 'desktop') {
        init();
        return json(res, jobs.list());
      }
      const route = pathname.match(/^\/api\/v1\/jobs\/([^/]+)(?:\/(cancel|resume|artifacts|project|partial|preview)(?:\/([^/]+))?)?$/);
      if (route) {
        init();
        const [, id, action, filename] = route;
        if (!action && method === 'GET') return json(res, jobs.status(id));
        if (!action && method === 'PATCH' && origin === 'desktop') {
          const body = await jsonBody(req);
          const draft = body?.draft === true;
          if (!draft) checkAvailable();
          return json(res, jobs.revise(id, body, draft), draft ? 200 : 202);
        }
        if (origin === 'desktop' && method === 'GET') {
          if (action === 'project' && !filename) return json(res, jobs.project(id));
          if (action === 'preview' && /^(0|[1-9]\d{0,2})$/.test(filename || '')) {
            return await sendArtifact(res, id, 'chapter.wav', { segment: Number(filename) });
          }
          if (action === 'partial' && filename) {
            return await sendArtifact(res, id, filename, { partial: true, speakers: url.searchParams.get('speakers') === '1' });
          }
        }
        if (action === 'cancel' && method === 'POST' && !filename) return json(res, jobs.cancel(id));
        if (action === 'resume' && method === 'POST' && !filename) {
          checkAvailable();
          return json(res, jobs.resume(id));
        }
        if (action === 'artifacts' && method === 'GET') {
          if (!filename) {
            const job = jobs.status(id);
            return json(res, job.artifacts.map(name => ({ name, path: '/api/v1/jobs/' + id + '/artifacts/' + name })));
          }
          return await sendArtifact(res, id, filename);
        }
      }
      throw new JobError(404, 'route_not_found', 'API 路径不存在。');
    } catch (error) {
      if (res.destroyed) return;
      if (error instanceof JobError) return json(res, { code: error.code, error: error.message }, error.status);
      return json(res, { code: 'request_failed', error: '本机服务无法处理请求。' }, 500);
    }
  }
  return { handle, isBusy: () => jobs?.isBusy() ?? false };
}

module.exports = { createAgentApi };
