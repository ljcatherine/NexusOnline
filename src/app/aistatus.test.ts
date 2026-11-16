import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusLabel, retryDelay } from './aistatus.ts';

const base = { online: true, ready: true, busy: false, reason: '', queue_length: 0, jobs: [] };

test('online and idle', () => {
  assert.deepEqual(statusLabel({ ...base, engine: 'llama', model: 'm' }), { state: 'online', text: 'Online.' });
});

test('busy shows the queue length', () => {
  assert.deepEqual(statusLabel({ ...base, busy: true, queue_length: 3 }), { state: 'busy', text: 'Busy: 3 queued.' });
});

test('offline shows the reason', () => {
  assert.deepEqual(statusLabel({ ...base, online: false, ready: false, reason: 'ps5_offline' }),
    { state: 'offline', text: 'Offline: PS5 is off or unreachable.' });
});

test('loading without a warning mentions about 100 s', () => {
  const l = statusLabel({ ...base, ready: false });
  assert.equal(l.state, 'loading');
  assert.match(l.text, /about 100 s/);
});

test('reason switching gives switching, warning is the detail', () => {
  assert.deepEqual(statusLabel({ ...base, ready: false, reason: 'switching', warning: 'Switching engine restarts the PS5 server and takes about 30 s.' }),
    { state: 'switching', text: 'Switching engine restarts the PS5 server and takes about 30 s.' });
});

test('reason switching without a warning mentions about 100 s', () => {
  assert.deepEqual(statusLabel({ ...base, ready: false, reason: 'switching' }), { state: 'switching', text: 'Switching engine, about 100 s.' });
});

test('reason loading gives loading, warning passes through', () => {
  assert.deepEqual(statusLabel({ ...base, ready: false, reason: 'loading', warning: 'Loading this model takes about 100 s.' }),
    { state: 'loading', text: 'Loading this model takes about 100 s.' });
});

test('a switching-looking warning does not set the state without a reason', () => {
  assert.equal(statusLabel({ ...base, ready: false, warning: 'Switching engine restarts the PS5 server and takes about 30 s.' }).state, 'loading');
});

test('unknown reason while not ready is loading', () => {
  assert.equal(statusLabel({ ...base, ready: false, reason: 'something_new' }).state, 'loading');
});

test('each offline reason maps to offline with a human text', () => {
  const cases = [
    ['ps5_offline', 'Offline: PS5 is off or unreachable.'],
    ['restart_failed', 'Offline: the PS5 server failed to restart.'],
    ['failed', 'Offline: the PS5 server reported a failure.'],
    ['no_model', 'Offline: no model is loaded on the PS5.'],
    ['media_unavailable', 'Offline: PS5 media services are unavailable.'],
  ];
  for (const [reason, text] of cases) {
    assert.deepEqual(statusLabel({ ...base, reason }), { state: 'offline', text }, reason);
  }
});

test('offline with an unknown reason shows it', () => {
  assert.deepEqual(statusLabel({ ...base, online: false, reason: 'weird' }), { state: 'offline', text: 'Offline: weird' });
});

test('unknown reason while ready and online stays online', () => {
  assert.equal(statusLabel({ ...base, reason: 'something_new' }).state, 'online');
});

test('warning text is appended to busy and online', () => {
  assert.equal(statusLabel({ ...base, busy: true, queue_length: 1, warning: 'Loading this model takes about 100 s.' }).text,
    'Busy: 1 queued. Loading this model takes about 100 s.');
  assert.equal(statusLabel({ ...base, warning: 'note' }).text, 'Online. note');
});

test('malformed or unknown input maps to offline', () => {
  for (const bad of [null, undefined, 'online', 42, [], {}, { online: 'yes', ready: true, busy: false },
    { online: true, busy: false }, { online: true, ready: true }]) {
    assert.equal(statusLabel(bad).state, 'offline', JSON.stringify(bad));
  }
});

test('retry delay doubles and caps at 60 s', () => {
  assert.equal(retryDelay(0), 5000);
  assert.equal(retryDelay(1), 10000);
  assert.equal(retryDelay(2), 20000);
  assert.equal(retryDelay(50), 60000);
});
