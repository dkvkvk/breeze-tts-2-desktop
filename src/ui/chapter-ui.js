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
  const lineList = view('lines');
  const palette = view('palette');
  const selectionLabel = view('selection');
  const selectionText = view('selection-text');
  const roleColors = ['#1f5cb5', '#16704f', '#7444aa', '#ab4825', '#a23567',
    '#0d6879', '#896013', '#4053a2', '#975035', '#386321', '#844481', '#246572'];
  const aliasSource = view('alias-source');
  const aliasTarget = view('alias-target');
  const pending = view('pending-only');
  const output = view('output');
  const selected = new Set();
  const player = generatedAudio(view('player'));
  const history = view('history');
  const api = '/api/v1/jobs';
  const labels = { draft: '草稿', queued: '排队中', running: '生成中', complete: '已完成',
    canceled: '已停止', failed: '生成失败', interrupted: '可继续' };
  let chapter;
  let job;
  let saved = '';
  let rows = [];
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

  function assignSelection(id) {
    try {
      if (range) {
        chapter.segments = VoiceTrackChapter.splitSelection(chapter.segments, range.index, range.start, range.end, id);
      } else {
        for (const index of selected) chapter.segments[index].speakerId = id;
      }
      selected.clear();
      renderLines();
      refresh();
    } catch (error) { toast(error.message); }
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
    palette.replaceChildren(...chapter.roles.map(role => {
      const button = action(role.name, () => assignSelection(role.id), '分配给' + role.name);
      button.className = 'chapter-speaker-button';
      button.dataset.roleId = role.id;
      colorRole(button, role.id);
      return button;
    }));
    selectRoles(aliasSource, aliasSource.value, '选择别名');
    const narrator = aliasSource.querySelector('option[value="narrator"]');
    if (narrator) narrator.disabled = true;
    selectRoles(aliasTarget, aliasTarget.value, '保留的角色');
    updateAlias();
  }

  function renderLines() {
    range = null;
    rows = chapter.segments.map((segment, index) => {
      const li = document.createElement('li');
      const controls = document.createElement('div');
      const checked = document.createElement('input');
      const speaker = document.createElement('select');
      const text = document.createElement('textarea');
      const number = document.createElement('span');
      number.className = 'chapter-line-number';
      number.textContent = String(index + 1).padStart(2, '0');
      controls.className = 'chapter-line-controls';
      li.className = 'chapter-turn';
      colorRole(li, segment.speakerId);
      checked.type = 'checkbox';
      checked.checked = selected.has(index);
      checked.setAttribute('aria-label', '选中第 ' + (index + 1) + ' 段');
      checked.onchange = () => {
        range = null;
        if (checked.checked) selected.add(index);
        else selected.delete(index);
        updateSelection();
      };
      selectRoles(speaker, segment.speakerId, '待确认');
      speaker.className = 'chapter-line-speaker';
      speaker.setAttribute('aria-label', '第 ' + (index + 1) + ' 段说话人');
      speaker.onchange = () => {
        segment.speakerId = speaker.value || null;
        colorRole(li, segment.speakerId);
        if (pending.checked) renderLines();
        refresh();
      };
      text.rows = 2;
      text.value = segment.text;
      text.setAttribute('aria-label', '第 ' + (index + 1) + ' 段台词');
      text.oninput = () => {
        if (range?.index === index) range = null;
        segment.text = text.value;
        refresh();
      };
      text.onselect = text.onpointerup = () => {
        const start = text.selectionStart;
        const end = text.selectionEnd;
        if (end > start && text.value.slice(start, end).trim()) {
          range = { index, start, end };
          selected.clear();
        } else if (range?.index === index || document.activeElement === text) range = null;
        updateSelection();
      };
      const preview = action('试听', () => play(jobPath() + '/preview/' + index), '试听第 ' + (index + 1) + ' 段');
      const rerun = action('重录', () => submit(false, index), '重录第 ' + (index + 1) + ' 段');
      const detail = document.createElement('span');
      detail.className = 'longform-note';
      controls.append(checked, number, speaker, detail, preview, rerun);
      li.append(controls, text);
      li.hidden = pending.checked && Boolean(segment.speakerId);
      return { li, checked, preview, rerun, detail };
    });
    lineList.replaceChildren(...rows.map(row => row.li));
  }

  function updateSelection() {
    for (const button of palette.children) button.disabled = !range && !selected.size;
    rows.forEach(({ li, checked }, index) => {
      checked.checked = selected.has(index);
      li.classList.toggle('is-selected', checked.checked || range?.index === index);
    });
    selectionText.hidden = !range;
    if (range) {
      selectionLabel.textContent = '已选中第 ' + (range.index + 1) + ' 段文字';
      selectionText.textContent = chapter.segments[range.index].text.slice(range.start, range.end);
    } else {
      selectionLabel.textContent = selected.size
        ? '已勾选 ' + selected.size + ' 段台词'
        : '选中文字或勾选整段，再点击下方角色。';
      selectionText.textContent = '';
    }
  }

  function updateAlias() {
    view('merge-role').disabled = !aliasSource.value || !aliasTarget.value ||
      aliasSource.value === VoiceTrackChapter.narratorId || aliasSource.value === aliasTarget.value;
  }

  function turnAudioKey(spec, index) {
    const segment = spec.segments[index];
    const role = spec.roles.find(item => item.id === segment?.speakerId);
    return JSON.stringify([segment?.text.trim(), role?.voiceId.trim(), role?.instruction.trim()]);
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

    let warning;
    try {
      const pieces = prepared();
      const missing = pieces.find(piece => piece.voiceId &&
        !state.voices.some(item => item.saved && item.id === piece.voiceId));
      if (missing) throw new Error('「' + missing.speakerName + '」的参考音色缺失，请重新选择。');
    } catch (error) { warning = error.message; }

    const prior = job && !unchanged && saved ? JSON.parse(saved) : null;
    const priorPositions = prior && new Map(prior.segments.map((segment, index) => [segment.slot ?? index, index]));
    let affected = 0;
    rows.forEach(({ preview, rerun, detail }, index) => {
      const previousIndex = priorPositions ? priorPositions.get(chapter.segments[index].slot ?? index) : index;
      const recorded = ready.has(previousIndex);
      const changed = recorded && prior && turnAudioKey(prior, previousIndex) !== turnAudioKey(chapter, index);
      if (changed) affected++;
      preview.disabled = !unchanged || !ready.has(index);
      rerun.disabled = locked || Boolean(warning) || !job || job.state === 'draft';
      if (!chapter.segments[index].speakerId) detail.textContent = '待确认';
      else if (changed) detail.textContent = '待更新';
      else detail.textContent = recorded ? '已生成' : '待生成';
    });
    view('save').disabled = locked || !dirty() || chapter.source !== source.value || chapter.mode !== mode.value;
    view('go').disabled = locked || Boolean(warning) || (unchanged && job.state === 'complete');
    view('go').textContent = unchanged && ['canceled', 'failed', 'interrupted'].includes(job.state)
      ? '继续生成' : '生成整章';
    let detail = affected ? affected + ' 段台词待更新' : '';
    if (unchanged) {
      const count = ready.size + ' / ' + rows.length + ' 段';
      if (job.state === 'running' && job.currentSegment) detail = '正在生成第 ' + job.currentSegment + ' 段 · ' + count;
      else if (job.state === 'draft') detail = '草稿已保存';
      else detail = labels[job.state] + ' · ' + count;
      if (job.error) detail += '。' + job.error;
    }
    status.textContent = message || [detail, active ? '' : warning].filter(Boolean).join('。');
    updateSelection();
  }

  function showProject(nextChapter, nextJob) {
    clearTimeout(timer);
    chapter = nextChapter;
    job = nextJob;
    saved = job ? JSON.stringify(payload()) : '';
    nextRoleNumber = 1 + Math.max(0, ...chapter.roles.map(role => Number(/^role-(\d+)$/.exec(role.id)?.[1]) || 0));
    selected.clear();
    pending.checked = false;
    player.clear();
    review.hidden = false;
    renderRoles();
    renderLines();
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
      const result = VoiceTrackChapter.parse(source.value, mode.value);
      if (chapter && !confirm('重新解析会开启一份新的章节。已经保存的项目可以从历史记录打开。继续？')) return;
      showProject(result);
    } catch (error) { refresh(error.message); }
  };
  source.oninput = mode.onchange = title.oninput = () => refresh();
  gap.onchange = () => refresh();
  pending.onchange = () => { selected.clear(); renderLines(); refresh(); };
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
      source.value = meta.source || spec.segments.map(({ text, speakerId }) => {
        const role = spec.roles.find(role => role.id === speakerId);
        return role && role.id !== VoiceTrackChapter.narratorId ? role.name + '：' + text : text;
      }).join('\n');
      mode.value = meta.mode || 'script';
      title.value = meta.title || '';
      gap.value = String(spec.pauseMs);
      view('include-speakers').checked = Boolean(includeSpeakers);
      showProject({ ...spec, source: source.value, mode: mode.value }, record);
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
    mode.value = 'script';
    gap.value = '500';
    saved = '';
    review.hidden = true;
    view('include-speakers').checked = false;
    player.clear();
    refresh();
    source.focus();
  };
  view('go').onclick = () => submit(false);
  view('save').onclick = () => submit(true);
  view('stop').onclick = stop;
  view('play').onclick = () => play(partial('wav'));
  view('wav').onclick = () => download('wav');
  view('srt').onclick = () => download('srt');

  return refreshHistory;
}
