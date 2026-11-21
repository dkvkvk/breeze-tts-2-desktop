'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');

const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const statuses = new Set(['queued', 'running', 'complete', 'canceled', 'failed', 'interrupted']);
const hash = value => createHash('sha256').update(value).digest('hex');

class JobError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function atomicWrite(target, value) {
  const temp = target + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, value);
    fs.renameSync(temp, target);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function createChapterJobs({ root, chapter, audio, request, modelPath }) {
  fs.mkdirSync(root, { recursive: true });
  const jobs = new Map();
  let active = null;
  const folder = id => path.join(root, id);
  const manifest = id => path.join(folder(id), 'job.json');
  const partPath = (id, key) => path.join(folder(id), hash(key) + '.pcm');
  const save = job => atomicWrite(manifest(job.id), JSON.stringify(job));
  const pending = () => [...jobs.values()].find(job => job.state === 'queued');
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
    try {
      const record = JSON.parse(fs.readFileSync(manifest(entry.name), 'utf8'));
      if (record.version !== 1 || record.id !== entry.name || !statuses.has(record.state)) continue;
      chapter.prepare(record.chapter);
      if (['running', 'queued'].includes(record.state)) {
        record.state = 'interrupted';
        record.currentSegment = null;
        save(record);
      }
      jobs.set(record.id, record);
    } catch (error) { /* A damaged record is left on disk for recovery. */ }
  }

  function get(id) {
    const job = jobs.get(id);
    if (!job) throw new JobError(404, 'job_not_found', '找不到该任务。');
    return job;
  }

  function describe(job) {
    const total = chapter.prepare(job.chapter).length;
    return { id: job.id, state: job.state, completed: job.completed, total,
      currentSegment: job.currentSegment ?? null, createdAt: job.createdAt, error: job.error ?? null,
      artifacts: job.state === 'complete' ? ['chapter.wav', 'chapter.srt'] : [] };
  }

  function loadParts(job, pieces) {
    const clips = new Map();
    let bytes = 0;
    for (const piece of pieces) {
      const candidate = partPath(job.id, piece.key);
      try {
        const stat = fs.lstatSync(candidate);
        if (!stat.isFile() || !stat.size || stat.size % 2 || stat.size > audio.maxSamples * 2 - bytes) continue;
        const buffer = fs.readFileSync(candidate);
        if (buffer.byteLength !== stat.size) continue;
        bytes += buffer.byteLength;
        clips.set(piece.key, { chunks: [buffer], samples: buffer.byteLength / 2 });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return clips;
  }

  async function pump() {
    if (active) return;
    const job = pending();
    if (!job) return;
    const controller = new AbortController();
    active = { id: job.id, controller };
    try {
      job.state = 'running';
      const pieces = chapter.prepare(job.chapter);
      const clips = loadParts(job, pieces);
      const stored = new Set(clips.keys());
      job.completed = clips.size;
      save(job);
      if (job.model !== modelPath()) throw new Error('当前模型与任务原用模型不同，请切回原模型后继续。');
      await chapter.synthesize(pieces, clips, job.chapter.pauseMs, request, controller.signal, index => {
        for (const [key, clip] of clips) {
          if (stored.has(key)) continue;
          atomicWrite(partPath(job.id, key), Buffer.concat(clip.chunks));
          stored.add(key);
        }
        job.completed = stored.size;
        job.currentSegment = index === null ? null : index + 1;
        save(job);
      });
      const time = chapter.timeline(pieces, clips, job.chapter.pauseMs, job.includeSpeakers);
      const wav = audio.wav(time.completed, time.gapSamples);
      atomicWrite(path.join(folder(job.id), 'chapter.wav'), Buffer.from(await wav.arrayBuffer()));
      atomicWrite(path.join(folder(job.id), 'chapter.srt'), audio.srt(time.completed));
      job.state = controller.signal.aborted ? 'canceled' : 'complete';
      job.error = null;
    } catch (error) {
      job.state = controller.signal.aborted ? 'canceled' : 'failed';
      job.error = controller.signal.aborted ? null : String(error.message || error).slice(0, 300);
    } finally {
      job.currentSegment = null;
      try { save(job); }
      catch (error) { job.state = 'failed'; job.error = '无法写入任务记录。'; }
      active = null;
      queueMicrotask(pump);
    }
  }

  function create(input, requestId) {
    try { chapter.prepare(input); }
    catch (error) { throw new JobError(400, 'invalid_chapter', error.message); }
    if (requestId && !/^[\w-]{1,128}$/.test(requestId)) {
      throw new JobError(400, 'invalid_request_id', '请求标识格式无效。');
    }
    const includeSpeakers = input.includeSpeakers === true;
    const chapterData = {
      pauseMs: input.pauseMs,
      roles: input.roles.map(({ id, name, voiceId, instruction }) => ({ id, name, voiceId, instruction })),
      segments: input.segments.map(({ text, speakerId }) => ({ text, speakerId }))
    };
    const fingerprint = hash(JSON.stringify([chapterData, includeSpeakers]));
    if (requestId) {
      const existing = [...jobs.values()].find(job => job.requestId === requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new JobError(409, 'request_conflict', '该请求标识已用于另一份任务。');
        return describe(existing);
      }
    }
    if ([...jobs.values()].filter(job => job.state === 'queued').length >= 20) {
      throw new JobError(429, 'queue_full', '队列已满，请稍后再试。');
    }
    const id = randomUUID();
    const record = { version: 1, id, chapter: chapterData, includeSpeakers, model: modelPath(),
      requestId, fingerprint, state: 'queued', completed: 0, createdAt: new Date().toISOString() };
    fs.mkdirSync(folder(id));
    save(record);
    jobs.set(id, record);
    queueMicrotask(pump);
    return describe(record);
  }

  function cancel(id) {
    const job = get(id);
    if (active?.id === id && job.state === 'running') active.controller.abort();
    if (job.state === 'queued') {
      job.state = 'canceled';
      save(job);
    }
    return describe(job);
  }

  function resume(id) {
    const job = get(id);
    if (['complete', 'queued', 'running'].includes(job.state)) return describe(job);
    if (job.model !== modelPath()) throw new JobError(409, 'model_changed', '请切回任务原用模型。');
    job.error = null;
    job.state = 'queued';
    save(job);
    queueMicrotask(pump);
    return describe(job);
  }

  async function artifact(id, name) {
    const job = get(id);
    if (job.state !== 'complete' || !['chapter.wav', 'chapter.srt'].includes(name)) {
      throw new JobError(404, 'artifact_not_found', '该任务的产物尚不可用。');
    }
    return readFile(path.join(folder(job.id), name));
  }

  return { create, cancel, resume, status: id => describe(get(id)), artifact };
}

module.exports = { createChapterJobs, JobError };
