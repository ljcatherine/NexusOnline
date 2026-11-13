import { h, pill, tile, viewHeader, subnav, type Cleanup } from './lib';
import { devices, disconnect, hostState, onHostChange, hostStats, setUsername, validUser, pins, type Target, type HostStats } from './hosts';

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
const uptime = (s: number) => s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;

export function meter(label: string, used: number, total: number, text: string) {
  const f = total ? Math.min(1, used / total) : 0;
  return h('div', { class: 'meter-row' }, h('span', {}, label), h('span', { class: 'bar' }, h('i', { style: `width:${f * 100}%;background:${f > .9 ? 'var(--warn)' : 'var(--accent)'}` })), h('small', {}, text));
}

export function statsBlock(s: HostStats) {
  return h('div', { class: 'host-stats' },
    meter('CPU', s.load[0], s.cpus, `load ${s.load.map(n => n.toFixed(2)).join(' ')} · ${s.cpus} cores`),
    meter('Memory', s.memTotal - s.memAvail, s.memTotal, `${gb(s.memTotal - s.memAvail)} of ${gb(s.memTotal)}`),
    meter('Disk /', s.diskUsed, s.diskTotal, `${gb(s.diskUsed)} of ${gb(s.diskTotal)}`),
    h('small', { class: 'muted' }, `Up ${uptime(s.uptime)} · measured ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`));
}

export function mount(root: HTMLElement): Cleanup {
  root.append(viewHeader('Devices', 'Your servers through the Nexus SSH relay. Open a terminal or the file browser, or watch live usage.',
    subnav([['devices', 'Devices'], ['terminal', 'Terminal'], ['files', 'Files']], 'devices')));
  const grid = h('div', { class: 'device-grid stagger' });
  root.append(grid);
  const stats = new Map<Target, HostStats | string>();
  let timer = 0, stopped = false;

  async function draw() {
    const list = await devices();
    if (stopped) return;
    grid.replaceChildren(...list.map(d => {
      const s = hostState(d.target);
      const user = h('input', { type: 'text', value: d.username, placeholder: 'SSH username', 'aria-label': `SSH username for ${d.name}`, autocomplete: 'off', spellcheck: 'false' });
      const save = () => { const v = user.value.trim(); if (v !== d.username && (validUser(v) || !v)) { setUsername(d.target, v); draw(); } };
      user.addEventListener('change', save);
      const st = stats.get(d.target);
      const tone = s.status === 'on' ? 'ok' : s.status === 'connecting' ? 'warn' : s.status === 'error' ? 'err' : 'info';
      const label = { on: 'Connected', connecting: 'Connecting…', error: 'Error', off: 'Not connected' }[s.status];
      return h('section', { class: 'card device' },
        h('header', { class: 'device-h' }, tile(d.target === 'debian' ? '◉' : '❄', d.target === 'debian' ? 'red' : 'blue'),
          h('div', {}, h('h2', {}, d.name), h('small', { class: 'mono muted' }, `${d.username || '—'}@${d.target} · relay`)), pill(label, tone)),
        s.error && s.status === 'error' ? h('p', { class: 'error' }, s.error) : null,
        typeof st === 'object' ? statsBlock(st) : typeof st === 'string' ? h('p', { class: 'muted small' }, st) : null,
        h('div', { class: 'device-actions' },
          h('a', { class: 'btn primary small', href: '#terminal', onclick: () => sessionStorage.setItem('nexus.target', d.target) }, '›_ Terminal'),
          h('a', { class: 'btn small', href: '#files', onclick: () => sessionStorage.setItem('nexus.target', d.target) }, '▤ Files'),
          s.status === 'on'
            ? h('button', { type: 'button', class: 'btn small', onclick: () => { disconnect(d.target); stats.delete(d.target); } }, 'Disconnect')
            : h('button', { type: 'button', class: 'btn small', disabled: s.status === 'connecting', onclick: () => refresh(d.target) }, 'Connect')),
        h('details', { class: 'device-more' }, h('summary', {}, 'Connection'),
          h('label', { class: 'field' }, h('span', {}, 'Username on the relay'), user),
          h('p', { class: 'muted small' }, 'Pinned host key: ', h('code', {}, pins()[d.target] ?? 'not pinned yet — you confirm it on first connect'))));
    }));
  }

  async function refresh(target: Target) {
    try { stats.set(target, await hostStats(target)); } catch (e) { stats.set(target, (e as Error).message); }
    draw();
  }
  const loop = () => {
    if (stopped) return;
    for (const t of ['debian', 'nixos'] as Target[]) if (hostState(t).status === 'on' && !document.hidden) refresh(t);
    timer = window.setTimeout(loop, 10_000);
  };
  const off = onHostChange(draw);
  draw(); loop();
  return () => { stopped = true; clearTimeout(timer); off(); };
}
