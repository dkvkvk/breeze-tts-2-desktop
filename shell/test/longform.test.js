'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { splitScript, createJob, runJob, wav, srt, encodeDraft, decodeDraft } = require('../../src/ui/longform');

function pcm(...chunks) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    }
  });
  return new Response(body, { headers: { 'Content-Type': 'audio/pcm; rate=24000' } });
}

test('preserves explicit line breaks and splits long lines on nearby punctuation', () => {
  const sentence = '句'.repeat(72) + '。';
  assert.deepEqual(splitScript('  第一段  \r\n\r\n第二段\r' + sentence + '段'.repeat(57)),
    ['第一段', '第二段', sentence, '段'.repeat(57)]);
  assert.deepEqual(splitScript('声'.repeat(99) + '🙂继续'), ['声'.repeat(99) + '🙂', '继续']);
  assert.throws(() => splitScript('声'.repeat(12001)), /12000/);
  assert.throws(() => splitScript('台词\n'.repeat(201)), /200/);
});

test('resumes a failed segment and exports WAV and SRT from the same timeline', async () => {
  const job = createJob(['第一段', '第二段'], 250);
  const signal = new AbortController().signal;
  const progress = [];
  const first = new Uint8Array(48000).fill(1);
  const second = new Uint8Array(24000).fill(2);

  await assert.rejects(runJob(job, async piece => piece === '第一段'
    ? pcm(first.subarray(0, 5), first.subarray(5))
    : new Response('模型未就绪', { status: 503 }), signal, marker => progress.push(marker)), /503.*模型未就绪/);
  assert.deepEqual(progress, [0, null, 1]);
  assert.equal(job.samples, 24000);
  assert.equal(job.completed.length, 1);

  await runJob(job, async piece => {
    assert.equal(piece, '第二段');
    return pcm(second);
  }, signal, () => {});
  const data = Buffer.from(await wav(job.completed, job.gapSamples).arrayBuffer());
  assert.equal(data.toString('ascii', 0, 4), 'RIFF');
  assert.equal(data.readUInt32LE(4), data.length - 8);
  assert.equal(data.readUInt16LE(22), 1);
  assert.equal(data.readUInt32LE(24), 24000);
  assert.equal(data.readUInt16LE(34), 16);
  assert.equal(data.readUInt32LE(40), 84000);
  assert.deepEqual(data.subarray(44, 48044), Buffer.from(first));
  assert.deepEqual(data.subarray(48044, 60044), Buffer.alloc(12000));
  assert.deepEqual(data.subarray(60044), Buffer.from(second));
  assert.equal(srt(job.completed), '1\r\n00:00:00,000 --> 00:00:01,000\r\n第一段\r\n\r\n' +
    '2\r\n00:00:01,250 --> 00:00:01,750\r\n第二段\r\n');
});

test('cancels an in-flight segment without recording its partial audio', async () => {
  const job = createJob(['甲', '乙', '丙'], 0);
  const controller = new AbortController();
  const calls = [];
  await assert.rejects(runJob(job, async piece => {
    calls.push(piece);
    if (piece === '乙') controller.abort();
    return pcm(new Uint8Array(48));
  }, controller.signal, () => {}), { name: 'AbortError' });
  assert.deepEqual(calls, ['甲', '乙']);
  assert.deepEqual(job.completed.map(clip => clip.text), ['甲']);
});

test('rejects unexpected and truncated audio without advancing the job', async () => {
  const job = createJob(['甲'], 0);
  const signal = new AbortController().signal;
  await assert.rejects(runJob(job, async () => new Response('{"error":1}'), signal, () => {}), /PCM/);
  await assert.rejects(runJob(job, async () => pcm(new Uint8Array(3)), signal, () => {}), /不完整/);
  await assert.rejects(runJob(job, async () => pcm(), signal, () => {}), /为空/);
  assert.equal(job.completed.length, 0);
  assert.equal(job.samples, 0);
});

test('round-trips a portable draft and rejects malformed settings', () => {
  const settings = { text: '白云\n蓝天', instruction: '温和旁白', voiceId: 'narrator', pauseMs: 500 };
  assert.deepEqual(decodeDraft(encodeDraft({ ...settings, audio: ['generated pcm'] })), settings);
  assert.throws(() => decodeDraft('{'), /无法读取/);
  assert.throws(() => decodeDraft('{"format":"breeze-longform","version":2}'), /不支持/);
  assert.throws(() => encodeDraft({ ...settings, pauseMs: 193 }), /字段无效/);
  assert.throws(() => encodeDraft({ ...settings, text: '' }), /没有可合成/);
});
