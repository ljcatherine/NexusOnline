// Private inbox: Cloudflare Email Routing hands each message to receive(), which
// stores it in D1 (binding MAIL). mailApi() serves it to mail.<domain>, owner only.
import PostalMime from 'postal-mime';

const MAX_RAW = 10 * 1024 * 1024;
// D1 rows max out at 2 MB; 250k chars of text + html stays under it even at 4 bytes/char.
const MAX_PART = 250_000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const cut = s => (typeof s === 'string' ? s : '').slice(0, MAX_PART);

/** Email Worker entry point. Throwing here makes Cloudflare refuse the message, so nothing is silently lost. */
export async function receive(message, env) {
  if (message.rawSize > MAX_RAW) return message.setReject('Message too large for this inbox (10 MB limit).');
  const mail = await PostalMime.parse(await new Response(message.raw).arrayBuffer());
  // shortcut: attachments are listed by name only, not stored; add an R2 bucket if you need to open them.
  const attachments = (mail.attachments ?? []).slice(0, 50).map(a => ({
    filename: String(a.filename ?? 'attachment').slice(0, 200),
    mimeType: String(a.mimeType ?? ''),
    size: a.content?.byteLength ?? 0,
  }));
  await env.MAIL.prepare(`INSERT INTO mail (id, received_at, envelope_from, envelope_to, from_addr, from_name, subject, text, html, attachments)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    crypto.randomUUID(), Date.now(), String(message.from), String(message.to),
    String(mail.from?.address || message.from).slice(0, 320), String(mail.from?.name ?? '').slice(0, 200),
    String(mail.subject ?? '').slice(0, 998), cut(mail.text), cut(mail.html), JSON.stringify(attachments),
  ).run();
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

/** /api/mail routes. Caller has already verified the owner's Access token. */
export async function mailApi(request, env, url) {
  if (typeof env.MAIL?.prepare !== 'function') return json(503, { error: 'Mail storage is not connected.' });
  if (url.search) return json(400, { error: 'Unexpected query string.' });
  const [, , , id, action, extra] = url.pathname.split('/'); // '', 'api', 'mail', id, action
  const m = request.method;

  if (!id) {
    if (m !== 'GET') return json(405, { error: 'Method not allowed.' });
    const { results } = await env.MAIL.prepare(`SELECT id, received_at, envelope_to, from_addr, from_name, subject,
      substr(CASE WHEN text != '' THEN text ELSE html END, 1, 300) AS snippet, read, attachments != '[]' AS has_attachments
      FROM mail ORDER BY received_at DESC LIMIT 500`).all();
    return json(200, { messages: results });
  }
  if (!ID.test(id) || extra !== undefined) return json(404, { error: 'Not found.' });

  // CSRF: changes must come from this site's own pages.
  if (m !== 'GET' && request.headers.get('origin') !== url.origin) return json(403, { error: 'Cross-site request blocked.' });

  if (m === 'GET' && !action) {
    const row = await env.MAIL.prepare('SELECT * FROM mail WHERE id = ?').bind(id).first();
    if (!row) return json(404, { error: 'Not found.' });
    return json(200, { ...row, attachments: JSON.parse(row.attachments) });
  }
  if (m === 'POST' && (action === 'read' || action === 'unread')) {
    const r = await env.MAIL.prepare('UPDATE mail SET read = ? WHERE id = ?').bind(action === 'read' ? 1 : 0, id).run();
    return r.meta.changes ? json(200, { ok: true }) : json(404, { error: 'Not found.' });
  }
  if (m === 'DELETE' && !action) {
    const r = await env.MAIL.prepare('DELETE FROM mail WHERE id = ?').bind(id).run();
    return r.meta.changes ? json(200, { ok: true }) : json(404, { error: 'Not found.' });
  }
  return json(405, { error: 'Method not allowed.' });
}
