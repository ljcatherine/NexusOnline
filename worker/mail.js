// Nexus Mail, Worker side. The mailbox lives on the owner's Debian box (NexusBackend mail/server.py),
// reached only through the private tunnel binding NEXUS_MAIL with the MAIL_SERVICE_TOKEN secret.
// Incoming mail goes straight there; while Debian is unreachable it waits in D1 (inbound_queue)
// and the cron trigger retries. Nothing else about the mailbox is stored on Cloudflare.
const SERVICE = 'http://nexus-mail.internal';
const MB = 1024 * 1024;
const MAX_RAW = 25 * MB;          // Email Routing's own inbound limit
const MAX_QUEUED = 1_900_000;     // D1 rows top out at 2 MB
const MAX_SEND = 32 * MB;         // JSON with base64 attachments; the service enforces 25 MB per message
const MAX_JSON = 1 * MB;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FOLDERS = new Set(['inbox', 'starred', 'sent', 'drafts', 'all', 'trash']);
const re = s => new RegExp(`^${s}$`);

// [method, path, rules]. Anything else answers 404 before reaching Debian.
const ROUTES = [
  ['GET', re('/threads'), { query: true }],
  ['GET', re(`/threads/${UUID}`)],
  ['POST', re(`/threads/${UUID}/(?:read|unread|star|unstar|archive|inbox|trash|untrash|delete)`)],
  ['GET', re(`/drafts/${UUID}`)],
  ['PUT', re(`/drafts/${UUID}`), { body: MAX_JSON }],
  ['DELETE', re(`/drafts/${UUID}`)],
  ['POST', re('/send'), { body: MAX_SEND }],
  ['GET', re('/contacts')],
  ['GET', re('/config')],
  ['GET', re(`/messages/${UUID}/attachments/\\d{1,2}`), { download: true }],
];

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const token = env => {
  const t = String(env.MAIL_SERVICE_TOKEN ?? '');
  return t.length >= 32 && !/\s/.test(t) ? t : '';
};
const connected = env => typeof env.NEXUS_MAIL?.fetch === 'function' && token(env) !== '';

async function deliver(env, raw, from, to) {
  if (!connected(env)) return false;
  try {
    const res = await env.NEXUS_MAIL.fetch(new Request(`${SERVICE}/inbound`, {
      method: 'POST', body: raw, redirect: 'manual',
      headers: { authorization: `Bearer ${token(env)}`, 'content-type': 'message/rfc822', 'x-envelope-from': from, 'x-envelope-to': to },
    }));
    return res.ok;
  } catch {
    return false;
  }
}

/** Email Worker entry point. Throwing makes Cloudflare refuse the message so the sender's server retries. */
export async function receive(message, env) {
  if (message.rawSize > MAX_RAW) return message.setReject('Message too large for this inbox (25 MB limit).');
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const from = String(message.from), to = String(message.to);
  if (await deliver(env, raw, from, to)) return;
  if (raw.byteLength > MAX_QUEUED || typeof env.MAIL?.prepare !== 'function') {
    throw new Error('Mail server unreachable and the message is too large to hold; the sender will retry.');
  }
  await env.MAIL.prepare('INSERT INTO inbound_queue (id, received_at, envelope_from, envelope_to, raw) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), Date.now(), from, to, raw).run();
}

/** Cron: hand queued mail to Debian, oldest first. Stops at the first failure; the next run tries again. */
export async function drainQueue(env) {
  if (typeof env.MAIL?.prepare !== 'function') return 0;
  const { results } = await env.MAIL.prepare('SELECT id, envelope_from, envelope_to, raw FROM inbound_queue ORDER BY received_at LIMIT 25').all();
  let done = 0;
  for (const row of results) {
    if (!await deliver(env, new Uint8Array(row.raw), row.envelope_from, row.envelope_to)) break;
    await env.MAIL.prepare('DELETE FROM inbound_queue WHERE id = ?').bind(row.id).run();
    done++;
  }
  return done;
}

function cleanQuery(params) {
  const out = new URLSearchParams();
  for (const [k, v] of params) {
    if (out.has(k)) return null;
    if (k === 'folder' && FOLDERS.has(v)) out.set(k, v);
    else if (k === 'q' && v.length <= 200 && !/[\0\r\n]/.test(v)) out.set(k, v);
    else if (k === 'offset' && /^\d{1,5}$/.test(v)) out.set(k, v);
    else return null;
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}

/** /api/mail/* on the mail host. The caller has already verified the owner's Access token. */
export async function mailApi(request, env, url) {
  const path = url.pathname.slice('/api/mail'.length) || '/';
  const m = request.method;
  const route = ROUTES.find(([method, pattern]) => method === m && pattern.test(path));
  if (!route) return json(404, { error: 'Not found.' });
  const rules = route[2] ?? {};

  let search = '';
  if (rules.query) {
    search = cleanQuery(url.searchParams);
    if (search === null) return json(400, { error: 'Unexpected search parameters.' });
  } else if (url.search) {
    return json(400, { error: 'Unexpected query string.' });
  }

  // CSRF: changes only from this site's own pages, bodies only as JSON (forces a preflight cross-site).
  if (m !== 'GET' && request.headers.get('origin') !== url.origin) return json(403, { error: 'Cross-site request blocked.' });
  const headers = new Headers({ authorization: `Bearer ${token(env)}` });
  let body = null;
  if (rules.body) {
    const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return json(415, { error: 'Send JSON.' });
    const length = request.headers.get('content-length');
    if (length === null || !/^\d+$/.test(length)) return json(411, { error: 'Content-Length is required.' });
    if (Number(length) > rules.body) return json(413, { error: 'That is too large. Attachments can total about 18 MB.' });
    body = await request.arrayBuffer();
    if (body.byteLength > rules.body) return json(413, { error: 'Request too large.' });
    headers.set('content-type', 'application/json');
  }

  if (!connected(env)) return json(503, { error: 'Your mail server is not connected yet.' });
  let upstream;
  try {
    upstream = await env.NEXUS_MAIL.fetch(new Request(`${SERVICE}${path}${search}`, { method: m, headers, body, redirect: 'manual', signal: request.signal }));
  } catch {
    return json(502, { error: 'Your mail server (Debian) is unreachable right now.' });
  }
  if (upstream.status >= 300 && upstream.status < 400) return json(502, { error: 'Your mail server is unreachable right now.' });
  const out = new Headers({ 'cache-control': 'no-store, private' });
  if (rules.download && upstream.ok) {
    const disposition = upstream.headers.get('content-disposition') ?? '';
    out.set('content-type', 'application/octet-stream');
    out.set('content-disposition', /^attachment;/.test(disposition) ? disposition : 'attachment');
  } else {
    out.set('content-type', 'application/json; charset=utf-8');
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
