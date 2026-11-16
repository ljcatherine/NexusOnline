import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, raw } from './lib.ts';

const SIGN_IN = 'Your sign-in has expired. Reload the page to sign in again.';

/** Replaces globalThis.fetch for one test; returns the restore function. */
function mockFetch(impl: (url: string, init: RequestInit) => unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => impl(url, init)) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

async function rejectionOf(p: Promise<unknown>): Promise<any> {
  try { await p; } catch (e) { return e; }
  assert.fail('expected the promise to reject');
}

test('ApiError carries status and message and is an Error', () => {
  const e = new ApiError(503, 'busy');
  assert.ok(e instanceof ApiError);
  assert.ok(e instanceof Error);
  assert.equal(e.status, 503);
  assert.equal(e.message, 'busy');
  assert.deepEqual({ ...e }, { status: 503 });
});

test('expired Access session (opaque redirect) gives status 0 and the sign-in message', async () => {
  const restore = mockFetch(() => ({ type: 'opaqueredirect', ok: false, status: 0 }));
  try {
    const e = await rejectionOf(raw('/v1/models'));
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 0);
    assert.equal(e.message, SIGN_IN);
  } finally { restore(); }
});

test('401 from the gateway gives the sign-in message with status 401', async () => {
  const restore = mockFetch(() => new Response(null, { status: 401 }));
  try {
    const e = await rejectionOf(raw('/v1/models'));
    assert.equal(e.status, 401);
    assert.equal(e.message, SIGN_IN);
  } finally { restore(); }
});

test('timeout is not reported as a sign-in problem', async () => {
  const restore = mockFetch(() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')));
  try {
    const e = await rejectionOf(raw('/v1/models'));
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 0);
    assert.equal(e.message, 'The request timed out.');
  } finally { restore(); }
});

test('a real AbortSignal.timeout firing mid-request is reported as a timeout', async () => {
  const restore = mockFetch((_url, init) => new Promise((_, reject) => {
    init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
  }));
  try {
    const e = await rejectionOf(raw('/v1/models', { signal: AbortSignal.timeout(5) }));
    assert.equal(e.message, 'The request timed out.');
  } finally { restore(); }
});

test('caller abort is rethrown unchanged with no message', async () => {
  const abort = new DOMException('This operation was aborted.', 'AbortError');
  const restore = mockFetch(() => Promise.reject(abort));
  try {
    const e = await rejectionOf(raw('/v1/models'));
    assert.equal(e, abort);
    assert.equal(e.name, 'AbortError');
    assert.ok(!(e instanceof ApiError));
    assert.notEqual(e.message, SIGN_IN);
  } finally { restore(); }
});

test('offline or other transport failure is a network error, not a sign-in problem', async () => {
  const restore = mockFetch(() => Promise.reject(new TypeError('fetch failed')));
  try {
    const e = await rejectionOf(raw('/v1/models'));
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 0);
    assert.equal(e.message, 'Network error — check your connection.');
  } finally { restore(); }
});

test('gateway error keeps the server message on 5xx and 403', async () => {
  const restore = mockFetch((url) => url.endsWith('/a')
    ? new Response(JSON.stringify({ error: 'PS5 is offline' }), { status: 503 })
    : new Response(JSON.stringify({ error: 'Not allowed here' }), { status: 403 }));
  try {
    assert.equal((await rejectionOf(raw('/a'))).message, 'PS5 is offline');
    assert.equal((await rejectionOf(raw('/b'))).message, 'Not allowed here');
  } finally { restore(); }
});

test('404 and 429 have fixed messages', async () => {
  const restore = mockFetch((url) => new Response(null, { status: url.endsWith('/nf') ? 404 : 429 }));
  try {
    assert.equal((await rejectionOf(raw('/nf'))).message, 'Not found on the gateway.');
    assert.equal((await rejectionOf(raw('/rl'))).message, 'The gateway is rate limiting requests. Wait a few seconds and try again.');
  } finally { restore(); }
});

test('a successful response is returned unchanged', async () => {
  const ok = new Response('{}', { status: 200 });
  const restore = mockFetch(() => ok);
  try {
    assert.equal(await raw('/ok'), ok);
  } finally { restore(); }
});
