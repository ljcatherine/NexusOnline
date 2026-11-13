// Local preview: runs the REAL Worker (worker/index.js) against dist/, with a
// sample gateway and an Access token signed by a throwaway local key.
// Sample data only. This file is never deployed (wrangler only ships worker/ and dist/).
//   npm run build && npm run preview:worker          -> signed in as the owner
//   SIGNED_OUT=1 npm run preview:worker              -> no Access token (shows the sign-in page)
//   SSH_RELAY_PORT=8790 npm run preview:worker       -> pipe /api/v1/ssh/* WebSockets to a local test SSH relay
import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';

const PORT = Number(process.env.PORT ?? 8788);
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const TEAM = 'local-preview.cloudflareaccess.com', AUD = 'f'.repeat(64), OWNER = 'owner@nexus.local';
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUDIENCE: AUD, OWNER_EMAIL: OWNER,
  RELAY_DEVICES: JSON.stringify([{ name: 'Debian', username: 'nexus', target: 'debian' }, { name: 'NixOS', username: 'nexus', target: 'nixos' }]) };

// --- throwaway signing key standing in for Cloudflare Access ---
const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => String(url) === `https://${TEAM}/cdn-cgi/access/certs`
  ? Promise.resolve(Response.json({ keys: [{ kty: 'RSA', kid: 'local', alg: 'RS256', n: jwk.n, e: jwk.e }] }))
  : realFetch(url, init);
const b64u = v => Buffer.from(v).toString('base64url');
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64u(JSON.stringify({ alg: 'RS256', kid: 'local' }))}.${b64u(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, email: OWNER, iat: now, exp: now + 8 * 3600 }))}`;
  return `${head}.${b64u(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(head)))}`;
}

// --- static assets from dist/ ---
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
env.ASSETS = {
  async fetch(request) {
    let path = decodeURIComponent(new URL(request.url).pathname);
    if (path.endsWith('/')) path += 'index.html';
    else if (!extname(path)) path += '/index.html';
    const file = normalize(join(DIST, path));
    if (!file.startsWith(DIST.replace(/[\\/]$/, '') + sep)) return new Response('Not found', { status: 404 });
    try { return new Response(await readFile(file), { headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' } }); }
    catch { return new Response('Not found', { status: 404 }); }
  },
};

// --- sample gateway ---
const RUN = 'a3f1c09e5b7d42e8a1c6f0b9d2e47c51', RUN2 = '7c2e19b04f6a4d3e8b5c1a9f0e2d6b47';
const CONV = '6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8';
const now = () => new Date().toISOString();
const FILES = {
  '': [{ name: 'cmd', path: 'cmd', kind: 'directory' }, { name: 'README.md', path: 'README.md', kind: 'file' }, { name: 'go.mod', path: 'go.mod', kind: 'file' }, { name: '.env', path: '.env', kind: 'file' }],
  cmd: [{ name: 'main.go', path: 'cmd/main.go', kind: 'file' }],
};
const TEXT = {
  'README.md': '# nexus-gateway (sample)\n\nPrivate gateway for the Nexus apps.\nRuns on Debian behind Cloudflare Access.\n\n- /v1/chat/completions proxies NexusAI\n- /v1/nexus/* talks to the agent orchestrator\n',
  'go.mod': 'module example.com/nexus-gateway\n\ngo 1.23\n',
  'cmd/main.go': 'package main\n\nimport "log"\n\nfunc main() {\n\t// sample file for the local preview\n\tlog.Println("nexus-gateway starting")\n}\n',
  '.env': 'SAMPLE_SECRET=not-a-real-value\n',
};
let tps = 18;
const MODELS = [
  { id: '0f3a9c21d4e5b687', label: 'Qwen2.5 14B Instruct Q4_K_M', drive: 'internal', fits: true, current: true, architecture: 'qwen2', fileSizeBytes: 8_990_000_000 },
  { id: '1b2c3d4e5f607182', label: 'Llama 3.1 8B Instruct Q5_K_M', drive: 'internal', fits: true, current: false, architecture: 'llama', fileSizeBytes: 5_730_000_000 },
  { id: '9a8b7c6d5e4f3021', label: 'Qwen2.5 32B Instruct Q4_K_M', drive: 'usb', fits: false, current: false, architecture: 'qwen2', fileSizeBytes: 19_850_000_000 }];
const RUNS = [
  { id: RUN, status: 'running', phase: 'Reading workspace', prompt: 'Summarise recent gateway changes', created_at: now() },
  { id: RUN2, status: 'completed', phase: 'Done', prompt: 'Explain the nexus-ro catalog', created_at: new Date(Date.now() - 864e5).toISOString() }];
function gateway(req) {
  const u = new URL(req.url), p = u.pathname;
  tps = Math.max(8, Math.min(30, tps + (Math.random() - .5) * 4));
  const routes = {
    '/v1/models': () => ({ object: 'list', data: [{ id: 'qwen2.5-14b-instruct', object: 'model' }, { id: 'llama-3.1-8b-instruct', object: 'model' }] }),
    '/v1/context': () => ({ context_window_tokens: 32768 }),
    '/v1/nexus/status': () => ({ state: 'ready', ready: true, model_id: '0f3a9c21d4e5b687', model: 'Qwen2.5 14B Instruct Q4_K_M', context_size: 32768, context_used: 6144 + Math.round(Math.random() * 800), generation_tps: +tps.toFixed(1), prompt_tps: 236, memory_pool_gib: 14, memory_free_gib: 3.1, model_gib: 8.7, kv_cache_gib: 1.9 }),
    '/v1/nexus/models': () => ({ models: MODELS }),
    '/v1/nexus/agent-runs': () => ({ runs: RUNS }),
    '/v1/nexus/agent-runs/active': () => ({ runs: [{ id: RUN, status: 'running' }] }),
    [`/v1/nexus/agent-runs/${RUN}`]: () => ({ id: RUN, status: 'running', phase: 'Reading workspace', subagents: [{ id: 'b'.repeat(32), role: 'reader', status: 'running' }], events: [{ at: Date.now() / 1000 - 40, phase: 'Queued' }, { at: Date.now() / 1000 - 30, phase: 'Reading workspace' }] }),
    [`/v1/nexus/agent-runs/${RUN2}`]: () => ({ id: RUN2, status: 'completed', phase: 'Done', subagents: [], events: [{ at: Date.now() / 1000 - 86000, phase: 'Queued' }, { at: Date.now() / 1000 - 85900, phase: 'Done' }], result: { response: 'nexus-ro accepts only catalog commands with validated arguments. It refuses raw SFTP and any write.' } }),
    '/v1/conversations': () => ({ conversations: [{ id: CONV, revision: 4, updated_at: now() }] }),
    [`/v1/conversations/${CONV}`]: () => ({ id: CONV, revision: 4, updated_at: now(), conversation: { id: CONV, title: 'Minecraft backup schedule', messages: [{ role: 'user', content: 'When does the Minecraft backup run?' }, { role: 'assistant', content: 'Every night at 04:00, after the world is saved.' }] } }),
    '/v1/nexus/workspaces/debian': () => ({ host: 'debian', workspaces: [{ id: 'nexus-gateway', name: 'nexus-gateway', read_only: true }, { id: 'minecraft', name: 'minecraft-panel', read_only: true }] }),
    '/v1/nexus/workspaces/nixos': () => ({ host: 'nixos', workspaces: [{ id: 'flake', name: 'nixos-config', read_only: true }] }),
    '/v1/search': () => ({ provider: 'sample', retrieved_at: now(), sources: [{ title: 'Cloudflare Access documentation', url: 'https://developers.cloudflare.com/cloudflare-one/', snippet: 'Sample search result.' }] }),
  };
  if (routes[p] && (req.method === 'GET' || p === '/v1/search')) return Response.json(routes[p]());
  if (req.method === 'POST') {
    const load = p.match(/^\/v1\/nexus\/models\/([0-9a-f]{16})\/load$/);
    if (load || p === '/v1/nexus/models/unload') { MODELS.forEach(m => { m.current = !!load && m.id === load[1]; }); return Response.json({ status: 'accepted' }, { status: 202 }); }
    if (p === '/v1/nexus/agent-runs') { const id = crypto.randomUUID().replace(/-/g, ''); RUNS.unshift({ id, status: 'running', phase: 'Queued', prompt: 'New run from the web', created_at: now() }); return Response.json({ id, status: 'queued' }); }
    const cancel = p.match(/^\/v1\/nexus\/agent-runs\/([0-9a-f]{32})\/cancel$/);
    if (cancel) { const r = RUNS.find(x => x.id === cancel[1]); if (r) r.status = 'cancelled'; return Response.json({ id: cancel[1], status: 'cancelled' }); }
    if (p === '/v1/research') return Response.json({ decision: { should_search: true, queries: ['sample research query'] }, planner_available: true, planner_fallback: false, failed_queries: 0,
      search_response: { provider: 'sample', retrieved_at: now(), sources: [{ title: 'Sample source', url: 'https://example.com/', snippet: 'Sample research result.' }] } });
  }
  const run = RUNS.find(r => p === `/v1/nexus/agent-runs/${r.id}`);
  if (run) return Response.json({ ...run, subagents: [], events: [{ at: Date.now() / 1000, phase: run.phase }] });
  const files = p.match(/^\/v1\/nexus\/workspaces\/(debian|nixos)\/([^/]+)\/files$/);
  if (files) { const path = u.searchParams.get('path') ?? ''; return Response.json({ host: files[1], workspace_id: files[2], path, entries: FILES[path] ?? [], truncated: false }); }
  const ctx = p.match(/^\/v1\/nexus\/workspaces\/(debian|nixos)\/([^/]+)\/context$/);
  if (ctx) { const path = u.searchParams.get('path'); const text = TEXT[path]; return text === undefined ? Response.json({ error: 'not found' }, { status: 404 }) : Response.json({ host: ctx[1], workspace_id: ctx[2], path, text, size_bytes: Buffer.byteLength(text) }); }
  if (p === '/v1/chat/completions') {
    const words = 'This is the local preview, so this reply is sample text streamed word by word. On the real site it comes from NexusAI through the gateway.\n\n```\nnexus-ro --root /usr/share/doc\n```'.split(/(?<= )/);
    const stream = new ReadableStream({ async start(c) {
      for (const w of words) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`)); await new Promise(r => setTimeout(r, 35)); }
      c.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); c.close();
    } });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }
  return Response.json({ error: 'not found' }, { status: 404 });
}
env.NEXUS_GATEWAY = { fetch: async req => gateway(req) };

// --- HTTP server ---
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  if (!process.env.SIGNED_OUT) headers.set('cf-access-jwt-assertion', await accessToken());
  const request = new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) for await (const chunk of response.body) res.write(chunk);
  res.end();
}).on('upgrade', (req, socket, head) => {
  // Node can't hand a 101 through worker.fetch, so the preview applies the Worker's WebSocket checks itself
  // and pipes the raw connection to a local test relay (any SSH server behind a nexus-ssh-v1 WebSocket).
  const relay = Number(process.env.SSH_RELAY_PORT);
  const ok = relay && /^\/api\/v1\/ssh\/(debian|nixos)$/.test(req.url) && req.headers.origin === `http://localhost:${PORT}`
    && (req.headers['sec-websocket-protocol'] ?? '').split(',').map(s => s.trim()).includes('nexus-ssh-v1') && !process.env.SIGNED_OUT;
  if (!ok) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const up = net.connect(relay, '127.0.0.1', () => {
    up.write(`GET / HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    up.write(head); up.pipe(socket); socket.pipe(up);
  });
  up.on('error', () => socket.destroy()); socket.on('error', () => up.destroy());
}).listen(PORT, () => console.log(`Nexus Online local preview (sample data): http://localhost:${PORT}  ${process.env.SIGNED_OUT ? '[signed out]' : `[signed in as ${OWNER}]`}`));
