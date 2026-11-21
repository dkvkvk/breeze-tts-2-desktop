'use strict';

function bindChapter() {
  const view = name => $('chapter-' + name);
  const source = view('source');
  const title = view('title');
  const mode = view('mode');
  const editor = view('editor');
  const status = view('status');
  const review = view('review');
  const file = view('file');
  const gap = view('gap');
  const roleList = view('roles');
  const entry = view('entry');
  const paper = view('document');
  const note = view('margin-note');
  const tools = view('selection-tools');
  const choice = view('speaker-choice');
  const createForm = view('create-form');
  const voiceOptions = view('voice-options');
  const roleColors = ['#1f5cb5', '#16704f', '#7444aa', '#ab4825', '#a23567',
    '#0d6879', '#896013', '#4053a2', '#975035', '#386321', '#844481', '#246572'];
  const aliasSource = view('alias-source');
  const aliasTarget = view('alias-target');
  const output = view('output');
  const player = generatedAudio(view('player'));
  const history = view('history');
  const api = '/api/v1/jobs';
  const labels = { draft: '草稿', queued: '排队中', running: '生成中', complete: '已完成',
    canceled: '已停止', failed: '生成失败', interrupted: '可继续' };
  let chapter;
  let job;
  let saved = '';
  let designPresets = [];
  let range = null;
  let submitting = false;
  let timer;
  let nextRoleNumber;

  const jobPath = () => api + '/' + job.id;
  const busy = () => job && (job.state === 'queued' || job.state === 'running');

  async function request(route, options) {
    const response = await fetch(route, options);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || '请求失败。');
    }
    return response;
  }

  function payload() {
    return {
      title: title.value.trim(), source: chapter.source, mode: chapter.mode, pauseMs: Number(gap.value),
      roles: chapter.roles.map(({ id, name, voiceId, instruction }) => ({ id, name, voiceId, instruction })),
      ranges: chapter.segments.map(({ start, end }) => [start, end]),
      segments: chapter.segments.map(({ text, speakerId, slot }) => ({ text, speakerId, slot }))
    };
  }
  const dirty = () => Boolean(chapter) && (JSON.stringify(payload()) !== saved ||
    source.value !== chapter.source || mode.value !== chapter.mode);

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

  function colorRole(element, id) {
    let color = '#8a5509';
    if (id === VoiceTrackChapter.narratorId) color = '#596171';
    else if (id) {
      const index = Array.from(id).reduce((value, char) => (value * 33 + char.charCodeAt(0)) % roleColors.length, 0);
      color = roleColors[index];
    }
    element.style.setProperty('--speaker-color', color);
  }

  function renderRoles() {
    const roles = chapter.roles.map(role => {
      const row = document.createElement('div');
      const name = document.createElement('input');
      const voice = document.createElement('select');
      const instruction = document.createElement('input');
      row.className = 'chapter-role';
      colorRole(row, role.id);
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
          renderDocument();
          refresh();
        } catch (error) {
          name.value = role.name;
          toast(error.message);
        }
      };
      const defaultLabel = role.id === VoiceTrackChapter.narratorId ? '模型默认音色' : '请选择参考音色';
      voice.add(new Option(defaultLabel, ''));
      for (const item of state.voices.filter(item => item.saved)) voice.add(new Option(voiceDisplayName(item), item.id));
      if (role.voiceId && !Array.from(voice.options).some(option => option.value === role.voiceId)) {
        voice.add(new Option(role.voiceId + '（音色缺失）', role.voiceId));
      }
      voice.value = role.voiceId;
      voice.setAttribute('aria-label', role.name + '参考音色');
      voice.onchange = () => { role.voiceId = voice.value; renderDocument(); refresh(); };
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
    selectRoles(aliasSource, aliasSource.value, '选择别名');
    const narrator = aliasSource.querySelector('option[value="narrator"]');
    if (narrator) narrator.disabled = true;
    selectRoles(aliasTarget, aliasTarget.value, '保留的角色');
    updateAlias();
  }

  function dismissTools() {
    tools.hidden = note.hidden = true;
    range = null;
    voiceOptions.hidden = createForm.hidden = true;
  }

  function renderDocument() {
    dismissTools();
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    chapter.segments.forEach((segment, index) => {
      fragment.append(chapter.source.slice(cursor, segment.start));
      const mark = document.createElement('span');
      mark.textContent = chapter.source.slice(segment.start, segment.end);
      mark.dataset.index = index;
      const role = chapter.roles.find(item => item.id === segment.speakerId);
      if (segment.speakerId !== VoiceTrackChapter.narratorId || role?.voiceId) {
        mark.className = segment.speakerId ? 'chapter-mark' : 'chapter-mark is-unassigned';
        mark.title = role?.name || '待确认说话人';
        colorRole(mark, segment.speakerId);
      }
      fragment.append(mark);
      cursor = segment.end;
    });
    fragment.append(chapter.source.slice(cursor));
    paper.replaceChildren(fragment);
    updateLegend();
  }

  function updateLegend() {
    const used = new Set(chapter.segments.map(segment => segment.speakerId));
    const items = chapter.roles.filter(role => used.has(role.id) &&
      (role.id !== VoiceTrackChapter.narratorId || role.voiceId)).map(role => {
      const label = document.createElement('span');
      colorRole(label, role.id);
      label.textContent = role.name;
      return label;
    });
    view('legend').replaceChildren(...items);
    const pending = chapter.segments.filter(segment => segment.speakerId === null).length;
    view('pending-count').textContent = pending ? pending + ' 处对白待确认' : '';
  }

  function textPosition(node, offset) {
    const prefix = document.createRange();
    prefix.selectNodeContents(paper);
    prefix.setEnd(node, offset);
    return prefix.toString().length;
  }

  function positionTools() {
    if (!range || tools.hidden) return;
    const bounds = range.anchor.getBoundingClientRect();
    if (!note.hidden) {
      const page = paper.parentElement.getBoundingClientRect();
      note.style.top = Math.max(8, Math.min(bounds.top - page.top - 3, page.height - note.offsetHeight - 8)) + 'px';
    }
    const width = tools.offsetWidth;
    const height = tools.offsetHeight;
    const margin = 12;
    const top = bounds.top - height - 8;
    tools.style.left = Math.max(margin, Math.min(bounds.left, innerWidth - width - margin)) + 'px';
    tools.style.top = Math.max(margin, Math.min(top >= margin ? top : bounds.bottom + 8,
      innerHeight - height - margin)) + 'px';
  }

  function showTools(start, end, anchor) {
    if (!chapter.source.slice(start, end).trim()) return;
    const index = chapter.segments.findIndex(segment => segment.start === start && segment.end === end);
    range = { start, end, index, anchor };
    const segment = chapter.segments[index];
    const role = chapter.roles.find(item => item.id === segment?.speakerId);
    note.hidden = !segment || (role?.id === VoiceTrackChapter.narratorId && !role.voiceId);
    if (!note.hidden) {
      colorRole(note, segment.speakerId);
      view('note-role').textContent = role?.name || '待确认说话人';
      const voice = state.voices.find(item => item.id === role?.voiceId);
      view('note-voice').textContent = voice ? voiceDisplayName(voice) : role?.voiceId || '尚未指定音色';
    }
    voiceOptions.hidden = createForm.hidden = true;
    updateTools();
    tools.hidden = false;
    positionTools();
  }

  function updateTools() {
    const index = range?.index ?? -1;
    view('preview-mark').hidden = index < 0 || dirty() || !job?.readySegments.includes(index);
    view('rerun-mark').hidden = index < 0 || !job || job.state === 'draft' || !canGenerate();
  }

  function captureSelection(event) {
    if (!chapter || editor.disabled) return;
    const selected = getSelection();
    if (selected.rangeCount && !selected.isCollapsed) {
      const selection = selected.getRangeAt(0);
      if (paper.contains(selection.startContainer) && paper.contains(selection.endContainer)) {
        showTools(textPosition(selection.startContainer, selection.startOffset),
          textPosition(selection.endContainer, selection.endOffset), selection.cloneRange());
        return;
      }
    }
    if (event.type !== 'pointerup') return;
    const mark = event.target.closest('.chapter-mark[data-index]');
    if (!mark || !paper.contains(mark)) return;
    const segment = chapter.segments[Number(mark.dataset.index)];
    showTools(segment.start, segment.end, mark);
  }

  function canGenerate() {
    try {
      const pieces = prepared();
      return !pieces.some(piece => piece.voiceId &&
        !state.voices.some(item => item.saved && item.id === piece.voiceId));
    } catch (error) { return false; }
  }

  function applyRole(id) {
    chapter.segments = VoiceTrackChapter.assignRange(chapter, range.start, range.end, id);
    getSelection().removeAllRanges();
    renderDocument();
    refresh();
  }

  function addRole(name, voiceId = '') {
    if (chapter.roles.length >= VoiceTrackChapter.maxRoles) throw new Error('角色数量已达到上限。');
    const role = { id: 'role-' + nextRoleNumber++, name, voiceId, instruction: '' };
    chapter.roles.push(role);
    return role;
  }

  function openVoiceOptions() {
    const roles = document.createElement('optgroup');
    roles.label = '章节角色';
    for (const role of chapter.roles) roles.append(new Option(role.name, 'role:' + role.id));
    const voices = document.createElement('optgroup');
    voices.label = '已保存的音色';
    for (const voice of state.voices.filter(item => item.saved)) voices.append(new Option(voiceDisplayName(voice), 'voice:' + voice.id));
    choice.replaceChildren(new Option('选择角色或音色', ''), roles);
    if (voices.children.length) choice.append(voices);
    view('apply-voice').disabled = true;
    createForm.hidden = true;
    voiceOptions.hidden = false;
    positionTools();
    choice.focus();
  }

  function applyVoice() {
    if (!range || !choice.value) return;
    const [kind, ...rest] = choice.value.split(':');
    const value = rest.join(':');
    try {
      if (kind === 'role') return applyRole(value);
      const speakers = new Set(chapter.segments.filter(segment =>
        segment.start < range.end && segment.end > range.start).map(segment => segment.speakerId));
      let role = speakers.size === 1 && chapter.roles.find(item =>
        item.id !== VoiceTrackChapter.narratorId && !item.voiceId && speakers.has(item.id));
      if (role) {
        VoiceTrackChapter.assignRange(chapter, range.start, range.end, role.id);
        role.voiceId = value;
        renderRoles();
      } else role = chapter.roles.find(item => item.voiceId === value);
      if (!role) {
        let name = '音色 ' + nextRoleNumber;
        try { name = VoiceTrackChapter.roleName(voiceDisplayName(state.voices.find(item => item.id === value))); } catch (error) { /* Voice IDs may contain punctuation. */ }
        if (chapter.roles.some(item => item.name === name)) name = '音色 ' + nextRoleNumber;
        VoiceTrackChapter.assignRange(chapter, range.start, range.end, 'role-' + nextRoleNumber);
        role = addRole(name, value);
        renderRoles();
      }
      applyRole(role.id);
    } catch (error) { toast(error.message); }
  }

  async function openCreateForm() {
    createForm.reset();
    const roleId = chapter.segments[range.index]?.speakerId;
    const role = chapter.roles.find(item => item.id === roleId && !item.voiceId &&
      item.id !== VoiceTrackChapter.narratorId);
    view('voice-name').value = role?.name || '';
    view('create-status').textContent = '';
    voiceOptions.hidden = true;
    createForm.hidden = false;
    view('design-label').hidden = true;
    positionTools();
    view('voice-name').focus();
    try {
      designPresets = await (await request('/local/design-presets')).json();
      const select = view('design-choice');
      select.replaceChildren(new Option('自定义音色描述', ''), ...designPresets.map(
        (preset, index) => new Option(preset.name, String(index))));
      view('design-label').hidden = !designPresets.length;
      positionTools();
    } catch (error) { /* Custom descriptions remain available. */ }
  }

  async function createVoice(event) {
    event.preventDefault();
    if (!range || submitting) return;
    let name;
    let role;
    const instruction = view('voice-instruction').value.trim();
    if (!instruction) { toast('请填写音色描述。'); return; }
    const selection = range;
    try {
      name = VoiceTrackChapter.roleName(view('voice-name').value);
      role = chapter.roles.find(item => item.name === name);
      if (role?.voiceId || state.voices.some(item => item.saved && voiceDisplayName(item) === name)) {
        throw new Error('该名称已有音色，可选择已有音色或换一个名称。');
      }
      if (!role && chapter.roles.length >= VoiceTrackChapter.maxRoles) throw new Error('角色数量已达到上限。');
      VoiceTrackChapter.assignRange(chapter, selection.start, selection.end, role?.id || 'role-' + nextRoleNumber);
    } catch (error) { toast(error.message); return; }

    submitting = true;
    refresh();
    view('create-status').textContent = '正在生成参考音色…';
    try {
      const text = '天色渐亮，窗外传来轻轻的脚步声。我们先到门口看看，再决定往哪里走。';
      const signal = AbortSignal.timeout(180000);
      const response = await request('/api/speech', {
        method: 'POST', body: buildSpeechForm(text, instruction, '', null, ''), signal
      });
      const clip = await BreezeLongform.readPcm(response, BreezeLongform.sampleRate * 30, signal);
      const reference = BreezeLongform.wav([{ ...clip, start: 0 }], 0);
      const form = new FormData();
      form.append('ref_audio', reference, 'chapter-reference.wav');
      form.append('ref_text', text);
      form.append('description', Array.from(instruction).slice(0, 1000).join(''));
      form.append('metadata', JSON.stringify({ display_name: name }));
      form.append('name', 'chapter-' + crypto.randomUUID());
      const voice = await (await request('/api/voices', { method: 'POST', body: form, signal })).json();
      if (!voice.id) throw new Error('未收到新音色的编号。');
      if (!role) role = addRole(name);
      role.voiceId = voice.id;
      await loadVoices();
      range = selection;
      applyRole(role.id);
      renderRoles();
      toast('已创建并应用「' + name + '」。');
    } catch (error) { view('create-status').textContent = error.message; }
    finally {
      submitting = false;
      refresh();
    }
  }
  function updateAlias() {
    view('merge-role').disabled = !aliasSource.value || !aliasTarget.value ||
      aliasSource.value === VoiceTrackChapter.narratorId || aliasSource.value === aliasTarget.value;
  }

  function refresh(message) {
    const active = Boolean(busy());
    const locked = submitting || active;
    editor.disabled = locked;
    history.disabled = submitting || history.options.length < 2;
    view('open-history').disabled = submitting || !history.value;
    view('new').disabled = submitting;
    view('refresh-history').disabled = submitting;
    const unchanged = job && !dirty();
    const ready = new Set(job?.readySegments || []);
    const hasAudio = unchanged && job.hasPrefix;
    view('play').disabled = view('wav').disabled = view('srt').disabled = !hasAudio;
    view('play').textContent = job?.state === 'complete' ? '试听整章' : '试听已生成片段';
    view('stop').disabled = submitting || !active;
    output.hidden = !active && !hasAudio;
    if (!chapter) {
      status.textContent = message || '';
      return;
    }

    view('page-title').textContent = title.value.trim() || '章节正文';
    let warning;
    try {
      const pieces = prepared();
      const missing = pieces.find(piece => piece.voiceId &&
        !state.voices.some(item => item.saved && item.id === piece.voiceId));
      if (missing) throw new Error('「' + missing.speakerName + '」的参考音色缺失，请重新选择。');
    } catch (error) { warning = error.message; }

    view('save').disabled = locked || !dirty() || chapter.source !== source.value || chapter.mode !== mode.value;
    view('go').disabled = locked || Boolean(warning) || (unchanged && job.state === 'complete');
    view('go').textContent = unchanged && ['canceled', 'failed', 'interrupted'].includes(job.state)
      ? '继续生成' : '生成整章';
    let detail = '';
    if (unchanged) {
      const count = ready.size + ' / ' + chapter.segments.length + ' 段';
      if (job.state === 'running' && job.currentSegment) detail = '正在生成第 ' + job.currentSegment + ' 段 · ' + count;
      else if (job.state === 'draft') detail = '草稿已保存';
      else detail = labels[job.state] + ' · ' + count;
      if (job.error) detail += '。' + job.error;
    }
    status.textContent = message || [detail, active ? '' : warning].filter(Boolean).join('。');
    updateTools();
  }

  function showProject(nextChapter, nextJob) {
    clearTimeout(timer);
    chapter = nextChapter;
    job = nextJob;
    saved = job ? JSON.stringify(payload()) : '';
    nextRoleNumber = 1 + Math.max(0, ...chapter.roles.map(role => Number(/^role-(\d+)$/.exec(role.id)?.[1]) || 0));
    entry.hidden = true;
    player.clear();
    review.hidden = false;
    renderRoles();
    renderDocument();
    refresh();
    schedulePoll();
  }

  function maySwitch() {
    if (!chapter && !source.value.trim() && !title.value.trim()) return true;
    if (chapter && !dirty()) return true;
    return confirm('当前有未保存的内容，确定离开？');
  }

  view('parse').onclick = () => {
    try {
      if (chapter && chapter.source === source.value && chapter.mode === mode.value) {
        entry.hidden = true;
        review.hidden = false;
        return;
      }
      const result = VoiceTrackChapter.readDocument(source.value, mode.value);
      if (chapter && !confirm('重新识别会重建正文的音色批注。继续？')) return;
      for (const role of result.roles) {
        const previous = chapter?.roles.find(item => item.name === role.name);
        if (previous) Object.assign(role, { voiceId: previous.voiceId, instruction: previous.instruction });
      }
      source.value = result.source;
      showProject(result);
    } catch (error) { refresh(error.message); }
  };
  source.oninput = mode.onchange = title.oninput = () => refresh();
  gap.onchange = () => refresh();
  view('add-role').onclick = () => {
    const input = view('new-role');
    try {
      if (chapter.roles.length >= VoiceTrackChapter.maxRoles) throw new Error('角色数量已达到上限。');
      const name = VoiceTrackChapter.roleName(input.value);
      if (chapter.roles.some(role => role.name === name)) throw new Error('角色名已存在。');
      addRole(name);
      input.value = '';
      renderRoles();
      renderDocument();
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
    renderDocument();
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
      if (!title.value.trim()) title.value = selectedFile.name.replace(/\.txt$/i, '').slice(0, 100);
      refresh();
    } catch (error) { toast(error.message); }
    finally {
      file.disabled = false;
      file.value = '';
    }
  };

  async function refreshHistory() {
    try {
      const entries = await (await request(api)).json();
      const previous = history.value || job?.id;
      const options = entries.map(entry => new Option(
        (entry.source === 'agent' ? 'Agent' : '桌面') + ' · ' + entry.title + ' · ' + labels[entry.state], entry.id
      ));
      history.replaceChildren(new Option(entries.length ? '选择章节项目' : '暂无已保存章节', ''), ...options);
      if (entries.some(entry => entry.id === previous)) history.value = previous;
      history.disabled = submitting || !entries.length;
      view('open-history').disabled = submitting || !history.value;
    } catch (error) {
      refresh('无法加载章节历史。' + error.message);
    }
  }

  function schedulePoll() {
    clearTimeout(timer);
    if (busy()) {
      const id = job.id;
      timer = setTimeout(() => poll(id), 750);
    }
  }

  async function poll(id) {
    try {
      const next = await (await request(api + '/' + id)).json();
      if (job?.id !== id || submitting) return;
      job = next;
      refresh();
      if (!busy()) refreshHistory();
    } catch (error) {
      if (job?.id !== id || submitting) return;
      refresh('暂时无法读取任务状态。' + error.message);
    }
    schedulePoll();
  }

  async function openProject() {
    if (!history.value || !maySwitch()) return;
    const id = history.value;
    submitting = true;
    refresh();
    try {
      const { chapter: spec, editor: meta, job: record, includeSpeakers } =
        await (await request(api + '/' + id + '/project')).json();
      const document = VoiceTrackChapter.restoreDocument(meta.source || '', spec.segments, meta.ranges);
      source.value = document.source;
      mode.value = meta.mode || 'script';
      title.value = meta.title || '';
      gap.value = String(spec.pauseMs);
      view('include-speakers').checked = Boolean(includeSpeakers);
      showProject({ ...spec, ...document, mode: mode.value }, record);
      // Voice IDs are stored in the project, while the library may have changed.
      await loadVoices();
      renderRoles();
      refresh();
    } catch (error) { toast(error.message); }
    finally {
      submitting = false;
      refresh();
      schedulePoll();
    }
  }

  async function submit(draft, segmentIndex = null) {
    if (submitting || busy() || !chapter || (draft && !dirty())) return;
    if (source.value !== chapter.source || mode.value !== chapter.mode) return;
    const spec = payload();
    try {
      if (draft) VoiceTrackChapter.validate(spec);
      else prepared();
    } catch (error) { refresh(error.message); return; }
    const resume = !draft && segmentIndex === null && job && !dirty() &&
      ['canceled', 'failed', 'interrupted'].includes(job.state);
    const route = resume ? jobPath() + '/resume' : job ? jobPath() : api;
    const headers = { 'Content-Type': 'application/json' };
    if (!job) headers['Idempotency-Key'] = crypto.randomUUID();
    submitting = true;
    refresh();
    let message;
    try {
      job = await (await request(route, {
        method: job && !resume ? 'PATCH' : 'POST', headers,
        body: resume ? undefined : JSON.stringify({
          ...spec, draft, redoSegment: segmentIndex, includeSpeakers: view('include-speakers').checked
        })
      })).json();
      saved = JSON.stringify(spec);
      player.clear();
      await refreshHistory();
      history.value = job.id;
    } catch (error) { message = error.message; }
    finally {
      submitting = false;
      refresh(message);
      schedulePoll();
    }
  }

  async function stop() {
    if (submitting || !busy()) return;
    const id = job.id;
    clearTimeout(timer);
    submitting = true;
    refresh();
    let message;
    try { job = await (await request(jobPath() + '/cancel', { method: 'POST' })).json(); }
    catch (error) { message = error.message; }
    finally {
      submitting = false;
      refresh(message);
      schedulePoll();
      if (job.id === id && !busy()) refreshHistory();
    }
  }

  async function play(route) {
    const id = job.id;
    try {
      const audio = await (await request(route)).blob();
      if (job?.id === id && !dirty()) player.listen(audio);
    } catch (error) { toast(error.message); }
  }

  function partial(name) {
    return jobPath() + '/partial/chapter.' + name + (view('include-speakers').checked ? '?speakers=1' : '');
  }

  async function download(ext) {
    const filename = (title.value.trim() || job.title).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || '章节配音';
    try { downloadBlob(await (await request(partial(ext))).blob(), filename + '.' + ext); }
    catch (error) { toast(error.message); }
  }

  history.onchange = () => { view('open-history').disabled = submitting || !history.value; };
  view('open-history').onclick = openProject;
  view('refresh-history').onclick = refreshHistory;
  view('new').onclick = () => {
    if (!maySwitch()) return;
    clearTimeout(timer);
    chapter = job = null;
    source.value = title.value = history.value = '';
    mode.value = 'novel';
    gap.value = '500';
    saved = '';
    review.hidden = true;
    entry.hidden = false;
    dismissTools();
    view('include-speakers').checked = false;
    player.clear();
    refresh();
    source.focus();
  };
  paper.addEventListener('pointerdown', () => { if (!submitting) dismissTools(); });
  paper.addEventListener('pointerup', captureSelection);
  paper.addEventListener('keyup', captureSelection);
  document.addEventListener('pointerdown', event => {
    if (!submitting && !paper.contains(event.target) && !tools.contains(event.target)) dismissTools();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !submitting) dismissTools();
  });
  window.addEventListener('scroll', positionTools, { passive: true });
  window.addEventListener('resize', positionTools);
  view('edit-source').onclick = () => {
    dismissTools();
    entry.hidden = false;
    review.hidden = true;
    source.focus();
  };
  view('use-voice').onclick = openVoiceOptions;
  view('new-voice').onclick = openCreateForm;
  view('dismiss-tools').onclick = dismissTools;
  view('preview-mark').onclick = () => play(jobPath() + '/preview/' + range.index);
  view('rerun-mark').onclick = () => {
    const index = range.index;
    dismissTools();
    submit(false, index);
  };
  view('apply-voice').onclick = applyVoice;
  choice.onchange = () => { view('apply-voice').disabled = !choice.value; };
  view('design-choice').onchange = event => {
    const preset = designPresets[event.target.value];
    if (event.target.value && preset) view('voice-instruction').value = preset.instruction;
  };
  createForm.onsubmit = createVoice;
  view('go').onclick = () => submit(false);
  view('save').onclick = () => submit(true);
  view('stop').onclick = stop;
  view('play').onclick = () => play(partial('wav'));
  view('wav').onclick = () => download('wav');
  view('srt').onclick = () => download('srt');

  return refreshHistory;
}
