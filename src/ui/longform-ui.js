'use strict';

function bindLongform() {
  const text = $('b-text');
  const file = $('b-file');
  const instruction = $('b-inst');
  const voice = $('b-voice');
  const gap = $('b-gap');
  const go = $('b-go');
  const stop = $('b-stop');
  const player = $('b-player');
  const playAll = $('b-play');
  const wave = $('b-wav');
  const subtitles = $('b-srt');
  const progress = $('b-progress');
  const status = $('b-status');
  const list = $('b-list');
  const copyInstruction = $('b-use-design');
  const saveDraft = $('b-draft');
  let pieces = [];
  let rows = [];
  let job = null;
  let active = false;
  let importing = false;
  let audioUrl = '';
  let name = 'breeze-长文配音';

  function inputs() {
    return { text: text.value, instruction: instruction.value.trim(), voiceId: voice.value, pauseMs: Number(gap.value) };
  }

  function canResume() {
    return job && job.completed.length < job.pieces.length && job.name === name && job.key === JSON.stringify(inputs());
  }

  function refresh() {
    try {
      pieces = BreezeLongform.splitScript(text.value);
      $('b-plan').textContent = pieces.length ? '将分为 ' + pieces.length + ' 段' : '请导入 TXT 或输入脚本。';
    } catch (error) {
      pieces = [];
      $('b-plan').textContent = error.message;
    }
    go.disabled = active || importing || !pieces.length;
    saveDraft.disabled = importing || !pieces.length;
    go.textContent = canResume() ? '继续生成' : job ? '重新生成' : '开始生成';
  }

  function clearPlayer() {
    player.pause();
    player.removeAttribute('src');
    player.load();
    player.hidden = true;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = '';
  }

  function listen(blob) {
    clearPlayer();
    audioUrl = URL.createObjectURL(blob);
    player.src = audioUrl;
    player.hidden = false;
    player.play().catch(() => {});
  }

  function download(blob, filename) {
    const anchor = document.createElement('a');
    const url = URL.createObjectURL(blob);
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function makeRows() {
    rows = job.pieces.map((piece, index) => {
      const row = document.createElement('li');
      const line = document.createElement('span');
      line.className = 'longform-line';
      line.textContent = piece;
      const note = document.createElement('span');
      note.className = 'longform-note';
      const preview = document.createElement('button');
      preview.className = 'btn btn-sm';
      preview.textContent = '试听';
      preview.setAttribute('aria-label', '试听第 ' + (index + 1) + ' 段');
      preview.onclick = () => listen(BreezeLongform.wav([job.completed[index]], 0));
      row.append(line, note, preview);
      return { row, note, preview };
    });
    list.replaceChildren(...rows.map(entry => entry.row));
  }

  function showProgress(current, message) {
    const n = job.completed.length;
    progress.max = job.pieces.length;
    progress.value = n;
    status.textContent = message || '已完成 ' + n + ' / ' + job.pieces.length + ' 段' +
      (current === null ? '' : '，正在生成第 ' + (current + 1) + ' 段');
    rows.forEach(({ note, preview }, index) => {
      preview.hidden = index >= n;
      note.textContent = index < n ? fmtSec(job.completed[index].samples / BreezeLongform.sampleRate) :
        index === current ? '生成中' : '待生成';
    });
    wave.disabled = subtitles.disabled = playAll.disabled = n === 0;
  }

  text.addEventListener('input', refresh);
  instruction.addEventListener('input', refresh);
  voice.addEventListener('change', refresh);
  gap.addEventListener('change', refresh);
  copyInstruction.onclick = () => {
    const description = $('d-inst').value.trim();
    if (!description) { toast('请先在音色设计页填写描述或套用预设。'); return; }
    instruction.value = description;
    refresh();
  };

  file.onchange = async () => {
    const script = fileOf(file);
    if (!script) return;
    importing = true;
    file.disabled = true;
    refresh();
    try {
      const isDraft = /\.json$/i.test(script.name);
      if (!isDraft && !/\.txt$/i.test(script.name)) throw new Error('请选择 .txt 或 Breeze 配音草稿 .json 文件。');
      const maxSize = isDraft ? BreezeLongform.maxDraftBytes : 4 * BreezeLongform.maxChars + 3;
      if (script.size > maxSize) throw new Error('文件太大，请拆成多个文件。');
      let value;
      try { value = new TextDecoder('utf-8', { fatal: true }).decode(await script.arrayBuffer()); }
      catch (error) { throw new Error('无法读取文件，请另存为 UTF-8 后重试。'); }
      if (isDraft) {
        const draft = BreezeLongform.decodeDraft(value);
        text.value = draft.text;
        instruction.value = draft.instruction;
        gap.value = String(draft.pauseMs);
        const foundVoice = Array.from(voice.options).some(option => option.value === draft.voiceId);
        voice.value = foundVoice ? draft.voiceId : '';
        if (!foundVoice) toast('草稿中的参考音色不在当前音色库，请重新选择。');
      } else {
        if (!BreezeLongform.splitScript(value).length) throw new Error('TXT 中没有可合成的台词。');
        text.value = value;
      }
      name = script.name.replace(/(?:\.breeze-project)?\.json$|\.txt$/i, '').trim() || 'breeze-长文配音';
    } catch (error) {
      toast(error.message);
    } finally {
      file.value = '';
      importing = false;
      file.disabled = false;
      refresh();
    }
  };

  saveDraft.onclick = () => {
    try {
      const draft = BreezeLongform.encodeDraft(inputs());
      download(new Blob([draft], { type: 'application/json' }), name + '.breeze-project.json');
    } catch (error) {
      toast(error.message);
    }
  };

  stop.onclick = () => { if (active) stopStream(); };
  playAll.onclick = () => listen(BreezeLongform.wav(job.completed, job.gapSamples));
  wave.onclick = () => download(BreezeLongform.wav(job.completed, job.gapSamples), job.name + '.wav');
  subtitles.onclick = () => download(new Blob([BreezeLongform.srt(job.completed)], { type: 'text/plain;charset=utf-8' }), job.name + '.srt');

  go.onclick = async () => {
    if (state.abort) { toast('已有合成任务，完成或停止后再生成。'); return; }
    if (importing || !pieces.length) return;
    const settings = inputs();
    if (!canResume()) {
      clearPlayer();
      job = BreezeLongform.createJob(pieces, settings.pauseMs);
      job.key = JSON.stringify(settings);
      job.name = name;
      makeRows();
    }
    const controller = new AbortController();
    state.abort = controller;
    active = true;
    const controls = [text, file, instruction, voice, gap, copyInstruction];
    controls.forEach(control => { control.disabled = true; });
    stop.disabled = false;
    $('b-result').hidden = false;
    refresh();
    resetPlayback();
    setStatus('busy', '正在生成长文');
    let message;
    try {
      await BreezeLongform.runJob(job, (piece, signal) => fetch('/api/speech', {
        method: 'POST', body: buildSpeechForm(piece, settings.instruction, settings.voiceId, null, ''), signal
      }), controller.signal, index => showProgress(index));
      message = '全部 ' + job.completed.length + ' 段已生成，共 ' + fmtSec(job.samples / BreezeLongform.sampleRate) + '。';
    } catch (error) {
      const n = job.completed.length;
      message = controller.signal.aborted ? '已停止。' : '第 ' + (n + 1) + ' 段生成失败：' + error.message;
      message += ' 已保留 ' + n + ' 个完整片段。';
    } finally {
      active = false;
      state.abort = null;
      controls.forEach(control => { control.disabled = false; });
      stop.disabled = true;
      setStatus('ok', '就绪');
      refresh();
      showProgress(null, message);
    }
  };

  refresh();
}
