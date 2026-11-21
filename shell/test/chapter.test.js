'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const chapter = require('../../src/ui/chapter');
const audio = require('../../src/ui/longform');

function voiceFixture(script) {
  const parsed = chapter.parse(script, 'script');
  for (const role of parsed.roles) role.voiceId = 'voice-' + role.id;
  return { ...parsed, pauseMs: 250 };
}

function pcm(value, samples = 24000) {
  return new Response(new Uint8Array(samples * 2).fill(value), { headers: { 'Content-Type': 'audio/pcm' } });
}

test('recognizes repeated speakers and keeps colons in the spoken text', () => {
  const parsed = chapter.parse('\uFEFF旁白：灯亮了。\r\n林夏：等等：我马上回来。\r\n周明: 好。\n林夏：久等了。', 'script');
  assert.deepEqual(parsed.roles.map(role => role.name), ['旁白', '林夏', '周明']);
  assert.deepEqual(parsed.segments.map(line => [line.speakerId, line.text]), [
    ['narrator', '灯亮了。'], ['role-1', '等等：我马上回来。'],
    ['role-2', '好。'], ['role-1', '久等了。']
  ]);
});

test('keeps narration in order and requires review for unassigned and unfinished quotations', () => {
  const parsed = chapter.parse('“到了。”她说。\n「还差一段。\n灯熄灭了。', 'novel');
  assert.deepEqual(parsed.segments, [
    { speakerId: null, text: '到了。' }, { speakerId: 'narrator', text: '她说。' },
    { speakerId: null, text: '还差一段。' }, { speakerId: 'narrator', text: '灯熄灭了。' }
  ]);
  assert.throws(() => chapter.prepare({ ...parsed, pauseMs: 500 }), /第 1 段的说话人/);
  const script = chapter.parse('林夏：还没到。', 'script');
  assert.throws(() => chapter.prepare({ ...script, pauseMs: 500 }), /林夏.*参考音色/);
});

test('uses fixed reference voices, reruns only the changed turn and recalculates the chapter timeline', async () => {
  const parsed = voiceFixture('旁白：灯亮了。\n林夏：你好。\n周明：等一下。\n许禾：进来吧。\n林夏：好。');
  let pieces = chapter.prepare(parsed);
  const clips = new Map();
  const signal = new AbortController().signal;
  const calls = [];
  await chapter.synthesize(pieces, clips, parsed.pauseMs, async piece => {
    calls.push([piece.speakerName, piece.voiceId, piece.text]);
    return pcm(calls.length);
  }, signal, () => {});
  assert.deepEqual(calls.map(([name]) => name), ['旁白', '林夏', '周明', '许禾', '林夏']);
  assert.equal(calls[1][1], calls[4][1]);

  const preserved = clips.get(pieces[4].key);
  parsed.segments[1].text = '你来了啊。';
  pieces = chapter.prepare(parsed);
  await chapter.synthesize(pieces, clips, parsed.pauseMs, async piece => {
    assert.equal(piece.text, '你来了啊。');
    return pcm(7, 48000);
  }, signal, () => {}, 1);
  assert.equal(clips.get(pieces[4].key), preserved);

  const timeline = chapter.timeline(pieces, clips, parsed.pauseMs, true);
  assert.equal(timeline.samples / audio.sampleRate, 7);
  assert.equal(timeline.completed[2].start / audio.sampleRate, 3.5);
  assert.match(audio.srt(timeline.completed), /00:00:03,500 --> 00:00:04,500\r\n周明：等一下。/);
  const body = Buffer.from(await audio.wav(timeline.completed, timeline.gapSamples).arrayBuffer());
  assert.equal(body.readUInt32LE(40), timeline.samples * 2);
  assert.equal(body.readUInt32LE(24), 24000);
});

test('preserves complete turns on failure and resumes from the missing turn', async () => {
  const parsed = voiceFixture('旁白：灯亮了。\n林夏：你好。\n周明：等一下。');
  const pieces = chapter.prepare(parsed);
  const clips = new Map();
  const signal = new AbortController().signal;
  await assert.rejects(chapter.synthesize(pieces, clips, 250, async piece =>
    piece.segmentIndex === 1 ? new Response('try again', { status: 503 }) : pcm(1), signal, () => {}), /503/);
  assert.equal(clips.size, 1);
  assert.equal(chapter.timeline(pieces, clips, 250, false).completed.length, 1);
  const resumed = [];
  await chapter.synthesize(pieces, clips, 250, async piece => {
    resumed.push(piece.segmentIndex);
    return pcm(2);
  }, signal, () => {});
  assert.deepEqual(resumed, [1, 2]);
});

test('assigns an exact selection without renumbering the stored audio of later turns', () => {
  const parsed = voiceFixture('旁白：起身。我们出发。灯熄了。\n林夏：等等。\n周明：好。');
  const original = chapter.prepare(parsed);
  parsed.segments = chapter.splitSelection(parsed.segments, 0, 3, 8, 'role-1');
  assert.deepEqual(parsed.segments.map(({ speakerId, text }) => [speakerId, text]), [
    ['narrator', '起身。'], ['role-1', '我们出发。'], ['narrator', '灯熄了。'],
    ['role-1', '等等。'], ['role-2', '好。']
  ]);
  assert.deepEqual(chapter.prepare(parsed).slice(3).map(piece => piece.key), original.slice(1).map(piece => piece.key));
  assert.throws(() => chapter.validate({ ...parsed,
    segments: [{ text: '一', speakerId: 'narrator', slot: 1 }, { text: '二', speakerId: 'narrator' }]
  }), /编号无效/);
});
