// Nexus Mail (mail.liamjc.dev). Mail is rendered with textContent / attributes only;
// HTML bodies go into a sandboxed iframe (no scripts, no same-origin, page CSP blocks remote images).
import { api, raw, h, ApiError } from '../app/lib';

type Summary = { id: string; received_at: number; envelope_to: string; from_addr: string; from_name: string; subject: string; snippet: string; read: number; has_attachments: number };
type Full = Summary & { envelope_from: string; text: string; html: string; attachments: { filename: string; mimeType: string; size: number }[] };

const $ = (id: string) => document.getElementById(id)!;
const listEl = $('list'), readerEl = $('reader'), boxesEl = $('boxes'), search = $('search') as HTMLInputElement, statusEl = $('status');
let all: Summary[] = [], shown: Summary[] = [], box = 'inbox', openId = '', query = '';

const plain = (s: string) => s.replace(/<(style|script|head)[\s\S]*?(<\/\1>|$)/gi, ' ').replace(/<[^>]*>?/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const who = (m: { from_name: string; from_addr: string }) => m.from_name || m.from_addr;
const hue = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
const avatar = (m: Summary) => h('span', { class: 'av', style: `--h:${hue(m.from_addr)}`, 'aria-hidden': 'true' }, (who(m).match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase());

function when(ms: number, long = false) {
  const d = new Date(ms), now = new Date();
  if (long) return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) });
}
const size = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
let flashTimer = 0;
function flash(text: string, tone: 'ok' | 'err' = 'ok') {
  statusEl.textContent = text; statusEl.dataset.tone = tone; statusEl.classList.add('on');
  clearTimeout(flashTimer); flashTimer = window.setTimeout(() => statusEl.classList.remove('on'), 3200);
}

// --- mailboxes: Inbox, Unread, then one per address mail was sent to ---
function renderBoxes() {
  const unread = all.filter(m => !m.read).length;
  const addrs = [...new Set(all.map(m => m.envelope_to.toLowerCase()))].sort();
  const btn = (id: string, label: string, icon: string, count: number) => h('button', {
    type: 'button', class: 'box', 'aria-pressed': String(box === id), onclick: () => { box = id; renderBoxes(); renderList(); },
  }, h('span', { class: 'bi', 'aria-hidden': 'true' }, icon), h('span', { class: 'bl' }, label), count ? h('span', { class: 'bc' }, count) : null);
  boxesEl.replaceChildren(
    btn('inbox', 'Inbox', '✉', all.length), btn('unread', 'Unread', '●', unread),
    ...(addrs.length > 1 ? [h('p', { class: 'rail-h' }, 'Addresses'), ...addrs.map(a => btn(`to:${a}`, a, '@', all.filter(m => !m.read && m.envelope_to.toLowerCase() === a).length))] : []));
  document.title = `${unread ? `(${unread}) ` : ''}Inbox · Nexus Mail`;
}

function renderList() {
  const q = query.toLowerCase();
  shown = all.filter(m => (box === 'inbox' || (box === 'unread' ? !m.read : m.envelope_to.toLowerCase() === box.slice(3)))
    && (!q || `${m.from_name} ${m.from_addr} ${m.subject} ${m.snippet}`.toLowerCase().includes(q)));
  if (!shown.length) {
    listEl.replaceChildren(h('li', { class: 'blank' }, h('b', {}, q ? 'No matches' : box === 'unread' ? 'All caught up' : 'No mail yet'),
      h('span', {}, q ? 'Try a name, address or word from the subject.' : 'New messages show up here on their own.')));
    return;
  }
  listEl.replaceChildren(...shown.map(m => h('li', {}, h('button', {
    type: 'button', class: `item${m.read ? '' : ' unread'}`, 'aria-current': String(m.id === openId), 'data-id': m.id, onclick: () => open(m.id),
  }, avatar(m),
    h('span', { class: 'it-top' }, h('b', { class: 'from' }, who(m)), h('time', {}, when(m.received_at))),
    h('span', { class: 'subj' }, m.subject || '(no subject)', m.has_attachments ? h('span', { class: 'clip', title: 'Has attachments' }, ' ⎘') : null),
    h('span', { class: 'snip' }, plain(m.snippet))))));
}

async function load(quiet = false) {
  try {
    const r = await api<{ messages: Summary[] }>('/mail');
    const before = new Set(all.map(m => m.id));
    const fresh = all.length ? r.messages.filter(m => !before.has(m.id)).length : 0;
    all = r.messages; renderBoxes(); renderList();
    if (fresh) flash(`${fresh} new message${fresh > 1 ? 's' : ''}`);
  } catch (e) {
    if (!quiet) listEl.replaceChildren(h('li', { class: 'blank err', role: 'alert' }, h('b', {}, 'Could not load mail'), h('span', {}, (e as Error).message)));
  }
}

// --- reader ---
function frame(html: string) {
  const doc = '<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><base target="_blank">'
    + '<style>html{background:#fff;color:#1b1f27;font:15px/1.55 system-ui,sans-serif}body{margin:20px;overflow-wrap:anywhere}img{max-width:100%;height:auto}</style>' + html;
  return h('iframe', { class: 'body-html', title: 'Message', sandbox: 'allow-popups allow-popups-to-escape-sandbox', srcdoc: doc });
}

async function open(id: string) {
  openId = id;
  document.body.classList.add('reading');
  listEl.querySelectorAll('.item').forEach(b => b.setAttribute('aria-current', String((b as HTMLElement).dataset.id === id)));
  readerEl.replaceChildren(h('div', { class: 'blank' }, h('span', {}, 'Opening…')));
  let m: Full;
  try { m = await api<Full>(`/mail/${id}`); } catch (e) {
    if (e instanceof ApiError && e.status === 404) { flash('That message was deleted.', 'err'); await load(); return close(); }
    readerEl.replaceChildren(h('div', { class: 'blank err', role: 'alert' }, h('b', {}, 'Could not open it'), h('span', {}, (e as Error).message)));
    return;
  }
  if (openId !== id) return;
  if (!m.read) { raw(`/mail/${id}/read`, { method: 'POST' }).catch(() => {}); setRead(id, 1); }

  let mode: 'html' | 'text' = m.html ? 'html' : 'text';
  const body = h('div', { class: 'body' });
  const remote = /<img[^>]+src\s*=\s*["']?https?:/i.test(m.html);
  const draw = () => body.replaceChildren(
    ...(mode === 'html' && remote ? [h('p', { class: 'note' }, 'Remote images are blocked so senders cannot track when you open this.')] : []),
    mode === 'html' ? frame(m.html) : h('pre', { class: 'body-text' }, m.text || plain(m.html) || '(empty message)'));
  const toggle = m.html && m.text ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Show as' },
    ...(['html', 'text'] as const).map(k => h('button', { type: 'button', 'data-k': k, 'aria-pressed': String(mode === k), onclick: (ev: Event) => {
      mode = k; draw();
      (ev.currentTarget as HTMLElement).parentElement!.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.k === k)));
    } }, k === 'html' ? 'Formatted' : 'Plain'))) : null;

  let armed = 0;
  const del = h('button', { type: 'button', class: 'act danger', title: 'Delete (#)', onclick: async () => {
    if (!armed) { armed = window.setTimeout(() => { armed = 0; del.textContent = 'Delete'; }, 3000); del.textContent = 'Click to confirm'; return; }
    await remove(id);
  } }, 'Delete');

  readerEl.replaceChildren(h('article', { class: 'msg' },
    h('div', { class: 'msg-bar' },
      h('button', { type: 'button', class: 'act back', onclick: close, 'aria-label': 'Back to inbox' }, '← Inbox'),
      h('span', { class: 'grow' }), toggle,
      h('button', { type: 'button', class: 'act', title: 'Mark unread (u)', onclick: () => markUnread(id) }, 'Mark unread'), del),
    h('h1', { class: 'msg-subj', tabindex: '-1' }, m.subject || '(no subject)'),
    h('div', { class: 'msg-meta' }, avatar(m),
      h('div', { class: 'who' }, h('b', {}, who(m)), m.from_name ? h('span', { class: 'addr' }, ` <${m.from_addr}>`) : null,
        h('div', { class: 'to' }, `to ${m.envelope_to}`, m.envelope_from.toLowerCase() !== m.from_addr.toLowerCase() ? ` · via ${m.envelope_from}` : '')),
      h('time', {}, when(m.received_at, true))),
    ...(m.attachments.length ? [h('ul', { class: 'atts', 'aria-label': 'Attachments' }, ...m.attachments.map(a => h('li', { title: 'Attachments are listed but not stored' }, h('span', { 'aria-hidden': 'true' }, '⎘ '), a.filename, h('small', {}, size(a.size)))))] : []),
    body));
  draw();
  (readerEl.querySelector('.msg-subj') as HTMLElement).focus({ preventScroll: true });
}

function close() {
  openId = ''; document.body.classList.remove('reading');
  readerEl.replaceChildren(h('div', { class: 'blank' }, h('span', { class: 'big', 'aria-hidden': 'true' }, '✉'), h('b', {}, 'Nothing selected'), h('span', {}, 'Pick a message, or use j and k to move through the list.')));
  renderList();
}
function setRead(id: string, read: number) { const m = all.find(x => x.id === id); if (m) m.read = read; renderBoxes(); renderList(); }

async function markUnread(id: string) {
  try { await raw(`/mail/${id}/unread`, { method: 'POST' }); setRead(id, 0); close(); flash('Marked as unread'); }
  catch (e) { flash((e as Error).message, 'err'); }
}
async function remove(id: string) {
  const i = shown.findIndex(m => m.id === id);
  try { await raw(`/mail/${id}`, { method: 'DELETE' }); } catch (e) { flash((e as Error).message, 'err'); return; }
  all = all.filter(m => m.id !== id); renderBoxes(); renderList(); flash('Deleted');
  const next = shown[Math.min(i, shown.length - 1)];
  next && innerWidth > 860 ? open(next.id) : close();
}

// --- keyboard: j/k move, u unread, # delete, / search, Esc back ---
addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (t.matches('input, textarea')) { if (e.key === 'Escape') { search.value = ''; query = ''; renderList(); search.blur(); } return; }
  const i = shown.findIndex(m => m.id === openId);
  if (e.key === 'j' || e.key === 'k') { const n = shown[Math.max(0, Math.min(shown.length - 1, i + (e.key === 'j' ? 1 : -1)))]; if (n) open(n.id); }
  else if (e.key === '/') search.focus();
  else if (e.key === 'u' && openId) markUnread(openId);
  else if (e.key === '#' && openId) remove(openId);
  else if (e.key === 'Escape' && openId) close();
  else return;
  e.preventDefault();
});

search.addEventListener('input', () => { query = search.value.trim(); renderList(); });
$('refresh').addEventListener('click', async () => { await load(); flash('Up to date'); });
fetch('/api/me', { credentials: 'same-origin', redirect: 'manual' }).then(r => r.ok ? r.json() : null)
  .then(me => { $('me').textContent = me?.email ?? 'Session expired. Reload to sign in.'; }).catch(() => {});

close();
load();
setInterval(() => document.visibilityState === 'visible' && load(true), 30_000);
addEventListener('focus', () => load(true));
