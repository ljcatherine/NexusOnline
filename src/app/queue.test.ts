import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busyText, errorMessage, retryAfterSeconds, OFFLINE_TEXT, QUEUE_FULL_TEXT } from './queue.ts';

test('503 from an offline PS5 gives the fixed offline text and Retry-After seconds', () => {
  assert.equal(busyText(503, '30', 'PS5 is offline'), `${OFFLINE_TEXT} Retry in about 30 s.`);
});

test('503 that is not the offline message is not mapped', () => {
  assert.equal(busyText(503, null, 'no model loaded'), null);
});

test('429 queue-full gives the queue text without Retry-After', () => {
  assert.equal(busyText(429, null, 'queue full'), QUEUE_FULL_TEXT);
});

test('429 for a quota is not mapped to the queue text', () => {
  assert.equal(busyText(429, '60', 'daily quota exceeded'), null);
});

test('other statuses are not mapped', () => {
  assert.equal(busyText(500, null, 'PS5 is offline'), null);
});

test('Retry-After as an HTTP date counts down from now', () => {
  const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');
  assert.equal(retryAfterSeconds('Wed, 21 Oct 2015 07:28:10 GMT', now), 10);
});

test('Retry-After is capped and junk is ignored', () => {
  assert.equal(retryAfterSeconds('999999'), 3600);
  assert.equal(retryAfterSeconds('soon'), null);
  assert.equal(retryAfterSeconds(null), null);
});

test('errorMessage reads the nested gateway error message', () => {
  assert.equal(errorMessage({ error: { message: 'PS5 is offline' } }), 'PS5 is offline');
});

test('errorMessage reads a flat string error', () => {
  assert.equal(errorMessage({ error: 'queue full' }), 'queue full');
});

test('errorMessage is empty when there is no error', () => {
  assert.equal(errorMessage({}), '');
  assert.equal(errorMessage(null), '');
  assert.equal(errorMessage(undefined), '');
  assert.equal(errorMessage({ error: { code: 1 } }), '');
});

test('errorMessage ignores non-string messages and bodies', () => {
  assert.equal(errorMessage({ error: { message: 42 } }), '');
  assert.equal(errorMessage({ error: 42 }), '');
  assert.equal(errorMessage({ error: null }), '');
  assert.equal(errorMessage('plain text'), '');
});

test('errorMessage clips to 300 characters', () => {
  assert.equal(errorMessage({ error: { message: 'x'.repeat(500) } }), 'x'.repeat(300));
  assert.equal(errorMessage({ error: 'y'.repeat(301) }), 'y'.repeat(300));
});
