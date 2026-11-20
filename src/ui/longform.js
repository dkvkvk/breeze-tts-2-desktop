'use strict';

const BreezeLongform = (() => {
  const sampleRate = 24000;
  const maxChars = 12000;
  const maxDraftBytes = 128 * 1024;
  const maxPieces = 200;
  const pieceLength = 100;
  const maxSamples = 20 * 60 * sampleRate;

  function splitScript(script) {
    if (script.length > maxChars) throw new Error('一次最多处理 ' + maxChars + ' 字，请拆成几次生成。');
    const pieces = [];
    for (const line of script.split(/\r\n?|\n/)) {
      const chars = Array.from(line.trim());
      let start = 0;
      while (start < chars.length) {
        let end = Math.min(start + pieceLength, chars.length);
        if (end < chars.length) {
          const minimum = start + Math.floor(pieceLength / 2);
          for (const boundary of [/[。！？!?；;…]/u, /[，、,:：]/u, /\s/u]) {
            let index = end - 1;
            while (index >= minimum && !boundary.test(chars[index])) index--;
            if (index >= minimum) {
              end = index + 1;
              break;
            }
          }
        }
        const text = chars.slice(start, end).join('').trim();
        if (text) pieces.push(text);
        if (pieces.length > maxPieces) throw new Error('分段超过 ' + maxPieces + ' 段，请拆成几次生成。');
        start = end;
      }
    }
    return pieces;
  }

  function createJob(pieces, pauseMs) {
    return { pieces, gapSamples: pauseMs * sampleRate / 1000, completed: [], samples: 0 };
  }

  function draftSettings(draft) {
    if (typeof draft?.text !== 'string' || typeof draft.instruction !== 'string' ||
      draft.instruction.length > 8192 || typeof draft.voiceId !== 'string' || draft.voiceId.length > 512 ||
      ![0, 250, 500, 1000].includes(draft.pauseMs)) throw new Error('配音草稿的字段无效。');
    if (!splitScript(draft.text).length) throw new Error('配音草稿中没有可合成的台词。');
    const { text, instruction, voiceId, pauseMs } = draft;
    return { text, instruction, voiceId, pauseMs };
  }

  function encodeDraft(settings) {
    return JSON.stringify({ format: 'breeze-longform', version: 1, ...draftSettings(settings) }, null, 2) + '\n';
  }

  function decodeDraft(content) {
    let draft;
    try { draft = JSON.parse(content); }
    catch (error) { throw new Error('无法读取配音草稿，请选择由 Breeze 导出的 JSON 文件。'); }
    if (draft?.format !== 'breeze-longform' || draft.version !== 1) throw new Error('不支持的配音草稿格式。');
    return draftSettings(draft);
  }

  async function readPcm(response, remaining, signal) {
    if (!response.ok) {
      const detail = (await response.text()).trim().slice(0, 240);
      throw new Error('推理服务返回 ' + response.status + (detail ? '：' + detail : '。'));
    }
    if (!response.body || !/^audio\/pcm(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel().catch(() => {});
      throw new Error('推理服务没有返回 PCM 音频。');
    }
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    let ended = false;
    try {
      while (!ended) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        ended = done;
        if (done) break;
        bytes += value.byteLength;
        if (bytes > remaining * 2) throw new Error('本次音频已达到 20 分钟上限，请分批生成。');
        chunks.push(value);
      }
    } finally {
      if (!ended) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!bytes || bytes % 2 !== 0) throw new Error('收到的 PCM 音频为空或不完整。');
    return { chunks, samples: bytes / 2 };
  }

  async function runJob(job, request, signal, progress) {
    for (let index = job.completed.length; index < job.pieces.length; index++) {
      signal.throwIfAborted();
      const start = job.samples + (index ? job.gapSamples : 0);
      if (start >= maxSamples) throw new Error('本次音频已达到 20 分钟上限，请分批生成。');
      progress(index);
      const response = await request(job.pieces[index], signal);
      const clip = await readPcm(response, maxSamples - start, signal);
      signal.throwIfAborted();
      job.completed.push({ ...clip, start, text: job.pieces[index] });
      job.samples = start + clip.samples;
      progress(null);
    }
  }

  function wav(completed, gapSamples) {
    const gap = new Uint8Array(gapSamples * 2);
    const data = [];
    let bytes = 0;
    for (const clip of completed) {
      if (data.length && gap.length) {
        data.push(gap);
        bytes += gap.length;
      }
      for (const chunk of clip.chunks) data.push(chunk);
      bytes += clip.samples * 2;
    }
    const header = new DataView(new ArrayBuffer(44));
    header.setUint32(0, 0x52494646); // RIFF
    header.setUint32(4, bytes + 36, true);
    header.setUint32(8, 0x57415645); // WAVE
    header.setUint32(12, 0x666d7420); // fmt
    header.setUint32(16, 16, true);
    header.setUint16(20, 1, true);
    header.setUint16(22, 1, true);
    header.setUint32(24, sampleRate, true);
    header.setUint32(28, sampleRate * 2, true);
    header.setUint16(32, 2, true);
    header.setUint16(34, 16, true);
    header.setUint32(36, 0x64617461); // data
    header.setUint32(40, bytes, true);
    return new Blob([header].concat(data), { type: 'audio/wav' });
  }

  function timestamp(ms) {
    const pad = (value, width = 2) => String(value).padStart(width, '0');
    return pad(Math.floor(ms / 3600000)) + ':' + pad(Math.floor(ms / 60000) % 60) + ':' +
      pad(Math.floor(ms / 1000) % 60) + ',' + pad(ms % 1000, 3);
  }

  function srt(completed) {
    return completed.map((clip, index) => {
      const start = Math.floor(clip.start * 1000 / sampleRate);
      const end = Math.floor((clip.start + clip.samples) * 1000 / sampleRate);
      return [index + 1, timestamp(start) + ' --> ' + timestamp(Math.max(start + 1, end)), clip.text].join('\r\n');
    }).join('\r\n\r\n') + '\r\n';
  }

  return { sampleRate, maxChars, maxDraftBytes, splitScript, createJob, runJob, wav, srt, encodeDraft, decodeDraft };
})();

if (typeof module === 'object') module.exports = BreezeLongform;
