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

  const speechCue = /^(?:[，,。！？…\s]*)([\p{Script=Han}]{2,4}?)(?:轻声|低声|小声|大声)?(?:说道|说|问道|问|回答|答道|答|回应|喊道|喊|叫道)\s*[。！？!?]?$/u;
  const beforeQuote = /(?:^|[。！？；;，,]\s*)([\p{Script=Han}]{2,4}?)(?:轻声|低声|小声|大声)?(?:说道|说|问道|问|回答|答道|答|回应|喊道|喊|叫道)\s*[：:，,]\s*$/u;

  function namedCue(value) {
    if (!value || /^(?:[他她它你我咱]|众人|两人|有人|那人|一人|对方|男子|女子|男人|女人|女孩|男孩|小声|轻声|低声|大声|悄悄|慢慢|突然|接着|大家|人们)/u.test(value)) return null;
    return value;
  }

  function readDocument(input, mode) {
    if (typeof input !== 'string' || input.length > longform.maxChars) {
      throw new Error('一次最多导入 ' + longform.maxChars + ' 字。');
    }
    const source = input.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n');
    const roles = [{ id: narratorId, name: '旁白', voiceId: '', instruction: '' }];
    const segments = [];
    const names = new Map([['旁白', narratorId]]);

    function roleFor(name) {
      if (!name) return null;
      if (names.has(name)) return names.get(name);
      if (roles.length >= maxRoles) throw new Error('一次最多处理 ' + maxRoles + ' 个角色（含旁白）。');
      const id = 'role-' + roles.length;
      roles.push({ id, name, voiceId: '', instruction: '' });
      names.set(name, id);
      return id;
    }

    function append(start, end, speakerId) {
      const raw = source.slice(start, end);
      const text = raw.trim();
      if (!/[\p{L}\p{N}]/u.test(text)) return;
      start += raw.length - raw.trimStart().length;
      segments.push({ text, speakerId, start, end: start + text.length });
      if (segments.length > maxSegments) throw new Error('可合成内容超过 ' + maxSegments + ' 段，请分成多章。');
    }

    for (const line of source.matchAll(/[^\n]+/gu)) {
      const [body] = line;
      const base = line.index;
      const label = /^(\s*)([^:：]{1,32})[:：]\s*/u.exec(body);
      const name = label?.[2].trim().normalize('NFC');
      const labelIsRole = name && roleNamePattern.test(name) && (mode === 'script' ||
        (name.length <= 6 && !/[“”「」『』"。！？]/u.test(name) && !/(?:说|问|答|回答|道|喊|写|表示)$/u.test(name)));
      if (labelIsRole && label[0].length < body.length) {
        append(base + label[0].length, base + body.length, roleFor(name));
        continue;
      }
      const dash = /^\s*[—–]{1,2}\s*/u.exec(body);
      if (dash) {
        append(base + dash[0].length, base + body.length, null);
        continue;
      }

      const quotes = /[“「『"]/gu;
      let cursor = 0;
      let hit;
      while ((hit = quotes.exec(body))) {
        const start = hit.index + 1;
        const close = body.indexOf(closingQuote[hit[0]], start);
        const end = close < 0 ? body.length : close;
        const next = close < 0 ? -1 : body.slice(close + 1).search(/[“「『"]/u);
        const after = close < 0 ? '' : body.slice(close + 1, next < 0 ? body.length : close + 1 + next);
        const before = namedCue(beforeQuote.exec(body.slice(cursor, hit.index))?.[1]);
        const afterName = namedCue(speechCue.exec(after.trim())?.[1]);
        const speaker = before && afterName && before !== afterName ? null : before || afterName;
        append(base + cursor, base + hit.index, narratorId);
        append(base + start, base + end, roleFor(speaker));
        cursor = end + (close < 0 ? 0 : 1);
        quotes.lastIndex = cursor;
      }
      append(base + cursor, base + body.length, narratorId);
    }
    if (!segments.length) throw new Error('请导入或输入章节正文。');
    return { source, mode, roles, segments };
  }

  function validRanges(source, segments, ranges) {
    if (!Array.isArray(ranges) || ranges.length !== segments.length) return false;
    let previous = 0;
    return ranges.every((entry, index) => {
      if (!Array.isArray(entry) || entry.length !== 2) return false;
      const [start, end] = entry;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < previous || end < start ||
          end > source.length || source.slice(start, end) !== segments[index].text) return false;
      previous = end;
      return true;
    });
  }

  function restoreDocument(input, segments, ranges) {
    if (validRanges(input, segments, ranges)) {
      return { source: input, segments: segments.map((segment, index) => {
        const [start, end] = ranges[index];
        return { ...segment, start, end };
      }) };
    }
    const source = input.replace(/\r\n?/gu, '\n');
    let cursor = 0;
    const positioned = segments.map(segment => {
      const start = source.indexOf(segment.text, cursor);
      if (start !== -1) cursor = start + segment.text.length;
      return { ...segment, start, end: start + segment.text.length };
    });
    if (positioned.every(segment => segment.start !== -1)) return { source, segments: positioned };

    // Agent submissions and edited legacy turns may only have the synthesis text.
    cursor = 0;
    return {
      source: segments.map(segment => segment.text).join('\n'),
      segments: segments.map(segment => {
        const start = cursor;
        const end = start + segment.text.length;
        cursor = end + 1;
        return { ...segment, start, end };
      })
    };
  }

  function assignRange(chapter, start, end, speakerId) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > chapter.source.length || start >= end) {
      throw new Error('请先在正文中选中文字。');
    }
    const segments = chapter.segments.map((segment, index) => ({ ...segment, slot: segment.slot ?? index }));
    let next = 1 + Math.max(...segments.map(segment => segment.slot));
    let touched = false;
    const updated = segments.flatMap(segment => {
      const from = Math.max(start, segment.start);
      const to = Math.min(end, segment.end);
      if (from >= to || !chapter.source.slice(from, to).trim()) return segment;
      touched = true;
      if (speakerId === segment.speakerId) return segment;
      const intervals = [[segment.start, from, segment.speakerId], [from, to, speakerId], [to, segment.end, segment.speakerId]];
      return intervals.flatMap(([left, right, role], index) => {
        const raw = chapter.source.slice(left, right);
        if (!raw.trim()) return [];
        return [{ text: raw, speakerId: role, start: left, end: right,
          slot: index === 0 || (index === 1 && from === segment.start) ? segment.slot : next++ }];
      });
    });
    if (!touched) throw new Error('所选文字没有可分配的台词。');
    if (updated.length > maxSegments) throw new Error('可合成内容超过 ' + maxSegments + ' 段，请分成多章。');
    return updated;
  }

  function splitSelection(segments, index, start, end, speakerId) {
    const segment = segments[index];
    if (!segment || !Number.isInteger(start) || !Number.isInteger(end) ||
        start < 0 || end > segment.text.length || start >= end || !segment.text.slice(start, end).trim()) {
      throw new Error('请先在台词中选中文字。');
    }
    const parts = [
      { ...segment, text: segment.text.slice(0, start) },
      { ...segment, text: segment.text.slice(start, end), speakerId },
      { ...segment, text: segment.text.slice(end) }
    ].filter(part => part.text.trim());
    if (segments.length - 1 + parts.length > maxSegments) {
      throw new Error('章节最多有 ' + maxSegments + ' 段台词，请分为多个项目。');
    }
    if (parts.length === 1 && !start && end === segment.text.length) {
      return segments.map((item, position) => position === index ? parts[0] : item);
    }
    // Preserve the keys of recorded turns whose position moves after the split.
    const slotted = segments.map((item, position) => ({ ...item, slot: item.slot ?? position }));
    let next = 1 + Math.max(...slotted.map(item => item.slot));
    slotted.splice(index, 1, ...parts.map((part, position) => ({
      ...part, slot: position ? next++ : slotted[index].slot
    })));
    return slotted;
  }

  function validate(chapter) {
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
    const slots = new Set();
    chapter.segments.forEach((segment, index) => {
      if (typeof segment?.text !== 'string' || (segment.speakerId !== null && !roles.has(segment.speakerId))) {
        throw new Error('第 ' + (index + 1) + ' 段台词或角色无效。');
      }
      const slot = segment.slot ?? index;
      if (!Number.isSafeInteger(slot) || slot < 0 || slot > 1000000 || slots.has(slot)) {
        throw new Error('第 ' + (index + 1) + ' 段的编号无效。');
      }
      slots.add(slot);
      size += segment.text.length;
      if (size > longform.maxChars) throw new Error('一次最多处理 ' + longform.maxChars + ' 字。');
    });
    return roles;
  }

  function prepare(chapter) {
    const roles = validate(chapter);
    const pieces = [];
    chapter.segments.forEach((segment, index) => {
      if (!segment.text.trim()) throw new Error('第 ' + (index + 1) + ' 段台词为空。');
      const role = roles.get(segment.speakerId);
      if (!role) throw new Error('请确认第 ' + (index + 1) + ' 段的说话人。');
      if (role.id !== narratorId && !role.voiceId) {
        throw new Error('请为「' + role.name + '」选择音色库里的参考音色。');
      }
      for (const [partIndex, text] of longform.splitScript(segment.text).entries()) {
        const key = JSON.stringify([segment.slot ?? index, partIndex, text, role.voiceId, role.instruction]);
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

  return { narratorId, maxRoles, maxSegments, parse, readDocument, restoreDocument, assignRange, validRanges, splitSelection, validate, prepare, roleName, timeline, synthesize };
})(typeof module === 'object' && module.exports ? require('./longform') : BreezeLongform);

if (typeof module === 'object') module.exports = VoiceTrackChapter;
