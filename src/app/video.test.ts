import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isJobId, framesValid, dimsValid, sniffImage, toBase64, buildVideoRequest, videoType, jobText, MAX_IMAGE_BYTES } from './video.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const ok = { prompt: 'a fox', width: 416, height: 240, frames: 9 };

test('job ids must be 32 lowercase hex characters', () => {
  assert.equal(isJobId('0123456789abcdef0123456789abcdef'), true);
  assert.equal(isJobId('0123456789ABCDEF0123456789abcdef'), false);
  assert.equal(isJobId('0123456789abcdef0123456789abcde'), false);
  assert.equal(isJobId('0123456789abcdef0123456789abcdef/../x'), false);
  assert.equal(isJobId(undefined), false);
});

test('frames must be 4k+1 up to 33', () => {
  for (const n of [1, 5, 9, 13, 17, 21, 25, 29, 33]) assert.equal(framesValid(n), true, String(n));
  for (const n of [0, 2, 4, 3, 37, 34, 1.5, NaN]) assert.equal(framesValid(n), false, String(n));
});

test('dimensions must be multiples of 16 from 128 to 1280', () => {
  assert.equal(dimsValid(128), true);
  assert.equal(dimsValid(1280), true);
  assert.equal(dimsValid(416), true);
  assert.equal(dimsValid(120), false);
  assert.equal(dimsValid(1296), false);
  assert.equal(dimsValid(250), false);
  assert.equal(dimsValid(NaN), false);
});

test('sniffImage uses magic bytes, not the claimed type', () => {
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(JPEG), 'image/jpeg');
  assert.equal(sniffImage(new TextEncoder().encode('<svg onload=x>')), null);
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50])), null);
});

test('toBase64 matches Buffer across chunk boundaries', () => {
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => (i * 31) & 0xff);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
});

test('buildVideoRequest builds the body without an image', () => {
  assert.deepEqual(buildVideoRequest({ ...ok, prompt: '  a fox  ' }), ok);
});

test('buildVideoRequest adds the start image as base64', () => {
  const req = buildVideoRequest({ ...ok, image: PNG });
  assert.equal(req.init_image_b64, Buffer.from(PNG).toString('base64'));
});

test('buildVideoRequest rejects bad input with a readable message', () => {
  assert.throws(() => buildVideoRequest({ ...ok, prompt: '   ' }), /Describe the video/);
  assert.throws(() => buildVideoRequest({ ...ok, prompt: 'x'.repeat(2001) }), /over 2000/);
  assert.doesNotThrow(() => buildVideoRequest({ ...ok, prompt: 'x'.repeat(2000) }));
  assert.throws(() => buildVideoRequest({ ...ok, width: 410 }), RangeError);
  assert.throws(() => buildVideoRequest({ ...ok, height: 1296 }), RangeError);
  assert.throws(() => buildVideoRequest({ ...ok, frames: 10 }), /Frames/);
  assert.throws(() => buildVideoRequest({ ...ok, image: new TextEncoder().encode('GIF89a') }), /PNG or JPEG/);
});

test('buildVideoRequest refuses images over 8 MiB', () => {
  const big = new Uint8Array(MAX_IMAGE_BYTES + 1);
  big.set(PNG);
  assert.throws(() => buildVideoRequest({ ...ok, image: big }), /over 8 MiB/);
});

test('videoType accepts only mp4 and webm', () => {
  assert.equal(videoType('video/mp4'), 'video/mp4');
  assert.equal(videoType('Video/WebM; codecs=vp9'), 'video/webm');
  assert.equal(videoType('image/png'), null);
  assert.equal(videoType('text/html'), null);
  assert.equal(videoType(null), null);
});

test('jobText maps gateway states and ignores unknown ones', () => {
  assert.equal(jobText('queued', 2), 'Queued, position 2');
  assert.equal(jobText('generating'), 'Generating frames…');
  assert.equal(jobText('<b>x</b>'), 'Working…');
  assert.equal(jobText(undefined), 'Working…');
});
