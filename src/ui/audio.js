/* Breeze TTS 2 —— 音频导入工具
 * 把任意浏览器能解码的音频（wav / mp3 / m4a / flac / ogg）统一成
 * 后端要求的 24 kHz 单声道 16-bit WAV，并支持读取 .btv 音色包（zip）。
 */
(function (global) {
  var SR = 24000;

  function AudioCtx() {
    var C = window.AudioContext || window.webkitAudioContext;
    if (!C) throw new Error('当前运行时不支持 Web Audio');
    return new C();
  }

  function decode(arrayBuffer) {
    var c = AudioCtx();
    var settled = false;
    return new Promise(function (res, rej) {
      function ok(b) { if (settled) return; settled = true; try { c.close(); } catch (e) { } res(b); }
      function bad(e) { if (settled) return; settled = true; try { c.close(); } catch (e) { } rej(e || new Error('音频解码失败')); }
      var r;
      try { r = c.decodeAudioData(arrayBuffer.slice(0), ok, bad); }
      catch (e) { bad(e); return; }
      if (r && r.then) r.then(ok, bad);
    });
  }

  function truncate(buffer, maxSec) {
    if (!maxSec || buffer.duration <= maxSec) return buffer;
    var len = Math.floor(maxSec * buffer.sampleRate);
    var out = new AudioBuffer({ length: len, sampleRate: buffer.sampleRate, numberOfChannels: buffer.numberOfChannels });
    for (var c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c).subarray(0, len), c);
    return out;
  }

  function toMono24k(buffer) {
    var outLen = Math.max(1, Math.ceil(buffer.duration * SR));
    var off = new OfflineAudioContext(1, outLen, SR);
    var src = off.createBufferSource();
    if (buffer.numberOfChannels === 1) {
      src.buffer = buffer;
    } else {
      var mono = off.createBuffer(1, buffer.length, buffer.sampleRate);
      var dst = mono.getChannelData(0);
      for (var i = 0; i < buffer.length; i++) {
        var sum = 0;
        for (var c = 0; c < buffer.numberOfChannels; c++) sum += buffer.getChannelData(c)[i];
        dst[i] = sum / buffer.numberOfChannels;
      }
      src.buffer = mono;
    }
    src.connect(off.destination);
    src.start(0);
    return off.startRendering();
  }

  function encodeWav(samples) {
    var n = samples.length;
    var buf = new ArrayBuffer(44 + n * 2);
    var v = new DataView(buf);
    function ascii(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
    ascii(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); ascii(8, 'WAVE');
    ascii(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ascii(36, 'data'); v.setUint32(40, n * 2, true);
    var o = 44;
    for (var i = 0; i < n; i++) {
      var s = samples[i];
      s = s > 1 ? 1 : (s < -1 ? -1 : s);
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /* 统一入口：文件 -> { blob(24k mono wav), seconds, trimmed } */
  function prepare(file, maxSec) {
    return file.arrayBuffer().then(decode).then(function (buffer) {
      var src = truncate(buffer, maxSec);
      var trimmed = src !== buffer;
      return toMono24k(src).then(function (rendered) {
        var blob = encodeWav(rendered.getChannelData(0));
        return { blob: blob, seconds: rendered.duration, trimmed: trimmed, bytes: blob.size };
      });
    });
  }

  /* ---------- .btv 音色包（zip） ---------- */
  function zipEntries(arrayBuffer) {
    var dv = new DataView(arrayBuffer), u8 = new Uint8Array(arrayBuffer);
    var eocd = -1;
    var stop = Math.max(0, u8.length - 66000);
    for (var i = u8.length - 22; i >= stop; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return Promise.reject(new Error('不是有效的音色包（zip）'));
    var count = dv.getUint16(eocd + 10, true);
    var off = dv.getUint32(eocd + 16, true);
    var list = [];
    for (var n = 0; n < count; n++) {
      if (off + 46 > u8.length || dv.getUint32(off, true) !== 0x02014b50) break;
      var method = dv.getUint16(off + 10, true);
      var csize = dv.getUint32(off + 20, true);
      var nameLen = dv.getUint16(off + 28, true);
      var extraLen = dv.getUint16(off + 30, true);
      var cmtLen = dv.getUint16(off + 32, true);
      var lho = dv.getUint32(off + 42, true);
      var name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nameLen));
      var lnameLen = dv.getUint16(lho + 26, true);
      var lextraLen = dv.getUint16(lho + 28, true);
      list.push({ name: name, method: method, csize: csize, dataStart: lho + 30 + lnameLen + lextraLen });
      off += 46 + nameLen + extraLen + cmtLen;
    }
    return Promise.resolve(list);
  }

  function readEntry(arrayBuffer, entry) {
    var slice = new Uint8Array(arrayBuffer, entry.dataStart, entry.csize);
    if (entry.method === 0) return Promise.resolve(slice);
    if (typeof DecompressionStream === 'undefined') return Promise.reject(new Error('运行时不支持解压，请手动解包后导入 wav'));
    var stream = new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }

  global.BreezeAudio = {
    SR: SR,
    prepare: prepare,
    encodeWav: encodeWav,
    decode: decode,
    zipEntries: zipEntries,
    readEntry: readEntry
  };
})(window);
