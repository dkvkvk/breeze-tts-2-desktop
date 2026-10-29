'use strict';
/* Breeze TTS 2 — 中文界面逻辑 */
var SR = 24000;
var $ = function (id) { return document.getElementById(id); };
var state = { voices: [], audioCtx: null, playHead: 0, abort: null, gain: null, nodes: [] };

function toast(msg, ms) {
  var t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(function () { t.hidden = true; }, ms || 2600);
}

function fmtSec(s) {
  if (!isFinite(s)) return '—';
  if (s < 60) return s.toFixed(2) + ' 秒';
  var m = Math.floor(s / 60);
  return m + ' 分 ' + (s - m * 60).toFixed(1) + ' 秒';
}
function fmtSize(b) {
  if (!b) return '0 MB';
  return (b / 1048576).toFixed(1) + ' MB';
}

/* ---------------- WAV ---------------- */
function wavBlob(parts, total) {
  var buf = new ArrayBuffer(44 + total * 2);
  var v = new DataView(buf);
  function str(off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); }
  str(0, 'RIFF'); v.setUint32(4, 36 + total * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, total * 2, true);
  var off = 44;
  for (var p = 0; p < parts.length; p++) {
    var a = parts[p];
    for (var i = 0; i < a.length; i++) { v.setInt16(off, a[i], true); off += 2; }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/* ---------------- 播放 ---------------- */
function audioCtx() {
  if (!state.audioCtx) {
    var C = window.AudioContext || window.webkitAudioContext;
    state.audioCtx = new C({ sampleRate: SR });
  }
  if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
  return state.audioCtx;
}

function resetPlayback() {
  state.nodes.forEach(function (n) { try { n.stop(); } catch (e) {} });
  state.nodes = [];
  state.playHead = 0;
  if (state.audioCtx) state.playHead = state.audioCtx.currentTime + 0.08;
}

function queuePCM(int16) {
  var ctx = audioCtx();
  if (!state.playHead) state.playHead = ctx.currentTime + 0.08;
  var f = new Float32Array(int16.length);
  var peak = 0;
  for (var i = 0; i < int16.length; i++) {
    var x = int16[i] / 32768;
    f[i] = x;
    if (Math.abs(x) > peak) peak = Math.abs(x);
  }
  var b = ctx.createBuffer(1, f.length, SR);
  b.copyToChannel(f, 0);
  var src = ctx.createBufferSource();
  src.buffer = b;
  if (!state.gain) { state.gain = ctx.createGain(); state.gain.connect(ctx.destination); }
  src.connect(state.gain);
  var at = Math.max(ctx.currentTime + 0.02, state.playHead);
  src.start(at);
  state.playHead = at + b.duration;
  state.nodes.push(src);
  return peak;
}

function makeWave(n) {
  var w = document.createElement('div');
  w.className = 'wave';
  for (var i = 0; i < n; i++) w.appendChild(document.createElement('i'));
  return w;
}
function pumpWave(waveEl, peak, idx) {
  var bars = waveEl.children;
  var h = Math.max(2, Math.min(40, peak * 120));
  bars[idx % bars.length].style.height = h.toFixed(0) + 'px';
  bars[idx % bars.length].className = 'is-live';
}

/* ---------------- 流式合成 ---------------- */
function streamSpeech(url, form, ui, onDone) {
  var parts = [];
  var total = 0;
  var carry = null;
  var t0 = performance.now();
  var ttfa = 0;
  var bars = 0;
  var ac = new AbortController();
  state.abort = ac;
  resetPlayback();
  ui.stop.disabled = false;
  ui.go.disabled = true;
  setStatus('busy', '正在生成');

  var card = document.createElement('div');
  card.className = 'card';
  var wave = makeWave(48);
  card.appendChild(wave);
  var meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = '<span>已生成 <b data-k="sec">0.00</b> 秒</span><span>首音 <b data-k="ttfa">—</b></span><span>状态 <b data-k="st">合成中</b></span>';
  card.appendChild(meta);
  var player = document.createElement('audio');
  player.controls = true;
  player.hidden = true;
  card.appendChild(player);
  var dl = document.createElement('button');
  dl.className = 'btn btn-sm';
  dl.textContent = '下载 WAV';
  dl.hidden = true;
  var row = document.createElement('div');
  row.className = 'btn-row';
  row.appendChild(dl);
  card.appendChild(row);
  ui.out.innerHTML = '';
  ui.out.appendChild(card);

  var q = function (k) { return meta.querySelector('[data-k="' + k + '"]'); };
  var blobUrl = null;
  dl.onclick = function () { if (blobUrl) { var a = document.createElement('a'); a.href = blobUrl; a.download = 'breeze-' + Date.now() + '.wav'; a.click(); } };

  fetch(url, { method: 'POST', body: form, signal: ac.signal })
    .then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { throw new Error(res.status + ' ' + t); });
      }
      var reader = res.body.getReader();
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return null;
          var chunk = r.value;
          if (!ttfa) { ttfa = performance.now() - t0; q('ttfa').textContent = (ttfa / 1000).toFixed(2) + ' 秒'; }
          var bytes = chunk;
          if (carry) {
            var merged = new Uint8Array(carry.length + chunk.length);
            merged.set(carry, 0); merged.set(chunk, carry.length);
            bytes = merged; carry = null;
          }
          var usable = bytes.length - (bytes.length % 2);
          if (usable !== bytes.length) carry = bytes.slice(usable);
          if (!usable) return pump();
          var i16 = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + usable));
          parts.push(i16);
          total += i16.length;
          q('sec').textContent = (total / SR).toFixed(2);
          pumpWave(wave, queuePCM(i16), bars++);
          return pump();
        });
      }
      return pump();
    })
    .then(function () {
      q('st').textContent = '完成';
      var wall = (performance.now() - t0) / 1000;
      var audio = total / SR;
      var extra = document.createElement('span');
      extra.innerHTML = '音频 <b>' + fmtSec(audio) + '</b></span><span>耗时 <b>' + fmtSec(wall) + '</b></span><span>实时率 <b>' +
        (audio > 0 ? (wall / audio).toFixed(2) : '—') + '</b></span>';
      meta.insertAdjacentHTML('beforeend', extra.innerHTML);
      if (total > 0) {
        var blob = wavBlob(parts, total);
        blobUrl = URL.createObjectURL(blob);
        player.src = blobUrl;
        player.hidden = false;
        dl.hidden = false;
      }
      setStatus('ok', '就绪');
      ui.go.disabled = false;
      ui.stop.disabled = true;
      state.abort = null;
      if (onDone) onDone(total / SR);
    })
    .catch(function (e) {
      if (e.name === 'AbortError') { q('st').textContent = '已停止'; setStatus('ok', '就绪'); }
      else {
        q('st').textContent = '失败';
        var err = document.createElement('div');
        err.className = 'card err';
        err.innerHTML = '<div class="msg"></div>';
        err.querySelector('.msg').textContent = String(e.message || e);
        ui.out.appendChild(err);
        setStatus('ok', '就绪');
      }
      ui.go.disabled = false;
      ui.stop.disabled = true;
      state.abort = null;
    });
}

function stopStream() { if (state.abort) state.abort.abort(); }

/* ---------------- 状态 ---------------- */
function setStatus(kind, text) {
  var s = $('status');
  s.className = 'status ' + (kind === 'busy' ? 'busy' : 'ok');
  $('statusText').textContent = text;
}

/* ---------------- 音色库 ---------------- */
function loadVoices() {
  return fetch('/api/voices').then(function (r) { return r.json(); }).then(function (list) {
    state.voices = Array.isArray(list) ? list : [];
    renderVoices();
    return state.voices;
  }).catch(function () { state.voices = []; renderVoices(); });
}

function renderVoices() {
  var lib = state.voices.filter(function (v) { return v.saved; });
  $('libCount').textContent = String(lib.length);
  var list = $('libList');
  list.innerHTML = '';
  if (!lib.length) {
    var e = document.createElement('div');
    e.className = 'lib-empty';
    e.textContent = '还没有保存的音色。到「音色克隆」上传一段录音并保存。';
    list.appendChild(e);
  }
  lib.forEach(function (v) {
    var row = document.createElement('div');
    row.className = 'lib-row';
    var left = document.createElement('div');
    var id = document.createElement('div');
    id.className = 'lib-id';
    id.textContent = v.id;
    if (!v.saved) { var c = document.createElement('span'); c.className = 'lib-cached'; c.textContent = '缓存'; id.appendChild(c); }
    left.appendChild(id);
    var d = document.createElement('div');
    d.className = 'lib-desc';
    d.textContent = v.description || (v.ref_text ? ('「' + String(v.ref_text).slice(0, 40) + '」') : '无描述');
    left.appendChild(d);
    row.appendChild(left);
    var len = document.createElement('div');
    len.className = 'lib-len';
    len.textContent = fmtSec(v.seconds || 0);
    row.appendChild(len);
    var del = document.createElement('button');
    del.className = 'btn btn-sm btn-ghost';
    del.textContent = '移除';
    del.onclick = function () {
      if (!confirm('从列表移除「' + v.id + '」？磁盘文件会保留。')) return;
      fetch('/api/voices/' + encodeURIComponent(v.id), { method: 'DELETE' }).then(loadVoices).then(function () { toast('已移除 ' + v.id); });
    };
    row.appendChild(del);
    list.appendChild(row);
  });

  var opts = state.voices.map(function (v) {
    return { id: v.id, t: v.id + '  ·  ' + fmtSec(v.seconds || 0) + (v.saved ? '' : '（缓存）') };
  });
  [['c-voice', opts], ['v-voice', opts]].forEach(function (pair) {
    var sel = $(pair[0]);
    var prev = sel.value;
    sel.innerHTML = '';
    if (!opts.length) {
      var o = document.createElement('option');
      o.value = ''; o.textContent = '（音色库为空）';
      sel.appendChild(o);
      return;
    }
    opts.forEach(function (o1) {
      var o = document.createElement('option');
      o.value = o1.id; o.textContent = o1.t;
      sel.appendChild(o);
    });
    if (prev && opts.some(function (x) { return x.id === prev; })) sel.value = prev;
  });
  var rv = $('r-voice');
  var prevR = rv.value;
  rv.innerHTML = '<option value="">不使用（仅靠指令）</option>';
  opts.forEach(function (o1) {
    var o = document.createElement('option');
    o.value = o1.id; o.textContent = o1.t;
    rv.appendChild(o);
  });
  rv.value = prevR || '';
}

/* ---------------- 页面切换 ---------------- */
var PAGES = {
  design: ['音色设计', '用一段文字描述你想要的声音，模型直接合成。'],
  clone: ['音色克隆', '给一段参考录音，让模型用那个声音说话。'],
  direct: ['表演指挥', '用自然语言指挥语气、语速与情绪。'],
  convert: ['变声转换', '保留原录音的说话节奏，只换掉说话的人。'],
  library: ['音色库', '管理已保存的音色，供其余页面直接调用。']
};
function switchTab(name) {
  Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) {
    b.classList.toggle('is-on', b.dataset.tab === name);
  });
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (p) {
    p.hidden = p.dataset.panel !== name;
  });
  $('pageTitle').textContent = PAGES[name][0];
  $('pageDesc').textContent = PAGES[name][1];
  if (name === 'library') loadVoices();
  if (name === 'clone' || name === 'convert') syncCloneMode();
}

/* ---------------- 表单读取 ---------------- */
function fileOf(input) { return input.files && input.files[0] ? input.files[0] : null; }

function buildSpeechForm(text, instruction, voiceId, refAudio, refText) {
  var f = new FormData();
  f.append('text', text);
  if (instruction) f.append('instruction', instruction);
  if (voiceId) f.append('voice_id', voiceId);
  if (refAudio) { f.append('ref_audio', refAudio, refAudio.name); f.append('ref_text', refText || ''); }
  return f;
}

/* ---------------- 各页面绑定 ---------------- */
function ui(p) {
  return { go: $(p + '-go'), stop: $(p + '-stop'), out: $(p + '-out') };
}

function bindDesign() {
  var u = ui('d');
  u.stop.onclick = stopStream;
  u.go.onclick = function () {
    var text = $('d-text').value.trim();
    if (!text) { toast('台词不能为空'); return; }
    streamSpeech('/api/speech', buildSpeechForm(text, $('d-inst').value.trim(), '', null, ''), u);
  };
}

var cloneMode = 'library';
function syncCloneMode() {
  $('c-library').hidden = cloneMode !== 'library';
  $('c-upload').hidden = cloneMode !== 'upload';
  Array.prototype.forEach.call(document.querySelectorAll('#c-src .seg-item'), function (b) {
    b.classList.toggle('is-on', b.dataset.mode === cloneMode);
  });
}
function bindClone() {
  var u = ui('c');
  u.stop.onclick = stopStream;
  Array.prototype.forEach.call(document.querySelectorAll('#c-src .seg-item'), function (b) {
    b.onclick = function () { cloneMode = b.dataset.mode; syncCloneMode(); };
  });
  $('c-save').onclick = function () {
    var file = fileOf($('c-file'));
    var refText = $('c-reftext').value.trim();
    var name = $('c-name').value.trim();
    if (!file) { toast('请先选择参考音频'); return; }
    if (!refText) { toast('逐字稿必须填写'); return; }
    if (!name) { toast('请填写保存名'); return; }
    var f = new FormData();
    f.append('ref_audio', file, file.name);
    f.append('ref_text', refText);
    f.append('name', name);
    if ($('c-desc').value.trim()) f.append('description', $('c-desc').value.trim());
    setStatus('busy', '正在保存音色');
    fetch('/api/voices', { method: 'POST', body: f })
      .then(function (r) { if (!r.ok) throw new Error('保存失败 ' + r.status); return r.json(); })
      .then(function () { toast('已保存 ' + name); return loadVoices(); })
      .then(function () { setStatus('ok', '就绪'); })
      .catch(function (e) { toast(String(e.message || e)); setStatus('ok', '就绪'); });
  };
  u.go.onclick = function () {
    var text = $('c-text').value.trim();
    if (!text) { toast('台词不能为空'); return; }
    if (cloneMode === 'library') {
      var vid = $('c-voice').value;
      if (!vid) { toast('音色库为空，请改用上传录音'); return; }
      streamSpeech('/api/speech', buildSpeechForm(text, '', vid, null, ''), u);
    } else {
      var file = fileOf($('c-file'));
      var refText = $('c-reftext').value.trim();
      if (!file) { toast('请先选择参考音频'); return; }
      if (!refText) { toast('逐字稿必须填写'); return; }
      streamSpeech('/api/speech', buildSpeechForm(text, '', '', file, refText), u);
    }
  };
}

function bindDirect() {
  var u = ui('r');
  u.stop.onclick = stopStream;
  Array.prototype.forEach.call(document.querySelectorAll('#r-chips .chip'), function (c) {
    c.onclick = function () { $('r-inst').value = c.textContent; };
  });
  u.go.onclick = function () {
    var text = $('r-text').value.trim();
    if (!text) { toast('台词不能为空'); return; }
    var inst = $('r-inst').value.trim();
    streamSpeech('/api/speech', buildSpeechForm(text, inst, $('r-voice').value, null, ''), u);
  };
}

function bindConvert() {
  var u = ui('v');
  u.stop.onclick = stopStream;
  u.go.onclick = function () {
    var file = fileOf($('v-file'));
    if (!file) { toast('请先选择源录音'); return; }
    var vid = $('v-voice').value;
    if (!vid) { toast('请选择目标音色'); return; }
    var f = new FormData();
    f.append('source', file, file.name);
    f.append('voice_id', vid);
    if ($('v-text').value.trim()) f.append('text', $('v-text').value.trim());
    f.append('keep_acoustic', $('v-keep').value || '0');
    f.append('temperature', $('v-temp').value || '0.3');
    f.append('seed', $('v-seed').value || '42');
    streamSpeech('/api/convert', f, u);
  };
}

/* ---------------- 首次运行：下载模型 ---------------- */
function downloadFlow() {
  var bar = $('bootBar'), hint = $('bootHint'), txt = $('bootText');
  txt.textContent = '正在下载模型（约 2.4 GB）';
  hint.textContent = '首次运行需要下载模型文件，可关闭窗口稍后继续（支持断点续传）。';
  fetch('/local/download', { method: 'POST' });
  var timer = setInterval(function () {
    fetch('/local/status').then(function (r) { return r.json(); }).then(function (s) {
      if (s.modelBytes && s.modelTotal) {
        var pct = Math.min(100, s.modelBytes / s.modelTotal * 100);
        bar.style.width = pct.toFixed(1) + '%';
        hint.textContent = fmtSize(s.modelBytes) + ' / ' + fmtSize(s.modelTotal) + '　' +
          pct.toFixed(1) + '%　' + (s.speedText || '');
      }
      if (s.modelPresent) { clearInterval(timer); boot(); }
      if (s.error) {
        clearInterval(timer);
        txt.textContent = '下载失败';
        hint.textContent = s.error + '　刷新页面可重试（已下载部分会续传）。';
      }
    }).catch(function () {});
  }, 1500);
}

function boot() {
  fetch('/local/status').then(function (r) { return r.json(); }).then(function (s) {
    $('sideMeta').innerHTML = 'v' + (s.version || '?') + '<br>' + (s.backend || '') + (s.serverPort ? ('　端口 ' + s.serverPort) : '');
    if (!s.modelPresent) {
      $('bootText').textContent = '尚未安装模型';
      if ($('bootHint').querySelector('.boot-pick')) return;
      var b = document.createElement('button');
      b.className = 'btn btn-primary';
      b.textContent = '下载模型（2.4 GB）';
      b.onclick = function () { b.remove(); downloadFlow(); };
      b.classList.add('boot-pick');
      $('bootHint').appendChild(b);
      var b2 = document.createElement('button');
      b2.className = 'btn btn-sm boot-pick boot-alt';
      b2.textContent = '使用本地模型文件…';
      b2.onclick = function () {
        fetch('/local/pick-model', { method: 'POST' }).then(function () { boot(); });
      };
      $('bootHint').appendChild(b2);
      return;
    }
    if (!s.serverReady) {
      $('bootText').textContent = s.starting ? '正在加载模型' : '正在启动推理服务';
      $('bootHint').textContent = s.message || '首次加载约需 10–20 秒。';
      $('bootBar').style.width = '55%';
      setTimeout(boot, 1200);
      return;
    }
    $('bootBar').style.width = '100%';
    $('boot').hidden = true;
    $('app').hidden = false;
    setStatus('ok', '就绪');
    loadVoices();
    var h = (location.hash || '').replace('#', '');
    switchTab(PAGES[h] ? h : 'design');
    if (h === 'api') $('api-open').click();
  }).catch(function (e) {
    $('bootText').textContent = '无法连接本地服务';
    $('bootHint').textContent = String(e.message || e);
  });
}

/* ---------------- 启动 ---------------- */
Array.prototype.forEach.call(document.querySelectorAll('.nav-item'), function (b) {
  b.onclick = function () { switchTab(b.dataset.tab); };
});
$('lib-refresh').onclick = function () { loadVoices().then(function () { toast('已刷新'); }); };
bindDesign(); bindClone(); bindDirect(); bindConvert();
boot();

/* ---------------- 导入音色 ---------------- */
var impQueue = [];
var IMP_MAX_SECONDS = 30;

function impStem(name) {
  var s = String(name || '').replace(/\.[^.]+$/, '');
  s = s.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '');
  return s || ('voice_' + (impQueue.length + 1));
}

function impRow(it) {
  var row = document.createElement('div');
  row.className = 'imp-row';
  var head = document.createElement('div');
  head.className = 'imp-row-head';
  var nm = document.createElement('div');
  nm.className = 'imp-row-name';
  nm.textContent = it.name;
  nm.title = it.file ? it.file.name : it.name;
  var meta = document.createElement('div');
  meta.className = 'imp-row-meta';
  meta.textContent = '读取中…';
  head.appendChild(nm); head.appendChild(meta);

  var txt = document.createElement('input');
  txt.type = 'text';
  txt.placeholder = '参考文本（与录音逐字一致）';
  txt.value = it.refText || '';
  txt.oninput = function () { it.refText = txt.value; };

  var st = document.createElement('span');
  st.className = 'imp-state';
  st.textContent = '读取中';

  row.appendChild(head); row.appendChild(txt); row.appendChild(st);
  it.el = { row: row, meta: meta, state: st, text: txt };
  $('imp-list').appendChild(row);
  return it;
}

function impUpdate(it) {
  if (!it.el) return;
  var st = it.el.state, meta = it.el.meta;
  if (it.status === 'reading') { st.className = 'imp-state'; st.textContent = '读取中'; meta.textContent = '解码中…'; return; }
  if (it.status === 'error') { st.className = 'imp-state err'; st.textContent = '失败'; meta.textContent = it.error || '无法解码'; return; }
  if (it.status === 'running') { st.className = 'imp-state'; st.textContent = '导入中'; return; }
  if (it.status === 'done') { st.className = 'imp-state ok'; st.textContent = '已导入'; return; }
  st.className = 'imp-state';
  st.textContent = '待导入';
  meta.textContent = it.seconds.toFixed(1) + ' 秒 · ' + fmtSize(it.blob.size) + (it.trimmed ? ' · 已截断到 ' + IMP_MAX_SECONDS + ' 秒' : '');
}

function impRefreshActions() {
  var live = impQueue.filter(function (it) { return it.status === 'ready' || it.status === 'error' || it.status === 'done'; });
  $('imp-actions').hidden = impQueue.length === 0;
  $('imp-go').disabled = !impQueue.some(function (it) { return it.status === 'ready'; });
  $('imp-clear').disabled = live.length === 0 && impQueue.length === 0;
}

function impAddFile(f) {
  var it = { file: f, name: impStem(f.name), refText: '', status: 'reading' };
  impQueue.push(it);
  impRow(it); impUpdate(it); impRefreshActions();
  BreezeAudio.prepare(f, IMP_MAX_SECONDS).then(function (res) {
    it.blob = res.blob; it.seconds = res.seconds; it.trimmed = res.trimmed; it.status = 'ready';
    impUpdate(it); impRefreshActions();
  }).catch(function (e) {
    it.status = 'error'; it.error = '解码失败：' + String((e && e.message) || e);
    impUpdate(it); impRefreshActions();
  });
}

function impAddPack(f) {
  var holder = { file: f, name: impStem(f.name), refText: '', status: 'reading' };
  impQueue.push(holder);
  impRow(holder); impUpdate(holder); impRefreshActions();
  holder.el.meta.textContent = '解析音色包…';
  f.arrayBuffer().then(function (buf) {
    return BreezeAudio.zipEntries(buf).then(function (entries) {
      var json = entries.filter(function (e) { return /(^|\/)voice\.json$/i.test(e.name); })[0];
      var audio = entries.filter(function (e) { return /\.(wav|mp3|m4a|flac|ogg)$/i.test(e.name); })[0];
      if (!audio) throw new Error('音色包里没有音频文件');
      var metaP = json ? BreezeAudio.readEntry(buf, json).then(function (u8) {
        try { return JSON.parse(new TextDecoder().decode(u8)); } catch (e) { return {}; }
      }) : Promise.resolve({});
      return metaP.then(function (meta) {
        return BreezeAudio.readEntry(buf, audio).then(function (u8) {
          var mime = /\.mp3$/i.test(audio.name) ? 'audio/mpeg' : (/\.(m4a)$/i.test(audio.name) ? 'audio/mp4' : 'audio/wav');
          return { meta: meta || {}, file: new File([u8], audio.name, { type: mime }) };
        });
      });
    });
  }).then(function (pack) {
    var meta = pack.meta || {};
    holder.file = pack.file;
    holder.name = impStem(meta.name || holder.name);
    holder.refText = meta.ref_text || '';
    if (holder.el.text) holder.el.text.value = holder.refText;
    if (holder.el.row.firstChild.firstChild) holder.el.row.firstChild.firstChild.textContent = holder.name;
    return BreezeAudio.prepare(pack.file, IMP_MAX_SECONDS);
  }).then(function (res) {
    holder.blob = res.blob; holder.seconds = res.seconds; holder.trimmed = res.trimmed; holder.status = 'ready';
    impUpdate(holder); impRefreshActions();
  }).catch(function (e) {
    holder.status = 'error'; holder.error = '音色包读取失败：' + String((e && e.message) || e);
    impUpdate(holder); impRefreshActions();
  });
}

function impFiles(fileList) {
  Array.prototype.slice.call(fileList).forEach(function (f) {
    if (/\.(btv|zip)$/i.test(f.name)) impAddPack(f);
    else impAddFile(f);
  });
}

function impClear() {
  impQueue = [];
  $('imp-list').innerHTML = '';
  $('imp-log').textContent = '';
  impRefreshActions();
}

function impRun() {
  var todo = impQueue.filter(function (it) { return it.status === 'ready'; });
  if (!todo.length) { toast('没有待导入的文件'); return; }
  $('imp-go').disabled = true;
  var ok = 0, fail = 0;
  var chain = Promise.resolve();
  todo.forEach(function (it) {
    chain = chain.then(function () {
      it.status = 'running'; impUpdate(it);
      var fd = new FormData();
      fd.append('ref_audio', it.blob, (it.name || 'ref') + '.wav');
      fd.append('ref_text', it.refText || '');
      fd.append('name', it.name);
      return fetch('/api/voices', { method: 'POST', body: fd }).then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(t.slice(0, 160) || ('HTTP ' + r.status)); });
        return r.json().catch(function () { return {}; });
      }).then(function () {
        it.status = 'done'; ok++; impUpdate(it);
      }).catch(function (e) {
        it.status = 'error'; it.error = String((e && e.message) || e); fail++; impUpdate(it);
      });
    });
  });
  chain.then(function () {
    $('imp-log').textContent = '完成：成功 ' + ok + ' 个' + (fail ? ('，失败 ' + fail + ' 个') : '') + '。';
    impRefreshActions();
    return loadVoices();
  }).then(function () { toast(fail ? ('导入完成，' + fail + ' 个失败') : '音色导入完成'); });
}

function bindImport() {
  var drop = $('imp-drop'), pick = $('imp-pick'), input = $('imp-file');
  pick.onclick = function (e) { e.preventDefault(); input.click(); };
  drop.onclick = function (e) { if (e.target !== pick) input.click(); };
  input.onchange = function () { if (input.files && input.files.length) impFiles(input.files); input.value = ''; };
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('drag'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('drag'); });
  });
  drop.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) impFiles(e.dataTransfer.files);
  });
  $('imp-go').onclick = impRun;
  $('imp-clear').onclick = impClear;
  impRefreshActions();
}

/* ---------------- 接口说明 ---------------- */
function apiBase() { return location.origin + '/api'; }

function apiSnippet(base) {
  return [
    'import urllib.request',
    '',
    'BASE = "' + base + '"',
    '',
    '# 1) 合成，返回 24kHz 单声道 PCM（audio/pcm，16-bit little-endian）',
    '#    POST BASE/audio/speech   multipart: text  + 可选 instruction / voice_id',
    'def tts(text, instruction="", voice_id=""):',
    '    b = "----x"',
    '    body = b""',
    '    for k, v in [("text", text), ("instruction", instruction), ("voice_id", voice_id)]:',
    '        if v:',
    '            body += ("--%s\\r\\nContent-Disposition: form-data; name=\\"%s\\"\\r\\n\\r\\n%s\\r\\n" % (b, k, v)).encode()',
    '    body += ("--%s--\\r\\n" % b).encode()',
    '    req = urllib.request.Request(BASE + "/audio/speech", data=body, method="POST")',
    '    req.add_header("Content-Type", "multipart/form-data; boundary=" + b)',
    '    return urllib.request.urlopen(req, timeout=300).read()   # 裸 PCM',
    '',
    '# 2) 注册音色   POST BASE/voices   ref_audio(wav) + ref_text + name',
    '# 3) 列出音色   GET  BASE/voices',
    '# 4) 删除音色   DELETE BASE/voices/<id>',
    '# 5) 变声转换   POST BASE/audio/convert   source(wav) + voice_id',
    '# 6) 健康检查   GET  BASE/health'
  ].join('\n');
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(function () { return legacyCopy(text); });
  }
  return Promise.resolve(legacyCopy(text));
}

function legacyCopy(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) { }
  document.body.removeChild(ta);
}

function bindApi() {
  var modal = $('api-modal');
  var base = apiBase();
  $('api-base').textContent = base;
  $('api-snippet').textContent = apiSnippet(base);
  $('api-open').onclick = function () { modal.hidden = false; };
  $('api-close').onclick = function () { modal.hidden = true; };
  modal.onclick = function (e) { if (e.target === modal) modal.hidden = true; };
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') modal.hidden = true; });
  $('api-copy-base').onclick = function () {
    copyText(base).then(function () { toast('已复制接口地址'); });
  };
  $('api-copy-all').onclick = function () {
    copyText(base + '\n\n' + apiSnippet(base)).then(function () { toast('已复制地址与示例'); });
  };
}

bindImport();
bindApi();

