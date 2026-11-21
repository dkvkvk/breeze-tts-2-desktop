'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');

const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const statuses = new Set(['draft', 'queued', 'running', 'complete', 'canceled', 'failed', 'interrupted']);
const artifactNames = ['chapter.wav', 'chapter.srt'];
const busy = job => job.state === 'queued' || job.state === 'running';
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

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !idPattern.test(entry.name)) continue;
    try {
      const record = JSON.parse(fs.readFileSync(manifest(entry.name), 'utf8'));
      if (record.version !== 1 || record.id !== entry.name || !statuses.has(record.state)) continue;
      if (record.state === 'draft') chapter.validate(record.chapter);
      else chapter.prepare(record.chapter);
      if (busy(record)) {
        record.state = 'interrupted';
        record.currentSegment = null;
        save(record);
      }
      jobs.set(record.id, record);
    } catch (error) { /* Keep unreadable records on disk for recovery. */ }
  }

  function get(id) {
    const job = jobs.get(id);
    if (!job) throw new JobError(404, 'job_not_found', '找不到该任务。');
    return job;
  }

  function chapterData(input, draft) {
    try { draft ? chapter.validate(input) : chapter.prepare(input); }
    catch (error) { throw new JobError(400, 'invalid_chapter', error.message); }
    return {
      pauseMs: input.pauseMs,
      roles: input.roles.map(({ id, name, voiceId, instruction }) => ({ id, name, voiceId, instruction })),
      segments: input.segments.map(({ text, speakerId, slot }) => ({ text, speakerId, slot }))
    };
  }

  function editorData(input) {
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 100) : '';
    const source = typeof input.source === 'string' ? input.source : '';
    if (source.length > audio.maxChars) throw new JobError(400, 'invalid_source', '章节原文超过长度限制。');
    return { title, source, mode: input.mode === 'novel' ? 'novel' : 'script' };
  }

  function ready(job) {
    const pieces = chapter.prepare(job.chapter);
    const counts = new Map();
    let completed = 0;
    let contiguous = 0;
    for (const [position, piece] of pieces.entries()) {
      const stat = fs.lstatSync(partPath(job.id, piece.key), { throwIfNoEntry: false });
      const available = stat?.isFile() && stat.size > 0 && stat.size % 2 === 0 && stat.size <= audio.maxSamples * 2;
      const value = counts.get(piece.segmentIndex) || { missing: false };
      if (available) {
        completed++;
        if (contiguous === position) contiguous++;
      } else value.missing = true;
      counts.set(piece.segmentIndex, value);
    }
    return {
      completed, total: pieces.length, hasPrefix: contiguous > 0,
      readySegments: [...counts].filter(([, entry]) => !entry.missing).map(([index]) => index)
    };
  }

  function describe(job, detail = true) {
    const summary = {
      id: job.id, state: job.state, title: job.editor?.title || '未命名章节',
      source: job.origin || 'agent', createdAt: job.createdAt, updatedAt: job.updatedAt || job.createdAt,
      currentSegment: job.currentSegment ?? null, error: job.error ?? null,
      artifacts: job.state === 'complete' ? artifactNames : []
    };
    if (!detail) return summary;
    if (job.state === 'draft') return { ...summary, completed: 0, total: 0, hasPrefix: false, readySegments: [] };
    return { ...summary, ...ready(job) };
  }

  function loadParts(job, pieces) {
    const clips = new Map();
    let bytes = 0;
    for (const piece of pieces) {
      const candidate = partPath(job.id, piece.key);
      const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
      if (!stat?.isFile() || !stat.size || stat.size % 2 || stat.size > audio.maxSamples * 2 - bytes) continue;
      const buffer = fs.readFileSync(candidate);
      if (buffer.byteLength !== stat.size) continue;
      bytes += buffer.byteLength;
      clips.set(piece.key, { chunks: [buffer], samples: buffer.byteLength / 2 });
    }
    return clips;
  }

  function discardSuperseded(job, pieces) {
    const wanted = new Set(pieces.map(piece => hash(piece.key) + '.pcm'));
    for (const entry of fs.readdirSync(folder(job.id), { withFileTypes: true })) {
      if (entry.isFile() && /^[a-f0-9]{64}\.pcm$/.test(entry.name) && !wanted.has(entry.name)) {
        fs.unlinkSync(path.join(folder(job.id), entry.name));
      }
    }
  }

  async function pump() {
    if (active) return;
    const job = [...jobs.values()].filter(job => job.state === 'queued')
      .sort((a, b) => String(a.queuedAt || a.createdAt).localeCompare(String(b.queuedAt || b.createdAt)))[0];
    if (!job) return;
    const controller = new AbortController();
    active = { id: job.id, controller };
    try {
      job.state = 'running';
      save(job);
      if (job.model !== modelPath()) throw new Error('当前模型与任务原用模型不同，请切回原模型后继续。');
      const pieces = chapter.prepare(job.chapter);
      const clips = loadParts(job, pieces);
      const stored = new Map(clips);
      const saveParts = () => {
        for (const [key, clip] of clips) {
          if (stored.get(key) === clip) continue;
          atomicWrite(partPath(job.id, key), Buffer.concat(clip.chunks));
          stored.set(key, clip);
        }
      };
      await chapter.synthesize(pieces, clips, job.chapter.pauseMs, request, controller.signal, index => {
        if (index === null) saveParts();
        job.currentSegment = index === null ? null : index + 1;
        save(job);
      }, job.redoSegment ?? null);
      saveParts();
      job.redoSegment = null;
      controller.signal.throwIfAborted();
      const time = chapter.timeline(pieces, clips, job.chapter.pauseMs, job.includeSpeakers);
      if (time.completed.length === pieces.length) {
        const wav = Buffer.from(await audio.wav(time.completed, time.gapSamples).arrayBuffer());
        controller.signal.throwIfAborted();
        atomicWrite(path.join(folder(job.id), 'chapter.wav'), wav);
        atomicWrite(path.join(folder(job.id), 'chapter.srt'), audio.srt(time.completed));
        job.state = 'complete';
        discardSuperseded(job, pieces);
      } else job.state = 'interrupted';
      job.error = null;
    } catch (error) {
      job.state = controller.signal.aborted ? 'canceled' : 'failed';
      job.error = controller.signal.aborted ? null : String(error.message || error).slice(0, 300);
    } finally {
      job.currentSegment = null;
      job.updatedAt = new Date().toISOString();
      try { save(job); }
      catch (error) { job.state = 'failed'; job.error = '无法写入任务记录。'; }
      active = null;
      if ([...jobs.values()].some(busy)) queueMicrotask(pump);
    }
  }

  function canQueue() {
    if ([...jobs.values()].filter(job => job.state === 'queued').length >= 20) {
      throw new JobError(429, 'queue_full', '队列已满，请稍后再试。');
    }
  }

  function create(input, requestId, { origin = 'agent', draft = false } = {}) {
    const spec = chapterData(input, draft);
    const editor = editorData(input);
    const includeSpeakers = input.includeSpeakers === true;
    if (requestId && !/^[\w-]{1,128}$/.test(requestId)) {
      throw new JobError(400, 'invalid_request_id', '请求标识格式无效。');
    }
    const fingerprint = hash(JSON.stringify([spec, includeSpeakers]));
    if (requestId) {
      const existing = [...jobs.values()].find(job => (job.origin || 'agent') === origin && job.requestId === requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new JobError(409, 'request_conflict', '该请求标识已用于另一份任务。');
        return describe(existing);
      }
    }
    if (!draft) canQueue();
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const record = {
      version: 1, id, chapter: spec, editor, origin, includeSpeakers, model: draft ? '' : modelPath(),
      requestId, fingerprint, state: draft ? 'draft' : 'queued', createdAt, queuedAt: createdAt
    };
    fs.mkdirSync(folder(id));
    save(record);
    jobs.set(id, record);
    if (!draft) queueMicrotask(pump);
    return describe(record);
  }

  function revise(id, input, draft = false) {
    const old = get(id);
    if (busy(old)) throw new JobError(409, 'job_busy', '请先等任务停止，再修改章节。');
    const spec = chapterData(input, draft);
    const editor = editorData(input);
    const redoSegment = input.redoSegment ?? null;
    if (redoSegment !== null && (!Number.isInteger(redoSegment) || redoSegment < 0 || redoSegment >= spec.segments.length)) {
      throw new JobError(400, 'invalid_segment', '重录段落无效。');
    }
    const includeSpeakers = input.includeSpeakers === true;
    if (draft && old.includeSpeakers === includeSpeakers && JSON.stringify(old.chapter) === JSON.stringify(spec)) {
      const renamed = { ...old, editor, updatedAt: new Date().toISOString() };
      save(renamed);
      jobs.set(id, renamed);
      return describe(renamed);
    }
    const selectedModel = modelPath();
    if (!draft && old.model && old.model !== selectedModel) {
      throw new JobError(409, 'model_changed', '请切回任务原用模型，或另开一个章节。');
    }
    if (!draft) canQueue();
    const now = new Date().toISOString();
    const record = {
      ...old, chapter: spec, editor, includeSpeakers,
      model: old.model || (draft ? '' : selectedModel), redoSegment: draft ? null : redoSegment,
      state: draft ? 'draft' : 'queued', updatedAt: now, queuedAt: now, error: null
    };
    save(record);
    jobs.set(id, record);
    if (!draft) queueMicrotask(pump);
    return describe(record);
  }

  function cancel(id) {
    const job = get(id);
    if (active?.id === id && job.state === 'running') active.controller.abort();
    if (job.state === 'queued') {
      const stopped = { ...job, state: 'canceled', updatedAt: new Date().toISOString() };
      save(stopped);
      jobs.set(id, stopped);
      return describe(stopped);
    }
    return describe(job);
  }

  function resume(id) {
    const job = get(id);
    if (job.state === 'complete' || busy(job)) return describe(job);
    if (job.state === 'draft') throw new JobError(409, 'job_draft', '请先核对草稿中的台词和角色。');
    if (job.model !== modelPath()) throw new JobError(409, 'model_changed', '请切回任务原用模型。');
    canQueue();
    const time = new Date().toISOString();
    const queued = { ...job, error: null, state: 'queued', queuedAt: time, updatedAt: time };
    save(queued);
    jobs.set(id, queued);
    queueMicrotask(pump);
    return describe(queued);
  }

  async function artifact(id, name, { partial = false, speakers, segment } = {}) {
    const job = get(id);
    const unavailable = () => new JobError(404, 'artifact_not_found', '该任务的产物尚不可用。');
    if (!artifactNames.includes(name) || job.state === 'draft') throw unavailable();
    if (!partial && segment === undefined && speakers === undefined) {
      if (job.state !== 'complete') throw unavailable();
      return readFile(path.join(folder(job.id), name));
    }
    const allPieces = chapter.prepare(job.chapter);
    const pieces = segment === undefined ? allPieces : allPieces.filter(part => part.segmentIndex === segment);
    const clips = loadParts(job, pieces);
    if (segment !== undefined && clips.size !== pieces.length) throw unavailable();
    const gap = segment === undefined ? job.chapter.pauseMs : 0;
    const time = chapter.timeline(pieces, clips, gap, speakers ?? job.includeSpeakers);
    if (!time.completed.length) throw unavailable();
    return name === 'chapter.srt' ? Buffer.from(audio.srt(time.completed)) :
      Buffer.from(await audio.wav(time.completed, time.gapSamples).arrayBuffer());
  }

  function project(id) {
    const job = get(id);
    return { job: describe(job), chapter: job.chapter, editor: job.editor || {},
      includeSpeakers: job.includeSpeakers };
  }

  return {
    create, cancel, resume, revise, status: id => describe(get(id)), artifact, project,
    isBusy: () => [...jobs.values()].some(busy),
    list: () => [...jobs.values()].map(job => describe(job, false))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  };
}

module.exports = { createChapterJobs, JobError };
