// Full SFTP over the SSH tunnel: browse, upload (files and folders), download, edit, rename,
// new folder and delete. The server's own permissions decide what is allowed.
import { h, fmt, viewHeader, errorBox, subnav, segmented, download, isSensitive, type Cleanup } from './lib';
import { connection, TITLE, type Target } from './hosts';
import { Sftp, isDir, isLink, type Entry } from './sftp';

const EDIT_LIMIT = 1024 * 1024;
const sessions = new Map<Target, Sftp>();
const lastPath = new Map<Target, string>();

async function sftpFor(target: Target) {
  const s = sessions.get(target);
  if (s && !s.closed) return s;
  const fresh = await Sftp.open(await connection(target));
  sessions.set(target, fresh);
  return fresh;
}

const join = (dir: string, name: string) => dir === '/' ? `/${name}` : `${dir}/${name}`;
const parent = (p: string) => p.replace(/\/[^/]+\/?$/, '') || '/';
const validName = (n: string) => !!n && n !== '.' && n !== '..' && !n.includes('/') && !n.includes('\0');
const perms = (m = 0) => [256, 128, 64, 32, 16, 8, 4, 2, 1].map((b, i) => m & b ? 'rwx'[i % 3] : '-').join('');

export function mount(root: HTMLElement): Cleanup {
  let target: Target = (sessionStorage.getItem('nexus.target') as Target) || 'debian';
  if (target !== 'debian' && target !== 'nixos') target = 'debian';
  let dir = '';
  let entries: Entry[] = [];
  let ticket = 0;
  let stopped = false;
  const transfers = new Set<AbortController>();

  root.append(viewHeader('Files', 'SFTP on your servers. Changes are real: the server’s permissions apply, and deletes cannot be undone.',
    subnav([['devices', 'Devices'], ['terminal', 'Terminal'], ['files', 'Files']], 'files')));

  const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Folder' });
  const filter = h('input', { type: 'search', placeholder: 'Filter', 'aria-label': 'Filter this folder' });
  const hidden = h('input', { type: 'checkbox', id: 'files-hidden' });
  const listEl = h('div', { class: 'file-list', role: 'list' });
  const pickFiles = h('input', { type: 'file', multiple: true, hidden: true });
  const pickDir = h('input', { type: 'file', hidden: true, webkitdirectory: true });
  const queue = h('div', { class: 'transfers', 'aria-live': 'polite' });
  const viewer = h('section', { class: 'card viewer' }, h('div', { class: 'empty' }, h('h2', {}, 'Pick a file'), h('p', {}, 'Text files up to 1 MB open here for editing. Anything else can be downloaded.')));

  const toolbar = h('div', { class: 'file-tools' },
    segmented<Target>('Host', [['debian', 'Debian'], ['nixos', 'NixOS']], target, v => { target = v; sessionStorage.setItem('nexus.target', v); dir = lastPath.get(v) ?? ''; open(dir); }),
    h('button', { type: 'button', class: 'btn small', title: 'Parent folder', 'aria-label': 'Parent folder', onclick: () => open(parent(dir)) }, '↑'),
    h('button', { type: 'button', class: 'btn small', title: 'Refresh', 'aria-label': 'Refresh', onclick: () => open(dir) }, '↻'),
    h('button', { type: 'button', class: 'btn small', onclick: newFolder }, '+ Folder'),
    h('button', { type: 'button', class: 'btn small', onclick: () => pickFiles.click() }, '⇡ Upload'),
    h('button', { type: 'button', class: 'btn small', onclick: () => pickDir.click() }, '⇡ Folder'),
    pickFiles, pickDir);

  const browser = h('section', { class: 'card browser' }, toolbar, crumbs,
    h('div', { class: 'row' }, filter, h('label', { class: 'check inline', for: 'files-hidden' }, hidden, 'Hidden files')), listEl, queue);
  root.append(h('div', { class: 'files' }, browser, viewer));

  function renderCrumbs() {
    const parts = dir.split('/').filter(Boolean);
    crumbs.replaceChildren(h('button', { type: 'button', onclick: () => open('/') }, `${TITLE[target]}:/`),
      ...parts.flatMap((p, i) => [h('button', { type: 'button', onclick: () => open('/' + parts.slice(0, i + 1).join('/')) }, p), h('span', {}, '/')]));
  }

  function renderList() {
    const q = filter.value.trim().toLowerCase();
    const shown = entries.filter(e => (hidden.checked || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)))
      .sort((a, b) => Number(isDir(b.attrs)) - Number(isDir(a.attrs)) || a.name.localeCompare(b.name));
    listEl.replaceChildren(...(shown.length ? shown.slice(0, 1000).map(e => {
      const path = join(dir, e.name), folder = isDir(e.attrs);
      return h('div', { class: `file-row${folder ? ' dir' : ''}`, role: 'listitem' },
        h('button', { type: 'button', class: 'file-name', onclick: () => folder ? open(path) : view(path, e) },
          h('span', { class: 'ico', 'aria-hidden': 'true' }, folder ? '▸' : isLink(e.attrs) ? '↪' : '·'), e.name),
        h('small', { class: 'mono' }, folder ? '' : fmt.bytes(e.attrs.size)),
        h('small', { class: 'mono hide-narrow', title: perms(e.attrs.mode) }, e.attrs.mtime ? fmt.date(e.attrs.mtime) : ''),
        h('span', { class: 'row-actions' },
          folder ? null : h('button', { type: 'button', class: 'icon-b', title: `Download ${e.name}`, 'aria-label': `Download ${e.name}`, onclick: () => get(path, e) }, '⇣'),
          h('button', { type: 'button', class: 'icon-b', title: `Rename ${e.name}`, 'aria-label': `Rename ${e.name}`, onclick: () => rename(path, e.name) }, '✎'),
          h('button', { type: 'button', class: 'icon-b danger', title: `Delete ${e.name}`, 'aria-label': `Delete ${e.name}`, onclick: () => remove(path, folder) }, '✕')));
    }) : [h('p', { class: 'muted pad' }, q ? 'No matches.' : 'Empty folder.')]));
  }

  async function open(path: string) {
    const t = ++ticket;
    listEl.replaceChildren(h('p', { class: 'muted pad shimmer' }, 'Loading…'));
    try {
      const s = await sftpFor(target);
      const real = await s.realpath(path || '.');
      const list = await s.list(real);
      if (t !== ticket || stopped) return;
      dir = real; entries = list; lastPath.set(target, dir);
      renderCrumbs(); renderList();
    } catch (e) { if (t === ticket) { renderCrumbs(); listEl.replaceChildren(errorBox(e)); } }
  }

  function transfer(label: string) {
    const ac = new AbortController();
    const bar = h('i', {});
    const text = h('small', {}, 'Starting…');
    const row = h('div', { class: 'transfer' }, h('b', {}, label), h('span', { class: 'bar' }, bar), text,
      h('button', { type: 'button', class: 'icon-b', 'aria-label': `Cancel ${label}`, onclick: () => ac.abort() }, '✕'));
    queue.append(row); transfers.add(ac);
    return {
      signal: ac.signal,
      progress: (done: number, total: number) => { bar.style.width = `${total ? done / total * 100 : 100}%`; text.textContent = `${fmt.bytes(done)} of ${fmt.bytes(total)}`; },
      end: (msg: string, ok = true) => {
        transfers.delete(ac); text.textContent = msg; row.classList.add(ok ? 'done' : 'failed');
        row.querySelector('button')?.remove();
        setTimeout(() => row.remove(), ok ? 2500 : 8000);
      },
    };
  }

  async function get(path: string, e: Entry) {
    const t = transfer(`⇣ ${e.name}`);
    try {
      const data = await (await sftpFor(target)).read(path, t.progress, t.signal);
      download(e.name, data); t.end('Downloaded');
    } catch (err) { t.end(t.signal.aborted ? 'Cancelled' : (err as Error).message, false); }
  }

  async function upload(files: File[], relative = false) {
    const s = await sftpFor(target).catch(e => { queue.append(errorBox(e)); return null; });
    if (!s) return;
    const base = dir;
    const made = new Set<string>();
    let replaceAll: boolean | null = null;
    for (const f of files) {
      const rel = relative && f.webkitRelativePath ? f.webkitRelativePath : f.name;
      const parts = rel.split('/').filter(validName);
      if (!parts.length) continue;
      let folder = base;
      for (const p of parts.slice(0, -1)) {
        folder = join(folder, p);
        if (!made.has(folder)) { made.add(folder); if (!await s.exists(folder)) await s.mkdir(folder).catch(() => {}); }
      }
      const path = join(folder, parts.at(-1)!);
      if (await s.exists(path)) {
        const replace: boolean = replaceAll ?? confirm(`${path} already exists on ${TITLE[target]}.\n\nOK replaces it. Cancel skips it.`);
        if (files.length > 1 && replaceAll === null && confirm('Use the same answer for every other conflict in this upload?')) replaceAll = replace;
        if (!replace) continue;
      }
      const t = transfer(`⇡ ${rel}`);
      try { await s.write(path, f, { onProgress: t.progress, signal: t.signal }); t.end('Uploaded'); }
      catch (err) { t.end(t.signal.aborted ? 'Cancelled' : (err as Error).message, false); if (t.signal.aborted) await s.remove(path).catch(() => {}); }
    }
    if (dir === base) open(dir);
  }

  async function newFolder() {
    const name = prompt('New folder name')?.trim();
    if (!name) return;
    if (!validName(name)) { listEl.prepend(errorBox('That name is not valid.')); return; }
    try { await (await sftpFor(target)).mkdir(join(dir, name)); open(dir); } catch (e) { listEl.prepend(errorBox(e)); }
  }

  async function rename(path: string, name: string) {
    const next = prompt(`Rename ${name} to`, name)?.trim();
    if (!next || next === name) return;
    if (!validName(next)) { listEl.prepend(errorBox('That name is not valid.')); return; }
    try {
      const s = await sftpFor(target);
      const to = join(parent(path), next);
      if (await s.exists(to)) {
        if (!confirm(`${next} already exists. Replace it?`)) return;
        await s.remove(to); // SFTP v3 rename refuses to overwrite
      }
      await s.rename(path, to); open(dir);
    } catch (e) { listEl.prepend(errorBox(e)); }
  }

  async function remove(path: string, folder: boolean) {
    if (!confirm(`Delete ${path} on ${TITLE[target]}${folder ? ' and everything inside it' : ''}?\n\nThis cannot be undone.`)) return;
    const t = transfer(`✕ ${path.split('/').pop()}`);
    let n = 0;
    try { await (await sftpFor(target)).removeTree(path, () => { n++; t.progress(n, n); }); t.end(`Deleted ${n} item${n === 1 ? '' : 's'}`); open(dir); }
    catch (e) { t.end((e as Error).message, false); open(dir); }
  }

  async function view(path: string, e: Entry) {
    const size = e.attrs.size ?? 0;
    const name = path.split('/').pop()!;
    const head = (extra: Node[] = []) => h('header', { class: 'viewer-h' },
      h('div', {}, h('b', {}, path), h('small', { class: 'muted' }, `${fmt.bytes(size)} · ${perms(e.attrs.mode)} · ${TITLE[target]}`)),
      h('div', { class: 'viewer-tools' }, ...extra, h('button', { type: 'button', class: 'btn small', onclick: () => get(path, e) }, '⇣ Download')));
    if (size > EDIT_LIMIT) { viewer.replaceChildren(head(), h('div', { class: 'empty' }, h('p', {}, 'Too large to open here. Download it instead.'))); return; }
    viewer.replaceChildren(h('p', { class: 'muted pad shimmer' }, `Opening ${name}…`));
    try {
      const data = await (await sftpFor(target)).read(path);
      if (data.subarray(0, 8000).includes(0)) { viewer.replaceChildren(head(), h('div', { class: 'empty' }, h('p', {}, 'Binary file. Download it instead.'))); return; }
      const text = new TextDecoder().decode(data);
      const area = h('textarea', { class: 'editor', spellcheck: 'false', 'aria-label': `Contents of ${name}` });
      area.value = text;
      const state = h('small', { class: 'muted', 'aria-live': 'polite' }, '');
      const saveBtn = h('button', { type: 'button', class: 'btn primary small', disabled: true }, 'Save');
      area.addEventListener('input', () => { saveBtn.disabled = area.value === text; state.textContent = area.value === text ? '' : 'Unsaved changes'; });
      area.addEventListener('keydown', ev => { if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') { ev.preventDefault(); if (!saveBtn.disabled) saveBtn.click(); } });
      saveBtn.addEventListener('click', async () => {
        saveBtn.disabled = true; state.textContent = 'Saving…';
        try {
          const bytes = new TextEncoder().encode(area.value);
          await (await sftpFor(target)).write(path, bytes);
          view(path, { ...e, attrs: { ...e.attrs, size: bytes.length } });
          open(dir);
        } catch (err) { state.textContent = (err as Error).message; saveBtn.disabled = false; }
      });
      const sensitive = isSensitive(path);
      const ask = h('button', {
        type: 'button', class: 'btn small', disabled: sensitive,
        title: sensitive ? 'Files that usually hold secrets are never sent to an AI.' : 'Open AI chat with this file attached',
        onclick: () => { sessionStorage.setItem('nexus.attach', JSON.stringify({ label: `${target}:${path}`, text: area.value.slice(0, 100_000) })); location.hash = '#chat'; },
      }, sensitive ? 'Holds secrets' : '✦ Ask AI');
      viewer.replaceChildren(head([state, ask, saveBtn]), area);
    } catch (err) { viewer.replaceChildren(errorBox(err)); }
  }

  pickFiles.addEventListener('change', () => { upload([...pickFiles.files ?? []]); pickFiles.value = ''; });
  pickDir.addEventListener('change', () => { upload([...pickDir.files ?? []], true); pickDir.value = ''; });
  browser.addEventListener('dragover', e => { e.preventDefault(); browser.classList.add('drop'); });
  browser.addEventListener('dragleave', () => browser.classList.remove('drop'));
  browser.addEventListener('drop', e => { e.preventDefault(); browser.classList.remove('drop'); upload([...e.dataTransfer?.files ?? []]); });
  filter.addEventListener('input', renderList);
  hidden.addEventListener('change', renderList);
  renderCrumbs();
  open(lastPath.get(target) ?? '');
  return () => { stopped = true; ticket++; transfers.forEach(t => t.abort()); };
}
