'use strict';

function bindChapter() {
  const view = name => $('chapter-' + name);
  const source = view('source');
  const mode = view('mode');
  const editor = view('editor');
  const status = view('status');
  const review = view('review');
  const file = view('file');
  const gap = view('gap');
  const roleList = view('roles');
  const lineList = view('lines');
  const assignRole = view('assign-role');
  const assign = view('assign');
  const aliasSource = view('alias-source');
  const aliasTarget = view('alias-target');
  const pending = view('pending-only');
  const output = view('output');
  const selected = new Set();
  const clips = new Map();
  const player = generatedAudio(view('player'));
  let chapter;
  let rows = [];
  let busy = false;
  let generation;
  let nextRoleNumber;
  let filename = '声轨工坊-章节配音';

  function prepared() {
    if (!chapter || chapter.source !== source.value || chapter.mode !== mode.value) {
      throw new Error('点击「解析章节」以应用当前原文和格式。');
    }
    return VoiceTrackChapter.prepare({ ...chapter, pauseMs: Number(gap.value) });
  }

  function selectRoles(select, value, placeholder) {
    const options = chapter.roles.map(role => new Option(role.name, role.id));
    select.replaceChildren(...(placeholder ? [new Option(placeholder, '')] : []), ...options);
    select.value = value || '';
  }

  function action(text, callback, label) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-sm';
    button.textContent = text;
    if (label) button.setAttribute('aria-label', label);
    button.onclick = callback;
    return button;
  }

  function renderRoles() {
    const roles = chapter.roles.map(role => {
      const row = document.createElement('div');
      const name = document.createElement('input');
      const voice = document.createElement('select');
      const instruction = document.createElement('input');
      row.className = 'chapter-role';
      name.type = 'text';
      name.value = role.name;
      name.maxLength = 32;
      name.setAttribute('aria-label', '角色名称');
      name.onchange = () => {
        try {
          const next = VoiceTrackChapter.roleName(name.value);
          if (chapter.roles.some(other => other.id !== role.id && other.name === next)) throw new Error('角色名已存在。');
          role.name = next;
          renderRoles();
          renderLines();
          refresh();
        } catch (error) {
          name.value = role.name;
          toast(error.message);
        }
      };
      const defaultLabel = role.id === VoiceTrackChapter.narratorId ? '模型默认音色' : '请选择参考音色';
      voice.add(new Option(defaultLabel, ''));
      for (const item of state.voices.filter(item => item.saved)) voice.add(new Option(item.id, item.id));
      if (role.voiceId && !Array.from(voice.options).some(option => option.value === role.voiceId)) {
        voice.add(new Option(role.voiceId + '（音色缺失）', role.voiceId));
      }
      voice.value = role.voiceId;
      voice.setAttribute('aria-label', role.name + '参考音色');
      voice.onchange = () => { role.voiceId = voice.value; refresh(); };
      instruction.type = 'text';
      instruction.placeholder = '表演指令（可选）';
      instruction.maxLength = 8192;
      instruction.value = role.instruction;
      instruction.setAttribute('aria-label', role.name + '表演指令');
      instruction.oninput = () => { role.instruction = instruction.value; refresh(); };
      row.append(name, voice, instruction);
      return row;
    });
    roleList.replaceChildren(...roles);
    selectRoles(assignRole, assignRole.value, '批量分配角色');
    selectRoles(aliasSource, aliasSource.value, '选择别名');
    aliasSource.querySelector('option[value="narrator"]').disabled = true;
    selectRoles(aliasTarget, aliasTarget.value, '保留的角色');
    updateAlias();
  }

  function renderLines() {
    rows = chapter.segments.map((segment, index) => {
      const li = document.createElement('li');
      const controls = document.createElement('div');
      const checked = document.createElement('input');
      const speaker = document.createElement('select');
      const text = document.createElement('textarea');
      controls.className = 'chapter-line-controls';
      checked.type = 'checkbox';
      checked.checked = selected.has(index);
      checked.setAttribute('aria-label', '选中第 ' + (index + 1) + ' 段');
      checked.onchange = () => {
        if (checked.checked) selected.add(index);
        else selected.delete(index);
        updateSelection();
      };
      selectRoles(speaker, segment.speakerId, '待确认');
      speaker.setAttribute('aria-label', '第 ' + (index + 1) + ' 段说话人');
      speaker.onchange = () => {
        segment.speakerId = speaker.value || null;
        if (pending.checked) renderLines();
        refresh();
      };
      text.rows = 2;
      text.value = segment.text;
      text.setAttribute('aria-label', '第 ' + (index + 1) + ' 段台词');
      text.oninput = () => { segment.text = text.value; refresh(); };
      const preview = action('试听', () => {
        const parts = prepared().filter(piece => piece.segmentIndex === index);
        const result = VoiceTrackChapter.timeline(parts, clips, 0, false);
        if (result.completed.length) player.listen(BreezeLongform.wav(result.completed, 0));
      }, '试听第 ' + (index + 1) + ' 段');
      const rerun = action('重录', () => generate(index), '重录第 ' + (index + 1) + ' 段');
      const detail = document.createElement('span');
      detail.className = 'longform-note';
      controls.append(checked, speaker, preview, rerun, detail);
      li.append(controls, text);
      li.hidden = pending.checked && Boolean(segment.speakerId);
      return { li, preview, rerun, detail };
    });
    lineList.replaceChildren(...rows.map(row => row.li));
  }

  function updateSelection() {
    assign.disabled = !selected.size || !assignRole.value;
  }

  function updateAlias() {
    view('merge-role').disabled = !aliasSource.value || !aliasTarget.value ||
      aliasSource.value === VoiceTrackChapter.narratorId || aliasSource.value === aliasTarget.value;
  }

  function refresh(message) {
    if (!chapter) return;
    let pieces = [];
    let warning;
    try {
      pieces = prepared();
      const missing = pieces.find(piece => piece.voiceId &&
        !state.voices.some(item => item.saved && item.id === piece.voiceId));
      if (missing) throw new Error('「' + missing.speakerName + '」的参考音色缺失，请重新选择。');
    } catch (error) { warning = error.message; }
    const gapMs = Number(gap.value);
    const result = VoiceTrackChapter.timeline(pieces, clips, gapMs, false);
    const completed = new Array(rows.length).fill(0);
    const count = new Array(rows.length).fill(0);
    for (const piece of pieces) {
      count[piece.segmentIndex]++;
      if (clips.has(piece.key)) completed[piece.segmentIndex]++;
    }
    const total = completed.filter((n, i) => n !== 0 && n === count[i]).length;
    rows.forEach(({ preview, rerun, detail }, index) => {
      const ready = completed[index] !== 0 && completed[index] === count[index];
      preview.disabled = Boolean(warning) || !ready;
      rerun.disabled = busy || Boolean(warning) || !clips.size;
      detail.textContent = ready ? '已生成' : chapter.segments[index].speakerId ? '待生成' : '待确认';
    });
    view('go').disabled = busy || Boolean(warning);
    view('go').textContent = total && total < rows.length ? '继续生成' : '生成整章';
    if (message) status.textContent = message;
    else if (!busy) status.textContent = warning || ('已生成 ' + total + ' / ' + rows.length + ' 段');
    const hasAudio = !warning && result.completed.length > 0;
    view('play').disabled = view('wav').disabled = view('srt').disabled = !hasAudio;
    output.hidden = !busy && !clips.size;
    updateSelection();
  }

  view('parse').onclick = () => {
    try {
      const result = VoiceTrackChapter.parse(source.value, mode.value);
      if (chapter && !confirm('重新解析会替换本章的角色分配和当前生成结果。继续？')) return;
      chapter = result;
      nextRoleNumber = result.roles.length;
      selected.clear();
      clips.clear();
      player.clear();
      review.hidden = false;
      renderRoles();
      renderLines();
      refresh();
    } catch (error) {
      status.textContent = error.message;
    }
  };
  source.oninput = mode.onchange = () => refresh();
  gap.onchange = () => refresh();
  pending.onchange = () => { selected.clear(); renderLines(); refresh(); };
  assignRole.onchange = updateSelection;
  assign.onclick = () => {
    for (const index of selected) chapter.segments[index].speakerId = assignRole.value;
    selected.clear();
    renderLines();
    refresh();
  };
  view('add-role').onclick = () => {
    const input = view('new-role');
    try {
      if (chapter.roles.length >= VoiceTrackChapter.maxRoles) throw new Error('角色数量已达到上限。');
      const name = VoiceTrackChapter.roleName(input.value);
      if (chapter.roles.some(role => role.name === name)) throw new Error('角色名已存在。');
      chapter.roles.push({ id: 'role-' + nextRoleNumber++, name, voiceId: '', instruction: '' });
      input.value = '';
      renderRoles();
      renderLines();
      refresh();
    } catch (error) { toast(error.message); }
  };
  aliasSource.onchange = aliasTarget.onchange = updateAlias;
  view('merge-role').onclick = () => {
    const from = chapter.roles.find(role => role.id === aliasSource.value);
    const to = chapter.roles.find(role => role.id === aliasTarget.value);
    if (!confirm('把「' + from.name + '」的全部台词分给「' + to.name + '」？')) return;
    for (const segment of chapter.segments) {
      if (segment.speakerId === from.id) segment.speakerId = to.id;
    }
    chapter.roles = chapter.roles.filter(role => role.id !== from.id);
    renderRoles();
    renderLines();
    refresh();
  };
  view('refresh-voices').onclick = async () => {
    await loadVoices();
    renderRoles();
    refresh();
  };
  file.onchange = async () => {
    const selectedFile = fileOf(file);
    if (!selectedFile) return;
    file.disabled = true;
    try {
      if (!/\.txt$/i.test(selectedFile.name) || selectedFile.size > 4 * BreezeLongform.maxChars + 3) {
        throw new Error('请选择符合长度限制的 UTF-8 TXT 文件。');
      }
      const raw = await selectedFile.arrayBuffer();
      source.value = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      filename = selectedFile.name.replace(/\.txt$/i, '') || filename;
      refresh();
    } catch (error) { toast(error.message); }
    finally {
      file.disabled = false;
      file.value = '';
    }
  };

  function readyAudio(includeSpeakers) {
    return VoiceTrackChapter.timeline(prepared(), clips, Number(gap.value), includeSpeakers);
  }

  async function generate(segmentIndex) {
    if (state.abort || busy) { toast('请等待当前合成结束。'); return; }
    let plan;
    try { plan = prepared(); }
    catch (error) { status.textContent = error.message; return; }
    const gapMs = Number(gap.value);
    generation = new AbortController();
    state.abort = generation;
    busy = true;
    editor.disabled = true;
    view('stop').disabled = false;
    setStatus('busy', '正在生成章节');
    refresh('正在准备配音。');
    try {
      await VoiceTrackChapter.synthesize(plan, clips, gapMs, (piece, signal) => fetch('/api/speech', {
        method: 'POST', body: buildSpeechForm(piece.text, piece.instruction, piece.voiceId, null, ''), signal
      }), generation.signal, index => {
        if (index !== null) refresh('正在生成第 ' + (index + 1) + ' 段。');
        else refresh();
      }, segmentIndex);
      refresh(segmentIndex === null ? '整章已生成，可导出 WAV 和 SRT。' : '第 ' + (segmentIndex + 1) + ' 段已重录。');
    } catch (error) {
      refresh(generation.signal.aborted ? '已停止，保留现有片段。' : '生成失败。' + error.message);
    } finally {
      editor.disabled = false;
      busy = false;
      generation = null;
      state.abort = null;
      view('stop').disabled = true;
      setStatus('ok', '就绪');
      refresh(status.textContent);
    }
  }

  view('go').onclick = () => generate(null);
  view('stop').onclick = () => generation?.abort();
  view('play').onclick = () => {
    const audio = readyAudio(false);
    player.listen(BreezeLongform.wav(audio.completed, audio.gapSamples));
  };
  view('wav').onclick = () => {
    const audio = readyAudio(false);
    downloadBlob(BreezeLongform.wav(audio.completed, audio.gapSamples), filename + '.wav');
  };
  view('srt').onclick = () => {
    const audio = readyAudio(view('include-speakers').checked);
    downloadBlob(new Blob([BreezeLongform.srt(audio.completed)], { type: 'text/plain;charset=utf-8' }), filename + '.srt');
  };
}
