// Nexus Mail (mail.<domain>): a Gmail-style client for the mailbox on the owner's Debian box.
// Mail content is rendered with textContent / attributes only. HTML bodies go into a sandboxed
// iframe without scripts; the page CSP (inherited by srcdoc) blocks remote images and trackers.
import { h, safeUrl } from '../app/lib';
import { call, icon, toast, size, when, type Addr } from './shared';
import { compose, setupComposer, addrList } from './compose';

type Thread = {
  thread_id: string; id: string; folder: string; received_at: number; subject: string; from_addr: string; from_name: string;
  to: Addr[]; people: string[]; snippet: string; count: number; unread: boolean; starred: boolean; has_attachments: boolean;
};
type Message = {
  id: string; thread_id: string; folder: string; received_at: number; subject: string; from_addr: string; from_name: string;
  to: Addr[]; cc: Addr[]; bcc: Addr[]; reply_to: string; envelope_to: string; message_id: string; text: string; html: string;
  attachments: { filename: string; type: string; size: number }[]; starred: boolean; read: boolean; reply_of: string; forward_of: string;
  sender_auth: string;
};

const FOLDERS: [string, string, string][] = [
  ['inbox', 'Inbox', 'inbox'], ['starred', 'Starred', 'star'], ['sent', 'Sent', 'send'],
  ['drafts', 'Drafts', 'draft'], ['all', 'All mail', 'all'], ['trash', 'Trash', 'trash'],
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAGE = 50;
const $ = (id: string) => document.getElementById(id)!;
const main = $('main'), folderNav = $('folders'), searchInput = $('search') as HTMLInputElement;

let config = { from: [] as string[], name: '', sending: false };
let mine = new Set<string>();
let view = { folder: 'inbox', q: '', thread: '' };
let offset = 0, threads: Thread[] = [], counts = { inbox: 0, drafts: 0 }, focusIndex = -1;
let current: Message[] = [];
let loadToken = 0;

// ---------- routing: #/inbox, #/sent/<thread>, #/search/<query>[/<thread>] ----------
function parse() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const folder = parts[0] === 'search' ? 'search' : FOLDERS.some(f => f[0] === parts[0]) ? parts[0] : 'inbox';
  const q = folder === 'search' ? decodeURIComponent(parts[1] ?? '') : '';
  const last = parts.at(-1) ?? '';
  return { folder, q, thread: UUID.test(last) ? last : '' };
}
const base = () => view.folder === 'search' ? `#/search/${encodeURIComponent(view.q)}` : `#/${view.folder}`;
const go = (hash: string) => { if (location.hash !== hash) location.hash = hash; else route(); };

function route() {
  const next = parse();
  if (next.folder !== view.folder || next.q !== view.q) { offset = 0; focusIndex = -1; }
  view = next;
  searchInput.value = view.q;
  document.body.classList.remove('drawer');
  drawFolders();
  view.thread ? openThread(view.thread) : loadList();
}

// ---------- rail ----------
function drawFolders() {
  folderNav.replaceChildren(...FOLDERS.map(([id, label, ic]) => {
    const n = id === 'inbox' ? counts.inbox : id === 'drafts' ? counts.drafts : 0;
    return h('a', { href: `#/${id}`, class: `folder${n && id === 'inbox' ? ' has-unread' : ''}`, 'aria-current': view.folder === id ? 'page' : null },
      icon(ic), h('span', { class: 'fl' }, label), n ? h('span', { class: 'fc' }, n) : null);
  }));
  const title = view.folder === 'search' ? 'Search' : FOLDERS.find(f => f[0] === view.folder)?.[1] ?? 'Inbox';
  document.title = `${counts.inbox ? `(${counts.inbox}) ` : ''}${title} · Nexus Mail`;
}

// ---------- list ----------
function who(t: Thread) {
  if (view.folder === 'drafts' || t.folder === 'drafts') return [h('span', { class: 'draft-l' }, 'Draft'), ' ', t.to.map(a => a.name || a.address).join(', ')];
  if (view.folder === 'sent') return `To: ${t.to.map(a => a.name || a.address).join(', ') || '(no recipients)'}`;
  return `${t.people.join(', ')}${t.count > 1 ? ` (${t.count})` : ''}`;
}

async function act(tid: string, action: string, done?: string, undo?: string) {
  try {
    await call(`/threads/${tid}/${action}`, { method: 'POST' });
    if (done) toast(done, undo ? { label: 'Undo', run: async () => { await call(`/threads/${tid}/${undo}`, { method: 'POST' }).catch(() => {}); refresh(); } } : undefined);
  } catch (e) {
    toast((e as Error).message, undefined, 'err');
  }
}
const ARCHIVE = ['archive', 'Conversation archived', 'inbox'] as const;
const TRASH = ['trash', 'Conversation moved to Trash', 'untrash'] as const;
const RESTORE = ['untrash', 'Conversation restored', 'trash'] as const;

function rowActions(t: Thread) {
  const btn = (name: string, title: string, run: () => void) => h('button', { type: 'button', class: 'ic', title, onclick: (e: Event) => { e.stopPropagation(); run(); } }, icon(name));
  if (view.folder === 'drafts') return [btn('trash', 'Discard draft', async () => { await call(`/drafts/${t.id}`, { method: 'DELETE' }).catch(() => {}); toast('Draft discarded'); refresh(); })];
  const out = [];
  if (t.folder === 'inbox') out.push(btn('archive', 'Archive (e)', async () => { await act(t.thread_id, ...ARCHIVE); refresh(); }));
  if (view.folder === 'trash') out.push(btn('restore', 'Restore', async () => { await act(t.thread_id, ...RESTORE); refresh(); }));
  else out.push(btn('trash', 'Delete (#)', async () => { await act(t.thread_id, ...TRASH); refresh(); }));
  out.push(btn('unread', t.unread ? 'Mark as read' : 'Mark as unread', async () => { await act(t.thread_id, t.unread ? 'read' : 'unread'); refresh(); }));
  return out;
}

function row(t: Thread, i: number) {
  const star = h('button', { type: 'button', class: `star${t.starred ? ' on' : ''}`, 'aria-pressed': String(t.starred), title: t.starred ? 'Starred' : 'Not starred',
    onclick: async (e: Event) => { e.stopPropagation(); t.starred = !t.starred; star.classList.toggle('on', t.starred); star.replaceChildren(icon('star', t.starred)); await act(t.thread_id, t.starred ? 'star' : 'unstar'); } },
    icon('star', t.starred));
  const open = () => view.folder === 'drafts' ? openDraft(t.id) : go(`${base()}/${t.thread_id}`);
  return h('li', {}, h('div', {
    class: `row${t.unread ? ' unread' : ''}${i === focusIndex ? ' focus' : ''}`, role: 'link', tabindex: '0',
    onclick: open, onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') open(); }, onfocus: () => { focusIndex = i; },
  }, view.folder === 'drafts' ? h('span', { class: 'star-gap' }) : star,
    h('span', { class: 'who' }, who(t)),
    h('span', { class: 'line' }, h('span', { class: 'subj' }, t.subject || '(no subject)'), t.snippet ? h('span', { class: 'snip' }, ` — ${t.snippet}`) : null),
    h('span', { class: 'clip', title: t.has_attachments ? 'Has attachments' : null }, t.has_attachments ? icon('attach') : null),
    h('time', { datetime: new Date(t.received_at).toISOString() }, when(t.received_at)),
    h('span', { class: 'hover' }, ...rowActions(t))));
}

async function loadList(quiet = false) {
  const token = ++loadToken;
  const folder = view.folder === 'search' ? 'all' : view.folder;
  if (!quiet) main.replaceChildren(listShell(), h('div', { class: 'loading' }, 'Loading…'));
  try {
    const params = new URLSearchParams({ folder, offset: String(offset) });
    if (view.q) params.set('q', view.q);
    const res = await call<{ threads: Thread[]; more: boolean; total: number; counts: typeof counts }>(`/threads?${params}`);
    if (token !== loadToken || view.thread) return;
    threads = res.threads; counts = res.counts; drawFolders();
    if (focusIndex >= threads.length) focusIndex = threads.length - 1;
    main.replaceChildren(listShell(res.total, res.more), threads.length ? h('ul', { class: 'rows' }, ...threads.map(row)) : emptyState());
  } catch (e) {
    if (token !== loadToken) return;
    if (!quiet) main.replaceChildren(listShell(), problem(e as Error));
  }
}
const refresh = () => (view.thread ? openThread(view.thread, true) : loadList(true));

function listShell(total = 0, more = false) {
  const label = view.folder === 'search' ? `Results for “${view.q}”` : FOLDERS.find(f => f[0] === view.folder)?.[1] ?? '';
  return h('div', { class: 'bar' },
    h('h1', { class: 'bar-title' }, label),
    h('button', { type: 'button', class: 'ic', title: 'Refresh', onclick: () => loadList() }, icon('refresh')),
    ...(view.folder === 'trash' && total ? [h('span', { class: 'hint' }, 'Open a conversation here to delete it for good.')] : []),
    h('span', { class: 'grow' }),
    total ? h('span', { class: 'pager' }, `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}`,
      h('button', { type: 'button', class: 'ic', title: 'Newer', disabled: offset === 0, onclick: () => { offset = Math.max(0, offset - PAGE); loadList(); } }, icon('left')),
      h('button', { type: 'button', class: 'ic', title: 'Older', disabled: !more, onclick: () => { offset += PAGE; loadList(); } }, icon('right'))) : null);
}

function emptyState() {
  const text: Record<string, [string, string]> = {
    inbox: ['Your inbox is empty', 'New mail to your addresses lands here.'],
    starred: ['Nothing starred', 'Star a conversation to find it here quickly.'],
    sent: ['Nothing sent yet', 'Mail you send shows up here.'], drafts: ['No drafts', 'Unsent messages are saved here as you type.'],
    all: ['No mail yet', 'Everything except Trash shows up here.'], trash: ['Trash is empty', 'Deleted conversations wait here until you remove them for good.'],
    search: ['No matches', 'Try a name, an address, or a word from the subject or message.'],
  };
  const [title, sub] = text[view.folder] ?? text.inbox;
  return h('div', { class: 'empty' }, icon(FOLDERS.find(f => f[0] === view.folder)?.[2] ?? 'search'), h('b', {}, title), h('span', {}, sub));
}
const problem = (e: Error) => h('div', { class: 'empty err', role: 'alert' }, h('b', {}, 'Could not load your mail'), h('span', {}, e.message),
  h('button', { type: 'button', class: 'pill-btn', onclick: () => refresh() }, 'Try again'));

// ---------- conversation ----------
const plain = (html: string) => new DOMParser().parseFromString(html, 'text/html').body.textContent?.replace(/\n{3,}/g, '\n\n').trim() ?? '';
const nameOf = (m: Message) => m.folder === 'sent' ? 'me' : m.from_name || m.from_addr;
const hue = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
const avatar = (name: string, addr: string) => h('span', { class: 'av', style: `--h:${hue(addr.toLowerCase())}`, 'aria-hidden': 'true' }, (name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase());
const people = (list: Addr[]) => list.map(a => mine.has(a.address.toLowerCase()) ? 'me' : a.name || a.address).join(', ');

function linkify(text: string) {
  const out: (Node | string)[] = [];
  for (const part of text.split(/(https?:\/\/[^\s<>"')\]]+)/g)) {
    const url = /^https?:\/\//.test(part) ? safeUrl(part) : null;
    out.push(url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, part) : part);
  }
  return out;
}

function htmlFrame(html: string) {
  // Its own strict policy: no scripts, no remote images, fonts or styles (security review NEX-020).
  const doc = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'"><meta name="referrer" content="no-referrer"><base target="_blank">'
    + '<style>html{background:#fff;color:#1d2230;font:14.5px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}body{margin:18px 20px;overflow-wrap:anywhere}img{max-width:100%;height:auto}blockquote{margin:0 0 0 .6em;padding-left:.8em;border-left:3px solid #c9d4ea;color:#4a5468}</style>' + html;
  // No scripts and no same-origin access: mail can't run code or reach this page. Fixed height, drag to resize.
  return h('iframe', { class: 'html', title: 'Message', sandbox: 'allow-popups allow-popups-to-escape-sandbox', srcdoc: doc });
}

/** Web images a reader would actually see; the page CSP blocks them all, this only decides whether to say so. */
function hiddenImages(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html'); // inert: nothing loads
  return [...doc.querySelectorAll('img')].filter(img => {
    if (!/^\s*https?:/i.test(img.getAttribute('src') ?? '')) return false;
    const size = (a: string) => parseInt(img.getAttribute(a) ?? '', 10);
    const style = (img.getAttribute('style') ?? '').replace(/\s/g, '').toLowerCase();
    return !(size('width') <= 2 || size('height') <= 2 || /display:none|visibility:hidden|(?:^|;)(?:width|height):[0-2]px/.test(style));
  }).length;
}

function parseAddr(raw: string): Addr | null {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/) ?? raw.match(/^\s*()([^\s<>]+@[^\s<>]+)\s*$/);
  return m ? { name: m[1].trim(), address: m[2].trim() } : null;
}
const reSubject = (s: string, p: 'Re' | 'Fwd') => new RegExp(`^${p}:`, 'i').test(s.trim()) ? s : `${p}: ${s}`;
const fromFor = (m: Message) => [m.envelope_to, ...m.to.map(a => a.address), ...m.cc.map(a => a.address)].map(a => a.toLowerCase()).find(a => config.from.includes(a));
const bodyText = (m: Message) => m.text || plain(m.html);

function reply(m: Message, all: boolean) {
  const sentByMe = m.folder === 'sent';
  const to = sentByMe ? m.to : [parseAddr(m.reply_to) ?? { name: m.from_name, address: m.from_addr }];
  const seen = new Set(to.map(a => a.address.toLowerCase()));
  const cc = all ? [...(sentByMe ? [] : m.to), ...m.cc].filter(a => {
    const k = a.address.toLowerCase();
    if (mine.has(k) || seen.has(k)) return false;
    seen.add(k); return true;
  }) : [];
  const quoted = bodyText(m).split('\n').map(l => `> ${l}`).join('\n');
  const subject = reSubject(m.subject, 'Re');
  compose({
    to: addrList(to), cc: addrList(cc), subject, replyOf: m.id, title: subject, focusBody: true, from: fromFor(m),
    text: `\n\nOn ${when(m.received_at, true)}, ${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr} wrote:\n${quoted}\n`,
  });
}

function forward(m: Message) {
  const subject = reSubject(m.subject, 'Fwd');
  const head = ['---------- Forwarded message ---------', `From: ${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr}`,
    `Date: ${when(m.received_at, true)}`, `Subject: ${m.subject}`, `To: ${addrList(m.to).join(', ')}`, ...(m.cc.length ? [`Cc: ${addrList(m.cc).join(', ')}`] : [])];
  compose({ subject, title: subject, forwardOf: m.id, forwardFiles: m.attachments, from: fromFor(m), text: `\n\n${head.join('\n')}\n\n${bodyText(m)}\n` });
}

function messageCard(m: Message, open: boolean, last: boolean) {
  const card = h('article', { class: `msg${open ? ' open' : ''}` });
  const draw = () => {
    const header = h('header', { class: 'msg-h', onclick: (e: Event) => { if (!last && !(e.target as Element).closest('button, a')) { open = !open; card.classList.toggle('open', open); draw(); } } },
      avatar(nameOf(m) === 'me' ? (config.name || m.from_addr) : nameOf(m), m.from_addr),
      h('div', { class: 'msg-who' },
        h('div', {}, h('b', {}, nameOf(m) === 'me' ? (config.name || 'me') : nameOf(m)), open ? h('span', { class: 'addr' }, ` <${m.from_addr}>`) : null),
        open ? h('div', { class: 'msg-to' }, `to ${people(m.to) || 'undisclosed recipients'}`, m.cc.length ? `, cc ${people(m.cc)}` : '', m.bcc.length ? `, bcc ${people(m.bcc)}` : '')
          : h('div', { class: 'msg-snip' }, bodyText(m).replace(/\s+/g, ' ').slice(0, 140))),
      h('time', { title: when(m.received_at, true) }, when(m.received_at)),
      ...(open ? [h('span', { class: 'msg-acts' },
        h('button', { type: 'button', class: 'ic', title: 'Reply', onclick: () => reply(m, false) }, icon('reply')),
        h('button', { type: 'button', class: 'ic', title: 'Forward', onclick: () => forward(m) }, icon('forward')))] : []));
    const remote = m.html ? hiddenImages(m.html) : 0;
    const unverified = m.folder !== 'sent' && m.sender_auth !== 'pass';
    card.replaceChildren(header, ...(open ? [
      ...(unverified ? [h('p', { class: 'unverified', role: 'note' }, h('b', {}, 'Unverified sender. '),
        `This message couldn't be confirmed as really coming from ${m.from_addr}. Be careful with links, attachments and requests for money or codes.`)] : []),
      ...(remote ? [h('p', { class: 'note' }, `${remote} image${remote > 1 ? 's' : ''} from the web ${remote > 1 ? 'are' : 'is'} hidden so the sender cannot tell when you open this.`)] : []),
      h('div', { class: 'msg-body' }, m.html ? htmlFrame(m.html) : h('div', { class: 'text' }, ...linkify(m.text || '(no message text)'))),
      ...(m.attachments.length ? [h('div', { class: 'atts' }, ...m.attachments.map((a, i) => h('a', {
        class: 'att', href: `/api/mail/messages/${m.id}/attachments/${i}`, download: a.filename, title: `Download ${a.filename}`,
      }, h('span', { class: 'att-i' }, icon('attach')), h('span', { class: 'att-n' }, a.filename), h('small', {}, size(a.size)), icon('download'))))] : []),
    ] : []));
  };
  draw();
  return card;
}

async function openThread(tid: string, quiet = false) {
  const token = ++loadToken;
  if (!quiet) main.replaceChildren(h('div', { class: 'loading' }, 'Opening…'));
  let data: { messages: Message[] };
  try { data = await call(`/threads/${tid}`); } catch (e) {
    if (token !== loadToken) return;
    if ((e as { status?: number }).status === 404) { toast('That conversation no longer exists.', undefined, 'err'); go(base()); return; }
    main.replaceChildren(problem(e as Error)); return;
  }
  if (token !== loadToken) return;
  const inTrash = view.folder === 'trash';
  let msgs = data.messages.filter(m => inTrash ? m.folder === 'trash' : m.folder !== 'trash');
  if (!msgs.length) msgs = data.messages;
  current = msgs;
  if (msgs.some(m => !m.read)) {
    call(`/threads/${tid}/read`, { method: 'POST' }).then(() => { if (msgs.some(m => m.folder === 'inbox')) counts.inbox = Math.max(0, counts.inbox - 1); drawFolders(); }).catch(() => {});
  }

  const latest = msgs.at(-1)!;
  const starred = msgs.some(m => m.starred);
  const where = new Set(msgs.map(m => m.folder));
  const leave = async (args: readonly [string, string, string]) => { await act(tid, ...args); go(base()); };
  const tool = (name: string, title: string, run: () => void, filled = false) => h('button', { type: 'button', class: 'ic', title, onclick: run }, icon(name, filled));
  const others = [...latest.to, ...latest.cc].filter(a => !mine.has(a.address.toLowerCase())).length + (latest.folder === 'sent' ? 0 : 1);

  main.replaceChildren(
    h('div', { class: 'bar' },
      tool('back', 'Back (u)', () => go(base())),
      ...(where.has('inbox') ? [tool('archive', 'Archive (e)', () => leave(ARCHIVE))] : where.has('archive') ? [tool('inbox', 'Move to Inbox', () => leave(['inbox', 'Moved to Inbox', 'archive']))] : []),
      ...(inTrash ? [tool('restore', 'Restore', () => leave(RESTORE)), h('button', { type: 'button', class: 'pill-btn danger', onclick: () => deleteForever(tid) }, icon('forever'), h('span', {}, 'Delete forever'))]
        : [tool('trash', 'Delete (#)', () => leave(TRASH))]),
      tool('unread', 'Mark as unread', async () => { await act(tid, 'unread'); go(base()); }),
      tool('star', starred ? 'Starred (s)' : 'Star (s)', async () => { await act(tid, starred ? 'unstar' : 'star'); refresh(); }, starred),
      h('span', { class: 'grow' })),
    h('div', { class: 'conv' },
      h('h1', { class: 'conv-subj', tabindex: '-1' }, latest.subject || '(no subject)',
        ...[...where].filter(f => f !== 'trash' || inTrash).map(f => h('span', { class: 'label' }, FOLDERS.find(x => x[0] === f)?.[1] ?? 'Archived'))),
      ...msgs.map((m, i) => messageCard(m, i === msgs.length - 1 || !m.read, i === msgs.length - 1)),
      h('div', { class: 'conv-reply' },
        h('button', { type: 'button', class: 'pill-btn', onclick: () => reply(latest, false) }, icon('reply'), 'Reply'),
        others > 1 ? h('button', { type: 'button', class: 'pill-btn', onclick: () => reply(latest, true) }, icon('replyAll'), 'Reply all') : null,
        h('button', { type: 'button', class: 'pill-btn', onclick: () => forward(latest) }, icon('forward'), 'Forward'))));
  if (!quiet) (main.querySelector('.conv-subj') as HTMLElement).focus({ preventScroll: true });
}

async function deleteForever(tid: string) {
  const btn = main.querySelector<HTMLButtonElement>('.pill-btn.danger');
  if (btn && !btn.dataset.armed) { btn.dataset.armed = '1'; btn.querySelector('span')!.textContent = 'Click again to delete forever'; return; }
  await act(tid, 'delete', 'Conversation deleted forever');
  go(base());
}

async function openDraft(id: string) {
  try {
    const d = await call<Message>(`/drafts/${id}`);
    compose({ id, from: d.from_addr, to: addrList(d.to), cc: addrList(d.cc), bcc: addrList(d.bcc), subject: d.subject, text: d.text,
      replyOf: d.reply_of || undefined, forwardOf: d.forward_of || undefined, title: d.subject || 'Draft' });
  } catch (e) { toast((e as Error).message, undefined, 'err'); refresh(); }
}

// ---------- keyboard (Gmail's keys) ----------
addEventListener('keydown', e => {
  const t = e.target as HTMLElement;
  if (e.metaKey || e.ctrlKey || e.altKey || t.closest('input, textarea, select, .composer, [contenteditable]')) return;
  const rows = [...main.querySelectorAll<HTMLElement>('.row')];
  const key = e.key;
  const press = (scope: ParentNode | undefined, sel: string) => (scope?.querySelector(sel) as HTMLButtonElement | null)?.click();
  if (key === 'c') compose();
  else if (key === '/') searchInput.focus();
  else if (view.thread) {
    const latest = current.at(-1);
    const bar = main.querySelector('.bar') ?? undefined;
    if (key === 'u' || key === 'Escape') go(base());
    else if (key === 'e') press(bar, 'button[title^="Archive"]');
    else if (key === '#') press(bar, 'button[title^="Delete"]');
    else if (key === 's') press(bar, 'button[title^="Star"]');
    else if (latest && key === 'r') reply(latest, false);
    else if (latest && key === 'a') reply(latest, true);
    else if (latest && key === 'f') forward(latest);
    else return;
  } else if ((key === 'j' || key === 'k') && rows.length) {
    focusIndex = Math.max(0, Math.min(rows.length - 1, focusIndex + (key === 'j' ? 1 : -1)));
    rows.forEach((r, i) => r.classList.toggle('focus', i === focusIndex));
    rows[focusIndex].focus();
  } else if (key === 'o' && rows[focusIndex]) rows[focusIndex].click();
  else if (key === 'e') press(rows[focusIndex], 'button[title^="Archive"]');
  else if (key === '#') press(rows[focusIndex], 'button[title^="Delete"]');
  else if (key === 's') press(rows[focusIndex], '.star');
  else return;
  e.preventDefault();
});

// ---------- start ----------
$('search-form').addEventListener('submit', e => {
  e.preventDefault();
  const q = searchInput.value.trim();
  go(q ? `#/search/${encodeURIComponent(q)}` : '#/inbox');
});
for (const id of ['compose', 'fab']) $(id).addEventListener('click', () => compose());
$('compose').prepend(icon('pencil'));
$('fab').append(icon('pencil'));
$('menu').append(icon('menu'));
$('menu').addEventListener('click', () => document.body.classList.toggle('drawer'));
$('scrim').addEventListener('click', () => document.body.classList.remove('drawer'));
$('search-icon').append(icon('search'));
addEventListener('hashchange', route);

fetch('/api/me', { credentials: 'same-origin', redirect: 'manual' }).then(r => r.ok ? r.json() : null)
  .then(me => { $('me').textContent = me?.email ?? 'Session expired. Reload to sign in.'; }).catch(() => {});

async function boot() {
  try { config = await call('/config'); } catch { /* the list shows the connection problem */ }
  mine = new Set(config.from);
  setupComposer(config, tid => {
    toast('Message sent', { label: 'View message', run: () => go(`#/sent/${tid}`) });
    if (!view.thread || view.thread === tid) refresh();
  });
  call<{ contacts: Addr[] }>('/contacts').then(r => {
    $('contacts').replaceChildren(...r.contacts.map(c => h('option', { value: c.name ? `${c.name} <${c.address}>` : c.address })));
  }).catch(() => {});
  route();
}
boot();
setInterval(() => { if (document.visibilityState === 'visible' && !view.thread && !document.querySelector('.composer:not(.min)')) loadList(true); }, 30_000);
