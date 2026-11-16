import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImageRequest, isPngBase64, splitSse, describeProgress, pngFromResponse, MAX_PROMPT } from './image-core.ts';

// A real 1x1 PNG, base64 encoded.
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('request body keeps the prompt trimmed and omits an empty model', () => {
  const body = JSON.parse(buildImageRequest({ prompt: '  a cat  ', model: '', size: '512x512' }));
  assert.deepEqual(body, { prompt: 'a cat', size: '512x512', stream: true });
});

test('request body includes an allow-listed model', () => {
  const body = JSON.parse(buildImageRequest({ prompt: 'x', model: 'flux2-klein-4b', size: '768x512' }));
  assert.equal(body.model, 'flux2-klein-4b');
  assert.equal(body.size, '768x512');
});

test('request validation rejects bad input', () => {
  assert.throws(() => buildImageRequest({ prompt: '   ', model: '', size: '512x512' }), RangeError);
  assert.throws(() => buildImageRequest({ prompt: 'x'.repeat(MAX_PROMPT + 1), model: '', size: '512x512' }), RangeError);
  assert.doesNotThrow(() => buildImageRequest({ prompt: 'x'.repeat(MAX_PROMPT), model: '', size: '512x512' }));
  assert.throws(() => buildImageRequest({ prompt: 'x', model: '', size: '640x480' }), RangeError);
  assert.throws(() => buildImageRequest({ prompt: 'x', model: '../secret', size: '512x512' }), RangeError);
});

test('PNG check accepts a real PNG and rejects other bytes', () => {
  assert.equal(isPngBase64(PNG_1PX), true);
  assert.equal(isPngBase64(Buffer.from('GIF89a').toString('base64').padEnd(8, 'A')), false);
  assert.equal(isPngBase64(Buffer.from('<svg></svg>').toString('base64')), false);
  assert.equal(isPngBase64(''), false);
  assert.equal(isPngBase64('not base64!'), false);
  assert.equal(isPngBase64(PNG_1PX.slice(0, -1)), false); // bad length
});

test('SSE splitter returns complete events and keeps the tail', () => {
  const { events, rest } = splitSse('data: {"a":1}\n\ndata: [DONE]\n\ndata: {"b"');
  assert.deepEqual(events, ['{"a":1}', '[DONE]']);
  assert.equal(rest, 'data: {"b"');
});

test('progress lines describe gateway phases', () => {
  assert.equal(describeProgress({ status: 'loading', progress: 40 }), 'Loading the model: 40%');
  assert.equal(describeProgress({ status: 'generating', step: 2, steps: 4 }), 'Generating: step 2 of 4');
  assert.equal(describeProgress({ status: 'decoding' }), 'Decoding the image…');
  assert.equal(describeProgress({ status: 'mystery' }), null);
});

test('final response yields the PNG or the gateway error', () => {
  assert.equal(pngFromResponse({ data: [{ b64_json: PNG_1PX }], http_status: 200 }), PNG_1PX);
  assert.throws(() => pngFromResponse({ error: { message: 'model missing' }, http_status: 404 }), /model missing/);
  assert.throws(() => pngFromResponse({ data: [{ b64_json: 'AAAA' }] }), /not return a PNG/);
  assert.throws(() => pngFromResponse(null), /not return a PNG/);
});
