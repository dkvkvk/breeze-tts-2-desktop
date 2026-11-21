'use strict';

const VoiceTrackChapter = (longform => {
  const narratorId = 'narrator';
  const maxRoles = 64;
  const maxSegments = 200;
  const allowedGaps = [0, 250, 500, 1000];
  const roleNamePattern = /^[\p{L}\p{N}][\p{L}\p{N} ._·-]{0,31}$/u;
  const speakerIdPattern = /^[a-z][a-z0-9-]{0,31}$/;
  const closingQuote = { '“': '”', '「': '」', '『': '』', '"': '"' };

  function roleName(value) {
    const name = value.trim().normalize('NFC');
    if (!roleNamePattern.test(name)) throw new Error('角色名须为 1–32 个字符，可使用文字、数字、空格和间隔符。');
    return name;
  }

  function parse(source, mode) {
    if (typeof source !== 'string' || source.length > longform.maxChars) {
      throw new Error('一次最多导入 ' + longform.maxChars + ' 字。');
    }
    if (!['script', 'novel'].includes(mode)) throw new Error('请选择明确的导入格式。');
    const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const chapter = {
      source, mode,
      roles: [{ id: narratorId, name: '旁白', voiceId: '', instruction: '' }],
      segments: []
    };
    const names = new Map([['旁白', narratorId]]);
    const addSegment = (text, speakerId) => {
      for (const part of text.split('\n')) {
        const clean = part.trim();
        if (!clean) continue;
        chapter.segments.push({ text: clean, speakerId });
        if (chapter.segments.length > maxSegments) throw new Error('一次最多导入 ' + maxSegments + ' 个配音片段。');
      }
    };

    if (mode === 'script') {
      for (const line of lines.split('\n')) {
        const label = line.trim().match(/^([^:：]{1,32})[:：]\s*(\S.*)$/u);
        const possibleName = label?.[1].trim().normalize('NFC');
        if (!possibleName || !roleNamePattern.test(possibleName)) {
          addSegment(line, narratorId);
          continue;
        }
        if (!names.has(possibleName)) {
          if (chapter.roles.length >= maxRoles) throw new Error('一次最多处理 ' + maxRoles + ' 个角色（含旁白）。');
          const id = 'role-' + chapter.roles.length;
          names.set(possibleName, id);
          chapter.roles.push({ id, name: possibleName, voiceId: '', instruction: '' });
        }
        addSegment(label[2], names.get(possibleName));
      }
    } else {
      let offset = 0;
      const openings = /[“「『"]/gu;
      let hit;
      while ((hit = openings.exec(lines))) {
        const start = hit.index + 1;
        const close = lines.indexOf(closingQuote[hit[0]], start);
        const lineEnd = lines.indexOf('\n', start);
        const matched = close >= 0 && (lineEnd < 0 || close < lineEnd);
        const end = matched ? close : lineEnd < 0 ? lines.length : lineEnd;
        addSegment(lines.slice(offset, hit.index), narratorId);
        addSegment(lines.slice(start, end), null);
        offset = end + (matched ? 1 : 0);
        openings.lastIndex = offset;
      }
      addSegment(lines.slice(offset), narratorId);
    }
    if (!chapter.segments.length) throw new Error('请导入或输入章节台词。');
    return chapter;
  }

  function prepare(chapter) {
    if (!Array.isArray(chapter?.roles) || !chapter.roles.length || chapter.roles.length > maxRoles ||
        !Array.isArray(chapter.segments) || !chapter.segments.length || chapter.segments.length > maxSegments ||
        !allowedGaps.includes(chapter.pauseMs)) throw new Error('章节任务格式无效。');

    const roles = new Map();
    const names = new Set();
    for (const role of chapter.roles) {
      if (typeof role?.id !== 'string' || !speakerIdPattern.test(role.id) || roles.has(role.id) ||
          typeof role.name !== 'string' || typeof role.voiceId !== 'string' || role.voiceId.length > 512 ||
          typeof role.instruction !== 'string' || role.instruction.length > 8192) throw new Error('角色表格式无效。');
      const name = roleName(role.name);
      if (names.has(name)) throw new Error('角色名重复：' + name);
      names.add(name);
      roles.set(role.id, { ...role, name, voiceId: role.voiceId.trim(), instruction: role.instruction.trim() });
    }

    let size = 0;
    const pieces = [];
    chapter.segments.forEach((segment, index) => {
      if (typeof segment?.text !== 'string' || !segment.text.trim()) throw new Error('第 ' + (index + 1) + ' 段台词为空。');
      size += segment.text.length;
      if (size > longform.maxChars) throw new Error('一次最多合成 ' + longform.maxChars + ' 字。');
      const role = roles.get(segment.speakerId);
      if (!role) throw new Error('请确认第 ' + (index + 1) + ' 段的说话人。');
      if (role.id !== narratorId && !role.voiceId) {
        throw new Error('请为「' + role.name + '」选择音色库里的参考音色。');
      }
      for (const [partIndex, text] of longform.splitScript(segment.text).entries()) {
        const key = JSON.stringify([index, partIndex, text, role.voiceId, role.instruction]);
        pieces.push({ key, text, segmentIndex: index, speakerId: role.id, speakerName: role.name,
          voiceId: role.voiceId, instruction: role.instruction });
        if (pieces.length > maxSegments) throw new Error('合成分段超过 ' + maxSegments + ' 段，请拆成几次生成。');
      }
    });
    return pieces;
  }

  function timeline(pieces, clips, pauseMs, includeSpeakers) {
    const gapSamples = pauseMs * longform.sampleRate / 1000;
    const completed = [];
    let samples = 0;
    for (const piece of pieces) {
      const clip = clips.get(piece.key);
      if (!clip) break;
      const start = samples + (completed.length ? gapSamples : 0);
      const text = includeSpeakers ? piece.speakerName + '：' + piece.text : piece.text;
      completed.push({ ...clip, text, start });
      samples = start + clip.samples;
    }
    return { completed, gapSamples, samples };
  }

  async function synthesize(pieces, clips, pauseMs, request, signal, progress, onlySegment = null) {
    const keys = new Set(pieces.map(piece => piece.key));
    const gapSamples = pauseMs * longform.sampleRate / 1000;
    let samples = Math.max(0, pieces.length - 1) * gapSamples;
    for (const [key, clip] of clips) {
      if (keys.has(key)) samples += clip.samples;
      else clips.delete(key);
    }
    // Keep the old audio for a single-segment rerun until all its new pieces finish.
    const replacements = new Map();
    for (const piece of pieces) {
      signal.throwIfAborted();
      const old = clips.get(piece.key);
      if (onlySegment === null ? old : piece.segmentIndex !== onlySegment) continue;
      const budget = longform.maxSamples - samples + (old?.samples ?? 0);
      if (budget <= 0) throw new Error('本次音频达到 20 分钟上限。');
      progress(piece.segmentIndex);
      const response = await request(piece, signal);
      const clip = await longform.readPcm(response, budget, signal);
      signal.throwIfAborted();
      samples += clip.samples - (old?.samples ?? 0);
      if (onlySegment === null) {
        clips.set(piece.key, clip);
        progress(null);
      } else {
        replacements.set(piece.key, clip);
      }
    }
    for (const [key, clip] of replacements) clips.set(key, clip);
  }

  return { narratorId, maxRoles, maxSegments, parse, prepare, roleName, timeline, synthesize };
})(typeof module === 'object' && module.exports ? require('./longform') : BreezeLongform);

if (typeof module === 'object') module.exports = VoiceTrackChapter;
