// Nexus Online Worker.
//   /, /_astro/*             public landing page
//   /app/*                   web app, owner only (Cloudflare Access + token check here)
//   /api/v1/*                gateway proxy, owner only, the iPhone app's route allowlist
//   /api/v1/ssh/{host}       WebSocket SSH tunnel to the gateway relay (bytes only; SSH runs in the browser)
import { classify, workspaceQuery, SSH_TARGET } from './routes.js';
import { verifyAccess } from './access.js';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'content-security-policy': CSP,
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

function secure(res, isPrivate) {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  if (isPrivate) headers.set('cache-control', 'no-store, private');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

async function readBounded(body, limit) {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

async function proxy(request, env, url, assertion) {
  const path = url.pathname.slice('/api'.length);
  const route = classify(request.method, path);
  if (!route) return json(403, { error: 'Nexus Online is read-only. This action is only available in Nexus Desktop or the iPhone app.' });

  let search = '';
  if (route.pathQuery) {
    search = workspaceQuery(url.searchParams, route.pathRequired);
    if (search === null) return json(400, { error: 'That file path is not valid.' });
  } else if (url.search) {
    return json(400, { error: 'Unexpected query string.' });
  }

  const headers = new Headers({ authorization: `Bearer ${assertion}` });
  const accept = request.headers.get('accept');
  if (accept) headers.set('accept', accept);
  let body = null;

  // CSRF: only this site's own pages may post.
  if (request.method === 'POST' && request.headers.get('origin') !== url.origin) return json(403, { error: 'Cross-site request blocked.' });
  if (request.method === 'POST' && route.noBody) {
    if (await readBounded(request.body, 0) === null) return json(413, { error: 'This action takes no body.' });
  } else if (request.method === 'POST') {
    // Only JSON, which forces a CORS preflight cross-site.
    const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return json(415, { error: 'Send JSON.' });
    const length = request.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > route.maxBody)) return json(413, { error: 'Request too large.' });
    body = await readBounded(request.body, route.maxBody);
    if (body === null) return json(413, { error: 'Request too large.' });
    headers.set('content-type', 'application/json');
  }

  if (typeof env.NEXUS_GATEWAY?.fetch !== 'function') return json(503, { error: 'The gateway is not connected.' });
  try {
    const upstream = await env.NEXUS_GATEWAY.fetch(new Request(`http://nexus-gateway.internal${path}${search}`, {
      method: request.method, headers, body, redirect: 'manual', signal: request.signal,
    }));
    if (upstream.status >= 300 && upstream.status < 400) return json(502, { error: 'The gateway is unreachable.' });
    const out = new Headers({ 'cache-control': 'no-store' });
    for (const name of ['content-type', 'retry-after', 'etag']) {
      const v = upstream.headers.get(name);
      if (v !== null) out.set(name, v);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  } catch {
    return json(502, { error: 'The gateway is unreachable.' });
  }
}

/** Optional RELAY_DEVICES var: [{"name","username","target"}], like the iPhone app's NexusRelayDevices. */
function relayDevices(env) {
  try {
    const list = typeof env.RELAY_DEVICES === 'string' ? JSON.parse(env.RELAY_DEVICES) : env.RELAY_DEVICES;
    return (Array.isArray(list) ? list : []).filter(d => /^(debian|nixos)$/.test(d?.target) && /^[a-z_][a-z0-9_-]{0,31}$/.test(d?.username))
      .slice(0, 8).map(d => ({ name: String(d.name ?? d.target).slice(0, 40), username: d.username, target: d.target }));
  } catch { return []; }
}

const SSH_PROTOCOL = 'nexus-ssh-v1';

// Same handshake as the gateway Worker in NexusiOS (cloudflare/worker.mjs). The SSH
// session itself is end-to-end between the browser and the gateway's relay server.
async function sshTunnel(request, env, url, assertion, target) {
  if (request.method !== 'GET' || url.search || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return json(426, { error: 'WebSocket upgrade required.' });
  // Browsers send cookies on cross-site WebSocket handshakes, so the origin check is the CSRF guard here.
  if (request.headers.get('origin') !== url.origin) return json(403, { error: 'Cross-site request blocked.' });
  const offered = (request.headers.get('sec-websocket-protocol') ?? '').split(',').map(s => s.trim());
  if (!offered.includes(SSH_PROTOCOL)) return json(426, { error: 'SSH WebSocket subprotocol required.' });
  if (typeof env.NEXUS_GATEWAY?.fetch !== 'function') return json(503, { error: 'The gateway is not connected.' });
  let upstream;
  try {
    upstream = await env.NEXUS_GATEWAY.fetch(new Request(`http://nexus-gateway.internal/v1/ssh/${target}`, {
      method: 'GET', redirect: 'manual', signal: request.signal,
      headers: { authorization: `Bearer ${assertion}`, upgrade: 'websocket', 'sec-websocket-protocol': SSH_PROTOCOL },
    }));
  } catch {
    return json(502, { error: 'The SSH relay is unavailable.' });
  }
  const chosen = upstream.headers.get('sec-websocket-protocol');
  if (upstream.status !== 101 || !upstream.webSocket || (chosen !== null && chosen !== SSH_PROTOCOL)) {
    return json(upstream.status === 429 ? 429 : 502, { error: upstream.status === 429 ? 'Too many SSH sessions are open.' : 'The SSH relay is unavailable.' });
  }
  return new Response(null, { status: 101, webSocket: upstream.webSocket, headers: { 'sec-websocket-protocol': SSH_PROTOCOL } });
}

const SIGN_IN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Nexus Online</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070C18;color:#E9EDF7;font:16px/1.6 system-ui,sans-serif;padding:24px}
main{max-width:460px;display:grid;gap:14px}h1{font-size:28px;margin:0}p{margin:0;color:#A6AFC2}a{color:#9CBCFF}
.btn{display:inline-block;padding:11px 18px;border-radius:12px;background:linear-gradient(135deg,#9CBCFF,#C9ADFF);color:#070C18;font-weight:600;text-decoration:none}
</style></head><body><main><h1>Sign in to use Nexus Online</h1>
<p>Nexus Online is only for the owner. Your sign-in is missing, has expired, or belongs to a different account.</p>
<p><a class="btn" href="/cdn-cgi/access/logout">Sign out and try again</a></p>
<p><a href="/">Back to the Nexus home page</a></p></main></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    const isApp = p === '/app' || p.startsWith('/app/');
    const isApi = p === '/api' || p.startsWith('/api/');

    if (!isApp && !isApi) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return secure(json(405, { error: 'Method not allowed.' }));
      return secure(await env.ASSETS.fetch(request));
    }

    const assertion = request.headers.get('cf-access-jwt-assertion') ?? '';
    const who = await verifyAccess(assertion, env);
    if (!who) {
      return secure(isApi
        ? json(401, { error: 'Sign-in required.' })
        : new Response(SIGN_IN_PAGE, { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } }), true);
    }

    if (isApp) {
      if (request.method !== 'GET' && request.method !== 'HEAD') return secure(json(405, { error: 'Method not allowed.' }), true);
      return secure(await env.ASSETS.fetch(request), true);
    }
    if (p === '/api/me') {
      if (request.method !== 'GET') return secure(json(405, { error: 'Method not allowed.' }), true);
      return secure(json(200, { email: who.email, expiresAt: who.exp, devices: relayDevices(env) }), true);
    }
    const ssh = SSH_TARGET.exec(p.slice('/api'.length));
    if (ssh) {
      const res = await sshTunnel(request, env, url, assertion, ssh[1]);
      return res.status === 101 ? res : secure(res, true);
    }
    return secure(await proxy(request, env, url, assertion), true);
  },
};
