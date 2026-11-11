import { api, h, fmt, pill, viewHeader, errorBox, isSensitive, type Cleanup } from './lib';

type Host = 'debian' | 'nixos';
type Workspace = { id: string; name: string; read_only?: boolean };
type Entry = { name: string; path: string; kind: string };

const isDir = (e: Entry) => /^dir/i.test(e.kind);
const validId = (id: string) => /^[a-z][a-z0-9_-]{0,31}$/.test(id);

export function mount(root: HTMLElement): Cleanup {
  let host: Host = 'debian';
  let ws: Workspace | null = null;
  let dir = '';
  let entries: Entry[] = [];
  let stale = 0;

  const hostBtns = (['debian', 'nixos'] as Host[]).map(id => h('button', {
    type: 'button', class: 'seg-b', 'aria-pressed': String(id === host),
    onclick: () => { host = id; ws = null; dir = ''; hostBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.h === id))); loadWorkspaces(); },
  }, id === 'debian' ? 'Debian' : 'NixOS'));
  hostBtns.forEach((b, i) => { b.dataset.h = i ? 'nixos' : 'debian'; });

  root.append(viewHeader('Files', 'Browse workspaces on your servers. Everything here is read-only; edit in Nexus Desktop.',
    h('div', { class: 'seg', role: 'group', 'aria-label': 'Host' }, ...hostBtns)));

  const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Folder' });
  const filter = h('input', { type: 'search', id: 'files-filter', placeholder: 'Filter this folder', 'aria-label': 'Filter this folder' });
  const listEl = h('ul', { class: 'tree' });
  const viewer = h('section', { class: 'card viewer' }, h('div', { class: 'empty' }, h('h2', {}, 'Pick a file'), h('p', {}, 'Files open here with line numbers. Up to 100 KB is shown.')));
  root.append(h('div', { class: 'files' }, h('section', { class: 'card browser' }, crumbs, filter, listEl), viewer));

  function renderCrumbs() {
    const parts = dir ? dir.split('/') : [];
    crumbs.replaceChildren(
      h('button', { type: 'button', onclick: () => { ws = null; dir = ''; loadWorkspaces(); } }, host === 'debian' ? 'Debian' : 'NixOS'),
      ...(ws ? [h('span', {}, '/'), h('button', { type: 'button', onclick: () => openDir('') }, ws.name)] : []),
      ...parts.flatMap((p, i) => [h('span', {}, '/'), h('button', { type: 'button', onclick: () => openDir(parts.slice(0, i + 1).join('/')) }, p)]));
  }

  function renderEntries() {
    const q = filter.value.trim().toLowerCase();
    const shown = entries.filter(e => !q || e.name.toLowerCase().includes(q))
      .sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name));
    listEl.replaceChildren(...(shown.length ? shown.map(e => h('li', {}, h('button', {
      type: 'button', class: isDir(e) ? 'dir' : 'file',
      onclick: () => isDir(e) ? openDir(e.path) : openFile(e.path),
    }, h('span', { class: 'ico', 'aria-hidden': 'true' }, isDir(e) ? '▸' : '·'), e.name))) : [h('li', { class: 'muted' }, q ? 'No matches.' : 'Empty folder.')]));
  }

  async function loadWorkspaces() {
    const ticket = ++stale;
    renderCrumbs(); filter.hidden = true;
    listEl.replaceChildren(h('li', { class: 'muted' }, 'Loading workspaces…'));
    try {
      const r = await api(`/v1/nexus/workspaces/${host}`);
      if (ticket !== stale) return;
      const list: Workspace[] = (Array.isArray(r?.workspaces) ? r.workspaces : []).filter((w: Workspace) => validId(String(w.id)));
      listEl.replaceChildren(...(list.length ? list.map(w => h('li', {}, h('button', {
        type: 'button', class: 'dir', onclick: () => { ws = w; openDir(''); },
      }, h('span', { class: 'ico', 'aria-hidden': 'true' }, '▣'), w.name, w.read_only !== false ? pill('read-only', 'ok') : null))) : [h('li', { class: 'muted' }, 'No workspaces are shared from this host.')]));
    } catch (e) { if (ticket === stale) listEl.replaceChildren(h('li', {}, errorBox(e))); }
  }

  async function openDir(path: string) {
    if (!ws) return;
    const ticket = ++stale;
    dir = path; renderCrumbs(); filter.hidden = false; filter.value = '';
    listEl.replaceChildren(h('li', { class: 'muted' }, 'Loading…'));
    try {
      const r = await api(`/v1/nexus/workspaces/${host}/${ws.id}/files?path=${encodeURIComponent(path)}`);
      if (ticket !== stale) return;
      entries = (Array.isArray(r?.entries) ? r.entries : []).slice(0, 250);
      renderEntries();
      if (r?.truncated) listEl.append(h('li', { class: 'muted' }, 'This folder has more entries than the gateway returns.'));
    } catch (e) { if (ticket === stale) listEl.replaceChildren(h('li', {}, errorBox(e))); }
  }

  async function openFile(path: string) {
    if (!ws) return;
    const w = ws;
    viewer.replaceChildren(h('p', { class: 'muted' }, `Opening ${path}…`));
    try {
      const r = await api(`/v1/nexus/workspaces/${host}/${w.id}/context?path=${encodeURIComponent(path)}`);
      const text = String(r?.text ?? '');
      const lines = text.split('\n');
      const find = h('input', { type: 'search', id: 'file-find', placeholder: 'Find in file', 'aria-label': 'Find in file' });
      const count = h('small', { class: 'muted' }, '');
      const code = h('ol', { class: 'code' }, ...lines.map(l => h('li', {}, h('code', {}, l || ' '))));
      find.addEventListener('input', () => {
        const q = find.value.toLowerCase();
        let n = 0, first: Element | null = null;
        code.querySelectorAll('li').forEach((li, i) => {
          const hit = !!q && lines[i].toLowerCase().includes(q);
          li.classList.toggle('hit', hit);
          if (hit) { n++; first ??= li; }
        });
        count.textContent = q ? `${n} line${n === 1 ? '' : 's'}` : '';
        first?.scrollIntoView({ block: 'center' });
      });
      const label = `${host}/${w.id}/${path}`;
      const sensitive = isSensitive(path);
      const ask = h('button', {
        type: 'button', class: 'btn', disabled: sensitive,
        title: sensitive ? 'Files that usually hold secrets are never sent to an AI.' : 'Open AI chat with this file attached',
        onclick: () => { sessionStorage.setItem('nexus.attach', JSON.stringify({ label, text: text.slice(0, 100_000) })); location.hash = '#chat'; },
      }, sensitive ? 'Holds secrets: not sent to AI' : 'Ask AI about this file');
      viewer.replaceChildren(
        h('header', { class: 'viewer-h' },
          h('div', {}, h('b', {}, path), h('small', { class: 'muted' }, `${fmt.bytes(r?.size_bytes)} · ${lines.length} lines · read-only`)),
          h('div', { class: 'viewer-tools' }, find, count, ask)),
        h('div', { class: 'code-wrap' }, code));
    } catch (e) { viewer.replaceChildren(errorBox(e)); }
  }

  filter.addEventListener('input', renderEntries);
  loadWorkspaces();
  return () => { stale++; };
}
