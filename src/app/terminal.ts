// Interactive PTY tabs over the SSH tunnel. Tabs outlive the view, so switching to AI and
// back keeps the session; they close with the connection (page hidden a minute, or unloaded).
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { h, viewHeader, errorBox, subnav, segmented, type Cleanup } from './lib';
import { connection, devices, TITLE, type Target } from './hosts';
import type { Channel } from './ssh';

type Tab = { id: number; target: Target; title: string; term: Terminal; fit: FitAddon; el: HTMLElement; ch: Channel | null; alive: boolean; busy?: boolean };
const tabs: Tab[] = [];
let active: Tab | null = null;
let nextId = 1;
let useTmux = false;

const THEME = {
  background: '#0A1020', foreground: '#E9EDF7', cursor: '#9CBCFF', selectionBackground: '#9CBCFF55',
  black: '#172137', red: '#FF93A2', green: '#7CE8CA', yellow: '#F1C07E', blue: '#9CBCFF', magenta: '#C9ADFF', cyan: '#8FE3F0', white: '#E9EDF7',
  brightBlack: '#6F7A92', brightRed: '#FFB3BE', brightGreen: '#A5F0DB', brightYellow: '#F6D5A5', brightBlue: '#BFD3FF', brightMagenta: '#DCCBFF', brightCyan: '#B5EEF6', brightWhite: '#FFFFFF',
};

async function attach(tab: Tab) {
  if (tab.busy) return;
  tab.busy = true;
  tab.term.writeln(`\x1b[38;2;111;122;146mConnecting to ${TITLE[tab.target]} through the Nexus relay…\x1b[0m`);
  try {
    const conn = await connection(tab.target);
    const ch = await conn.session();
    tab.ch = ch; tab.alive = true;
    ch.ondata = d => tab.term.write(d);
    ch.onstderr = d => tab.term.write(d);
    ch.onclose = () => { tab.alive = false; tab.ch = null; tab.term.writeln('\r\n\x1b[38;2;241;192;126m[session closed — press Enter to reconnect]\x1b[0m'); render(); };
    if (!await ch.pty(tab.term.cols, tab.term.rows)) throw new Error('The server refused a terminal.');
    if (!await ch.request('shell')) throw new Error('The server refused a shell.');
    if (useTmux) ch.write('tmux new-session -A -s nexus\r');
    render();
  } catch (e) {
    tab.term.writeln(`\r\n\x1b[38;2;255;147;162m${(e as Error).message}\x1b[0m\r\n\x1b[38;2;111;122;146mPress Enter to try again.\x1b[0m`);
  } finally { tab.busy = false; }
}

function newTab(target: Target) {
  const term = new Terminal({ theme: THEME, fontFamily: '"JetBrains Mono", ui-monospace, Consolas, monospace', fontSize: 13.5, cursorBlink: true, scrollback: 5000, allowProposedApi: false });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const el = h('div', { class: 'term-host' });
  const tab: Tab = { id: nextId++, target, title: `${TITLE[target]} ${tabs.filter(t => t.target === target).length + 1}`, term, fit, el, ch: null, alive: false };
  term.onData(d => { if (tab.ch) tab.ch.write(d); else if (d === '\r') attach(tab); });
  term.onResize(({ cols, rows }) => tab.ch?.resize(cols, rows));
  term.onTitleChange(t => { tab.title = t.slice(0, 40) || tab.title; render(); });
  tabs.push(tab); active = tab;
  return tab;
}

function closeTab(tab: Tab) {
  tab.ch?.close(); tab.term.dispose();
  tabs.splice(tabs.indexOf(tab), 1);
  if (active === tab) active = tabs.at(-1) ?? null;
}

let render = () => {};

export function mount(root: HTMLElement): Cleanup {
  let target: Target = sessionStorage.getItem('nexus.target') === 'nixos' ? 'nixos' : 'debian';
  root.append(viewHeader('Terminal', 'Interactive shells over an encrypted SSH tunnel. Host keys are pinned; sessions end when you leave the page.',
    subnav([['devices', 'Devices'], ['terminal', 'Terminal'], ['files', 'Files']], 'terminal')));

  const tmux = h('input', { type: 'checkbox', id: 'term-tmux' }); tmux.checked = useTmux;
  tmux.addEventListener('change', () => { useTmux = tmux.checked; });
  const tabBar = h('div', { class: 'term-tabs', role: 'tablist', 'aria-label': 'Terminal tabs' });
  const stage = h('div', { class: 'term-stage' });
  const keys = h('div', { class: 'term-keys', 'aria-label': 'Extra keys' }, ...([
    ['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl-C', '\x03'], ['Ctrl-D', '\x04'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['←', '\x1b[D'], ['→', '\x1b[C'],
  ] as const).map(([label, seq]) => h('button', { type: 'button', class: 'key', onclick: () => { active?.ch?.write(seq); active?.term.focus(); } }, label)));

  root.append(h('section', { class: 'card term-card' },
    h('div', { class: 'term-top' },
      segmented<Target>('Host', [['debian', 'Debian'], ['nixos', 'NixOS']], target, v => { target = v; sessionStorage.setItem('nexus.target', v); }),
      h('button', { type: 'button', class: 'btn primary small', onclick: () => { const t = newTab(target); render(); attach(t); } }, '+ New tab'),
      h('label', { class: 'check inline', for: 'term-tmux' }, tmux, 'Attach tmux')),
    tabBar, stage, keys));

  const ro = new ResizeObserver(() => { try { active?.fit.fit(); } catch { /* hidden */ } });
  ro.observe(stage);

  render = () => {
    if (!stage.isConnected) return;
    tabBar.replaceChildren(...tabs.map(t => h('div', { class: `term-tab${t === active ? ' on' : ''}`, role: 'tab', 'aria-selected': String(t === active) },
      h('button', { type: 'button', class: 'term-tab-b', onclick: () => { active = t; render(); } },
        h('span', { class: `led ${t.alive ? 'ok' : 'off'}`, 'aria-hidden': 'true' }), t.title),
      h('button', { type: 'button', class: 'x', 'aria-label': `Close ${t.title}`, onclick: () => { closeTab(t); render(); } }, '×'))));
    if (!active) {
      stage.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'No terminal open'), h('p', {}, 'Pick Debian or NixOS and choose New tab.')));
      return;
    }
    const tab = active;
    if (stage.firstChild !== tab.el) stage.replaceChildren(tab.el);
    if (!tab.term.element) tab.term.open(tab.el);
    requestAnimationFrame(() => { try { tab.fit.fit(); } catch { /* not laid out */ } tab.term.focus(); });
  };

  devices().then(list => {
    if (!list.some(d => d.username)) root.append(errorBox('Set an SSH username for your devices on the Devices page first.'));
  });
  render();
  return () => { ro.disconnect(); render = () => {}; };
}
