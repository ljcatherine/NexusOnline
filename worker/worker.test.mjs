// node --test worker/  — security tests for the Nexus Online Worker.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.js';
import { verifyAccess, resetKeyCache } from './access.js';
import { classify } from './routes.js';

const TEAM = 'nexus-test.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const OWNER = 'owner@example.com';
const ENV_BASE = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUDIENCE: AUD, OWNER_EMAIL: OWNER };
const ORIGIN = 'https://online.example.com';

const b64u = buf => Buffer.from(buf).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
let jwksCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) === `https://${TEAM}/cdn-cgi/access/certs`) {
    jwksCalls++;
    return Response.json({ keys: [{ kty: 'RSA', kid: 'k1', alg: 'RS256', n: jwk.n, e: jwk.e }] });
  }
  return realFetch(url, init);
};

async function sign(claims = {}, { key = pair.privateKey, header = { alg: 'RS256', kid: 'k1', typ: 'JWT' } } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = { aud: [AUD], iss: `https://${TEAM}`, email: OWNER, iat: now, exp: now + 3600, sub: 'u1', ...claims };
  const head = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(body))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head));
  return `${head}.${b64u(sig)}`;
}

function makeEnv(gatewayResponse = () => Response.json({ ok: true })) {
  const calls = [];
  return {
    ...ENV_BASE,
    calls,
    ASSETS: { fetch: async req => new Response(`asset ${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/html' } }) },
    NEXUS_GATEWAY: { fetch: async req => { calls.push(req); return gatewayResponse(req); } },
  };
}

const req = (path, { token, method = 'GET', headers = {}, body } = {}) => new Request(ORIGIN + path, {
  method, body, headers: { ...(token ? { 'cf-access-jwt-assertion': token } : {}), ...headers },
});

// --- token verification ---
test('accepts a valid owner token', async () => {
  resetKeyCache();
  assert.deepEqual((await verifyAccess(await sign(), ENV_BASE))?.email, OWNER);
});

test('rejects tokens that are wrong in any way', async () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    'wrong audience': await sign({ aud: ['b'.repeat(64)] }),
    'wrong issuer': await sign({ iss: 'https://evil.cloudflareaccess.com' }),
    'expired': await sign({ exp: now - 1 }),
    'not yet valid': await sign({ nbf: now + 600 }),
    'other account': await sign({ email: 'someone@example.com' }),
    'no email (service token)': await sign({ email: undefined }),
    'signed by another key': await sign({}, { key: other.privateKey }),
    'unknown kid': await sign({}, { header: { alg: 'RS256', kid: 'nope' } }),
    'alg none': `${b64u(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${b64u(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, email: OWNER, exp: now + 60 }))}.x`,
    'garbage': 'not.a.jwt',
    'empty': '',
  };
  const good = await sign();
  const [h, , s] = good.split('.');
  cases['tampered claims'] = `${h}.${b64u(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, email: OWNER, exp: now + 99999 }))}.${s}`;
  for (const [name, token] of Object.entries(cases)) assert.equal(await verifyAccess(token, ENV_BASE), null, name);
});

test('fails closed when the Worker is not configured', async () => {
  const token = await sign();
  for (const env of [{}, { ...ENV_BASE, ACCESS_AUDIENCE: '' }, { ...ENV_BASE, OWNER_EMAIL: '' }, { ...ENV_BASE, ACCESS_TEAM_DOMAIN: 'evil.com' }]) {
    assert.equal(await verifyAccess(token, env), null);
  }
});

test('caches signing keys', async () => {
  resetKeyCache(); jwksCalls = 0;
  const token = await sign();
  await verifyAccess(token, ENV_BASE); await verifyAccess(token, ENV_BASE);
  assert.equal(jwksCalls, 1);
});

// --- routing ---
test('public pages are served with security headers and no sign-in', async () => {
  const res = await worker.fetch(req('/'), makeEnv());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal((await worker.fetch(req('/', { method: 'POST' }), makeEnv())).status, 405);
});

test('app and api need a valid token', async () => {
  const env = makeEnv();
  for (const path of ['/app', '/app/', '/api/me', '/api/v1/models']) {
    const res = await worker.fetch(req(path), env);
    assert.equal(res.status, 401, path);
    assert.equal(res.headers.get('cache-control'), 'no-store, private');
  }
  const forged = await sign({}, { key: other.privateKey });
  assert.equal((await worker.fetch(req('/api/v1/models', { token: forged }), env)).status, 401);
  assert.equal(env.calls.length, 0, 'gateway never called without a valid token');
});

test('signed-in owner gets the app and their identity', async () => {
  const token = await sign();
  const app = await worker.fetch(req('/app/', { token }), makeEnv());
  assert.equal(app.status, 200);
  assert.equal(app.headers.get('cache-control'), 'no-store, private');
  const me = await (await worker.fetch(req('/api/me', { token }), makeEnv())).json();
  assert.equal(me.email, OWNER);
});

test('reads are forwarded with only the Access assertion', async () => {
  const token = await sign();
  const env = makeEnv();
  const res = await worker.fetch(req('/api/v1/nexus/status', { token, headers: { cookie: 'CF_Authorization=secret', 'x-forwarded-for': '1.2.3.4' } }), env);
  assert.equal(res.status, 200);
  const sent = env.calls[0];
  assert.equal(new URL(sent.url).pathname, '/v1/nexus/status');
  assert.equal(sent.headers.get('authorization'), `Bearer ${token}`);
  assert.equal(sent.headers.get('cookie'), null);
  assert.equal(sent.headers.get('x-forwarded-for'), null);
});

test('writes, the SSH relay and unknown routes are refused before the gateway', async () => {
  const token = await sign();
  const env = makeEnv();
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const blocked = [
    ['PUT', `/api/v1/conversations/${uuid}`], ['DELETE', `/api/v1/conversations/${uuid}`],
    ['POST', '/api/v1/nexus/models/0123456789abcdef/load'], ['POST', '/api/v1/nexus/models/unload'],
    ['POST', '/api/v1/nexus/agent-runs'], ['POST', `/api/v1/nexus/agent-runs/${'a'.repeat(32)}/cancel`],
    ['POST', '/api/v1/nexus/workspaces/debian/gw/tasks'], ['POST', '/api/v1/nexus/workspaces/debian/gw/patches'],
    ['GET', '/api/v1/ssh/debian'], ['GET', '/api/v1/minecraft/panel'], ['GET', '/api/healthz'], ['GET', '/api/v2/anything'],
    ['GET', '/api/v1/nexus/workspaces/windows'],
  ];
  for (const [method, path] of blocked) {
    const res = await worker.fetch(req(path, { token, method, headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: method === 'GET' ? undefined : '{}' }), env);
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  assert.equal(env.calls.length, 0);
});

test('chat posts need same-origin JSON within the size limit', async () => {
  const token = await sign();
  const env = makeEnv();
  const body = JSON.stringify({ model: 'm', messages: [], stream: true });
  const post = headers => worker.fetch(req('/api/v1/chat/completions', { token, method: 'POST', headers, body }), env);
  assert.equal((await post({ 'content-type': 'application/json' })).status, 403, 'no origin');
  assert.equal((await post({ origin: 'https://evil.example', 'content-type': 'application/json' })).status, 403, 'other origin');
  assert.equal((await post({ origin: ORIGIN, 'content-type': 'text/plain' })).status, 415, 'not json');
  assert.equal(env.calls.length, 0);
  assert.equal((await post({ origin: ORIGIN, 'content-type': 'application/json' })).status, 200);
  assert.equal(await env.calls[0].text(), body);
  const big = await worker.fetch(req('/api/v1/search', { token, method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: 'x'.repeat(20_000) }), env);
  assert.equal(big.status, 413);
});

test('workspace paths are validated and rebuilt', async () => {
  const token = await sign();
  const env = makeEnv();
  const base = '/api/v1/nexus/workspaces/debian/nexus-gateway';
  for (const q of ['?path=../etc', '?path=/etc/passwd', '?path=a//b', '?path=a&path=b', '?path=a&x=1', '?path=a%5Cb']) {
    assert.equal((await worker.fetch(req(`${base}/files${q}`, { token }), env)).status, 400, q);
  }
  assert.equal((await worker.fetch(req(`${base}/context`, { token }), env)).status, 400, 'context needs a path');
  assert.equal((await worker.fetch(req('/api/v1/models?x=1', { token }), env)).status, 400);
  assert.equal(env.calls.length, 0);
  assert.equal((await worker.fetch(req(`${base}/files?path=src/main.go`, { token }), env)).status, 200);
  assert.equal(new URL(env.calls[0].url).search, '?path=src%2Fmain.go');
});

test('gateway redirects and failures do not leak', async () => {
  const token = await sign();
  const redirect = await worker.fetch(req('/api/v1/models', { token }), makeEnv(() => new Response(null, { status: 302, headers: { location: 'https://evil' } })));
  assert.equal(redirect.status, 502);
  assert.equal(redirect.headers.get('location'), null);
  const down = await worker.fetch(req('/api/v1/models', { token }), makeEnv(() => { throw new Error('boom'); }));
  assert.equal(down.status, 502);
});

test('allowlist matches Desktop read and inference routes', () => {
  assert.ok(classify('GET', '/v1/nexus/workspaces/nixos/home/context'));
  assert.ok(classify('POST', '/v1/research'));
  assert.equal(classify('GET', '/v1/chat/completions'), null);
  assert.equal(classify('POST', '/v1/models'), null);
});
