import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseParser, parseVoiceEvent, trimHistory, buildVoiceRequest, toBase64, fromBase64, clipError, concat, MAX_HISTORY, MAX_AUDIO_BYTES, type Turn } from './voice.ts';

const feedAll = (parts: string[]) => {
  const p = new SseParser();
  return parts.flatMap(part => p.push(part));
};

test('SSE: events split across chunk boundaries at every byte', () => {
  const stream = 'data: {"type":"text","delta":"hi"}\n\ndata: [DONE]\n\n';
  const expected = ['{"type":"text","delta":"hi"}', '[DONE]'];
  for (let i = 1; i < stream.length; i++) {
    assert.deepEqual(feedAll([stream.slice(0, i), stream.slice(i)]), expected, `split at ${i}`);
  }
  assert.deepEqual(feedAll(stream.split('')), expected);
});

test('SSE: multi-line data is joined with newlines', () => {
  assert.deepEqual(feedAll(['data: line one\ndata: line two\n\n']), ['line one\nline two']);
});

test('SSE: comments and non-data fields are ignored', () => {
  assert.deepEqual(feedAll([': keep-alive\n\nevent: audio\nid: 7\ndata: x\n\n']), ['x']);
});

test('SSE: a blank event with no data is not dispatched', () => {
  assert.deepEqual(feedAll(['\n\n\n\ndata: a\n\n']), ['a']);
});

test('SSE: an event is not closed until its blank line arrives', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('data: a\n'), []);
  assert.deepEqual(p.push('data: b\n\n'), ['a\nb']);
});

test('SSE: CRLF and bare CR, including a CR at the end of a chunk', () => {
  assert.deepEqual(feedAll(['data: a\r', '\ndata: b\r\n\r\n']), ['a\nb']);
  assert.deepEqual(feedAll(['data: a\r\r', 'data: b\r\r']), ['a', 'b']);
  assert.deepEqual(feedAll(['data: a\r', 'data: b\n\n']), ['a\nb']);
});

test('SSE: a data value keeps only one leading space', () => {
  assert.deepEqual(feedAll(['data:  two\n\n']), [' two']);
  assert.deepEqual(feedAll(['data:none\n\n']), ['none']);
});

test('parseVoiceEvent maps each gateway event', () => {
  assert.deepEqual(parseVoiceEvent('{"type":"transcript","text":"hello","audio_s":1,"at_s":0}'), { type: 'transcript', text: 'hello' });
  assert.deepEqual(parseVoiceEvent('{"type":"text","delta":"Hi"}'), { type: 'text', delta: 'Hi' });
  assert.deepEqual(parseVoiceEvent('{"type":"audio","index":0,"audio_b64":"QUJD","text":"x"}'), { type: 'audio', audio_b64: 'QUJD' });
  assert.deepEqual(parseVoiceEvent('{"type":"done","transcript":"t","reply":"r","tokens":3}'), { type: 'done', reply: 'r' });
  assert.deepEqual(parseVoiceEvent('{"status":"loading"}'), { type: 'status', status: 'loading' });
});

test('parseVoiceEvent surfaces error events with their message', () => {
  assert.deepEqual(parseVoiceEvent('{"type":"error","message":"model failed"}'), { type: 'error', message: 'model failed' });
  assert.deepEqual(parseVoiceEvent('{"error":{"message":"nested"}}'), { type: 'error', message: 'nested' });
  assert.deepEqual(parseVoiceEvent('{"type":"error"}'), { type: 'error', message: 'The voice service returned an error.' });
});

test('parseVoiceEvent rejects malformed or unknown payloads', () => {
  assert.equal(parseVoiceEvent('not json'), null);
  assert.equal(parseVoiceEvent('null'), null);
  assert.equal(parseVoiceEvent('{"type":"audio"}'), null);
  assert.equal(parseVoiceEvent('{"type":"mystery"}'), null);
});

test('trimHistory keeps the last 20 turns', () => {
  const turns: Turn[] = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  const kept = trimHistory(turns);
  assert.equal(MAX_HISTORY, 20);
  assert.equal(kept.length, 20);
  assert.equal(kept[0].content, 'm10');
  assert.equal(kept.at(-1)!.content, 'm29');
});

test('trimHistory drops system and empty turns', () => {
  const kept = trimHistory([
    { role: 'system', content: 'secret' } as any,
    { role: 'user', content: '' },
    { role: 'user', content: 'ok' },
  ]);
  assert.deepEqual(kept, [{ role: 'user', content: 'ok' }]);
});

test('buildVoiceRequest never includes a system prompt', () => {
  const body = buildVoiceRequest('QUJD', [
    { role: 'system', content: 'client-chosen prompt' } as any,
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
  assert.deepEqual(Object.keys(body).sort(), ['audio_b64', 'messages']);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }]);
  assert.doesNotMatch(JSON.stringify(body), /system|client-chosen prompt/);
});

test('buildVoiceRequest with no history sends an empty messages array', () => {
  assert.deepEqual(buildVoiceRequest('QUJD', []), { audio_b64: 'QUJD', messages: [] });
});

test('base64 round trip, including bytes above 0x7f and a multi-chunk length', () => {
  const bytes = Uint8Array.from({ length: 0x8000 * 2 + 5 }, (_, i) => (i * 37) & 0xff);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
  assert.equal(toBase64(new Uint8Array([0xff, 0, 0x41])), btoa(String.fromCharCode(0xff, 0, 0x41)));
});

test('clipError allows up to the gateway cap and rejects above it', () => {
  assert.equal(clipError(MAX_AUDIO_BYTES), null);
  assert.match(clipError(MAX_AUDIO_BYTES + 1) ?? '', /too large/);
});

test('concat joins chunks in order', () => {
  assert.deepEqual([...concat([new Float32Array([1, 2]), new Float32Array([]), new Float32Array([3])])], [1, 2, 3]);
  assert.equal(concat([]).length, 0);
});
