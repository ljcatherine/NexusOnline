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

test('workspace writes, conversation writes and unknown routes are refused before the gateway', async () => {
  const token = await sign();
  const env = makeEnv();
  const uuid = '123e4567-e89b-12d3-a456-426614174000';
  const blocked = [
    ['PUT', `/api/v1/conversations/${uuid}`], ['DELETE', `/api/v1/conversations/${uuid}`],
    ['POST', '/api/v1/nexus/models/NOTHEX/load'], ['GET', '/api/v1/nexus/models/unload'],
    ['POST', '/api/v1/nexus/workspaces/debian/gw/tasks'], ['POST', '/api/v1/nexus/workspaces/debian/gw/patches'],
    ['GET', '/api/v1/ssh/windows'], ['GET', '/api/v1/minecraft/panel'], ['GET', '/api/healthz'], ['GET', '/api/v2/anything'],
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

test('allowlist matches the iPhone app routes', () => {
  assert.ok(classify('GET', '/v1/nexus/workspaces/nixos/home/context'));
  assert.ok(classify('POST', '/v1/research'));
  assert.equal(classify('GET', '/v1/chat/completions'), null);
  assert.equal(classify('POST', '/v1/models'), null);
});

test('iPhone-app controls pass with no body and only from this origin', async () => {
  const token = await sign();
  const env = makeEnv();
  const run = 'a'.repeat(32);
  for (const path of ['/api/v1/nexus/models/0123456789abcdef/load', '/api/v1/nexus/models/unload', `/api/v1/nexus/agent-runs/${run}/cancel`]) {
    assert.equal((await worker.fetch(req(path, { token, method: 'POST' }), env)).status, 403, `${path} without origin`);
    assert.equal((await worker.fetch(req(path, { token, method: 'POST', headers: { origin: ORIGIN }, body: '{"x":1}' }), env)).status, 413, `${path} with body`);
    assert.equal((await worker.fetch(req(path, { token, method: 'POST', headers: { origin: ORIGIN } }), env)).status, 200, path);
  }
  assert.equal(env.calls.length, 3);
  const start = await worker.fetch(req('/api/v1/nexus/agent-runs', { token, method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{"prompt":"hi"}' }), env);
  assert.equal(start.status, 200);
});

test('SSH tunnel needs the owner, this origin, a WebSocket and the subprotocol', async () => {
  const token = await sign();
  const ws = { origin: ORIGIN, upgrade: 'websocket', 'sec-websocket-protocol': 'nexus-ssh-v1' };
  const fake = {};
  const env = makeEnv(() => ({ status: 101, webSocket: fake, headers: new Headers({ 'sec-websocket-protocol': 'nexus-ssh-v1' }) }));
  assert.equal((await worker.fetch(req('/api/v1/ssh/debian', { headers: ws }), env)).status, 401, 'no token');
  assert.equal((await worker.fetch(req('/api/v1/ssh/debian', { token, headers: { ...ws, origin: 'https://evil.example' } }), env)).status, 403, 'other origin');
  assert.equal((await worker.fetch(req('/api/v1/ssh/debian', { token, headers: { ...ws, upgrade: '' } }), env)).status, 426, 'not a websocket');
  assert.equal((await worker.fetch(req('/api/v1/ssh/debian', { token, headers: { ...ws, 'sec-websocket-protocol': 'x' } }), env)).status, 426, 'wrong protocol');
  assert.equal((await worker.fetch(req('/api/v1/ssh/debian?x=1', { token, headers: ws }), env)).status, 426, 'query');
  assert.equal(env.calls.length, 0);
  let res;
  try { res = await worker.fetch(req('/api/v1/ssh/nixos', { token, headers: ws }), env); } catch (e) {
    // Node's Response cannot carry status 101; workerd can. Reaching here means the Worker tried to return the upgrade.
    assert.match(String(e), /101|status/);
  }
  if (res) assert.equal(res.status, 101);
  const sent = env.calls[0];
  assert.equal(new URL(sent.url).pathname, '/v1/ssh/nixos');
  assert.equal(sent.headers.get('authorization'), `Bearer ${token}`);
  assert.equal(sent.headers.get('sec-websocket-protocol'), 'nexus-ssh-v1');
  const failed = makeEnv(() => new Response('nope', { status: 500 }));
  assert.equal((await worker.fetch(req('/api/v1/ssh/debian', { token, headers: ws }), failed)).status, 502);
});

test('relay devices come only from valid config', async () => {
  const token = await sign();
  const env = { ...makeEnv(), RELAY_DEVICES: JSON.stringify([{ name: 'Debian', username: 'liam', target: 'debian' }, { username: 'root;rm', target: 'debian' }, { username: 'x', target: 'windows' }]) };
  const me = await (await worker.fetch(req('/api/me', { token }), env)).json();
  assert.deepEqual(me.devices, [{ name: 'Debian', username: 'liam', target: 'debian' }]);
});

// --- Nexus Mail (mail host -> Debian mail service) ---
import { fakeD1 } from '../scripts/fake-d1.mjs';
import { drainQueue } from './mail.js';
const MAIL = 'https://mail.example.com';
const MAIL_TOKEN = 'm'.repeat(48);
const RAW = 'From: Sam <sam@example.org>\r\nTo: me@example.com\r\nSubject: Hi\r\n\r\nHello\r\n';
const incoming = (raw = RAW, extra = {}) => ({
  from: 'bounce@example.org', to: 'me@example.com', rawSize: raw.length,
  raw: new Response(raw).body, rejected: null, setReject(r) { this.rejected = r; }, ...extra,
});
function mailEnv(serviceResponse = () => Response.json({ ok: true })) {
  const mailCalls = [];
  return {
    ...makeEnv(), MAIL_HOST: 'mail.example.com', MAIL: fakeD1(), MAIL_SERVICE_TOKEN: MAIL_TOKEN, mailCalls,
    NEXUS_MAIL: { fetch: async req => { mailCalls.push({ req, body: req.body ? new Uint8Array(await req.arrayBuffer()) : null }); return serviceResponse(req); } },
  };
}
const mreq = (path, opts = {}) => new Request(MAIL + path, opts);
const queued = async env => (await env.MAIL.prepare('SELECT COUNT(*) n FROM inbound_queue').first()).n;
const THREAD = '6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8';

test('incoming mail is handed to Debian with the service token', async () => {
  const env = mailEnv();
  await worker.email(incoming(), env);
  const [{ req: sent, body }] = env.mailCalls;
  assert.equal(sent.url, 'http://nexus-mail.internal/inbound');
  assert.equal(sent.headers.get('authorization'), `Bearer ${MAIL_TOKEN}`);
  assert.equal(sent.headers.get('x-envelope-to'), 'me@example.com');
  assert.equal(new TextDecoder().decode(body), RAW);
  assert.equal(await queued(env), 0);
});

test('mail waits in D1 while Debian is down, then the cron hands it over', async () => {
  let up = false;
  const env = mailEnv(() => up ? Response.json({ ok: true }) : new Response('down', { status: 502 }));
  await worker.email(incoming(), env);
  assert.equal(await queued(env), 1);
  assert.equal(await drainQueue(env), 0);
  up = true;
  const waits = [];
  await worker.scheduled({}, env, { waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  assert.equal(await queued(env), 0);
  assert.equal(new TextDecoder().decode(env.mailCalls.at(-1).body), RAW);
  // Too big to hold: refuse, so the sender's server retries instead of the mail being lost.
  up = false;
  await assert.rejects(worker.email(incoming('x'.repeat(2_000_000)), env));
  const huge = incoming(RAW, { rawSize: 26 * 1024 * 1024 });
  await worker.email(huge, env);
  assert.match(huge.rejected, /too large/);
});

test('mail host is owner-only on every path; public host never serves mail', async () => {
  const env = mailEnv();
  for (const p of ['/', '/api/mail/threads', '/_astro/x.js']) assert.equal((await worker.fetch(mreq(p), env)).status, 401, p);
  assert.equal((await worker.fetch(mreq('/api/mail/threads', { headers: { 'cf-access-jwt-assertion': await sign({ email: 'someone@example.com' }) } }), env)).status, 401);
  const page = await worker.fetch(mreq('/', { headers: { 'cf-access-jwt-assertion': await sign() } }), env);
  assert.equal(await page.text(), 'asset /mail/');
  assert.equal(page.headers.get('cache-control'), 'no-store, private');
  assert.equal((await worker.fetch(req('/mail/'), env)).status, 404);
  assert.equal((await worker.fetch(req('/api/mail/threads', { token: await sign() }), env)).status, 403);
  assert.equal(env.calls.length + env.mailCalls.length, 0);
});

test('mail API forwards only allowlisted routes, with the token and clean queries', async () => {
  const env = mailEnv(r => Response.json({ path: new URL(r.url).pathname + new URL(r.url).search }));
  const auth = { 'cf-access-jwt-assertion': await sign() };
  const res = await worker.fetch(mreq('/api/mail/threads?folder=sent&q=50%25+off&offset=50', { headers: auth }), env);
  assert.equal((await res.json()).path, '/threads?folder=sent&q=50%25+off&offset=50');
  assert.equal(env.mailCalls[0].req.headers.get('authorization'), `Bearer ${MAIL_TOKEN}`);
  assert.equal(res.headers.get('authorization'), null);
  const refused = [
    ['/api/mail/threads?folder=../../etc', 'GET', 400], ['/api/mail/threads?folder=inbox&folder=sent', 'GET', 400],
    ['/api/mail/threads?x=1', 'GET', 400], [`/api/mail/threads/${THREAD}?x=1`, 'GET', 400], ['/api/mail/inbound', 'POST', 404],
    ['/api/mail/threads/not-a-uuid', 'GET', 404], [`/api/mail/threads/${THREAD}/explode`, 'POST', 404], ['/api/mail/send', 'GET', 404],
  ];
  for (const [path, method, status] of refused) {
    assert.equal((await worker.fetch(mreq(path, { method, headers: { ...auth, origin: MAIL } }), env)).status, status, path);
  }
  assert.equal(env.mailCalls.length, 1);
});

test('mail changes need same-origin JSON within limits', async () => {
  const env = mailEnv();
  const auth = { 'cf-access-jwt-assertion': await sign() };
  const send = (headers, body = '{}') => worker.fetch(mreq('/api/mail/send', { method: 'POST', headers: { ...auth, ...headers }, body }), env);
  assert.equal((await send({ origin: 'https://evil.example', 'content-type': 'application/json' })).status, 403);
  assert.equal((await send({ 'content-type': 'application/json' })).status, 403);
  assert.equal((await send({ origin: MAIL, 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send({ origin: MAIL, 'content-type': 'application/json', 'content-length': String(40 * 1024 * 1024) })).status, 413);
  assert.equal((await worker.fetch(mreq(`/api/mail/threads/${THREAD}/trash`, { method: 'POST', headers: auth }), env)).status, 403);
  assert.equal(env.mailCalls.length, 0);
  assert.equal((await send({ origin: MAIL, 'content-type': 'application/json', 'content-length': '2' })).status, 200);
  assert.equal((await worker.fetch(mreq(`/api/mail/threads/${THREAD}/trash`, { method: 'POST', headers: { ...auth, origin: MAIL } }), env)).status, 200);
  assert.equal(env.mailCalls.length, 2);
});

test('attachments always download; a missing or down mail server fails cleanly', async () => {
  const auth = { 'cf-access-jwt-assertion': await sign() };
  const env = mailEnv(() => new Response('<script>alert(1)</script>', { headers: { 'content-type': 'text/html', 'content-disposition': 'inline' } }));
  const res = await worker.fetch(mreq(`/api/mail/messages/${THREAD}/attachments/0`, { headers: auth }), env);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  assert.equal(res.headers.get('content-disposition'), 'attachment');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const down = mailEnv(() => { throw new Error('tunnel down'); });
  assert.equal((await worker.fetch(mreq('/api/mail/threads', { headers: auth }), down)).status, 502);
  const none = { ...mailEnv(), MAIL_SERVICE_TOKEN: '' };
  assert.equal((await worker.fetch(mreq('/api/mail/threads', { headers: auth }), none)).status, 503);
});
