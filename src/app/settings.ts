import { h, pill, viewHeader, prefs, clearLocalData, type Cleanup } from './lib';

const ALLOWED = [
  ['Gateway and PS5 status', 'Read'], ['AI chat and web search', 'Use'], ['Workspace files on Debian and NixOS', 'Read'],
  ['Conversations synced from iPhone', 'Read'], ['Agent runs', 'Read'],
];
const BLOCKED = [
  ['Writing files, patches or commands on any server', 'Desktop'], ['Starting or cancelling agent runs', 'iPhone'],
  ['Loading or unloading PS5 models', 'iPhone'], ['SSH terminals and host metrics', 'Desktop · iPhone'],
  ['Changing or deleting synced conversations', 'iPhone'],
];

export function signOut() {
  clearLocalData();
  location.href = '/cdn-cgi/access/logout';
}

export function mount(root: HTMLElement): Cleanup {
  root.append(viewHeader('Security', 'Who is signed in, what the web can do, and what stays on this device.'));
  const who = h('b', { class: 'stat-v' }, '…');
  const expires = h('small', { class: 'muted' }, '');
  let timer = 0;
  fetch('/api/me', { credentials: 'same-origin', redirect: 'manual' }).then(r => r.ok ? r.json() : null).then(me => {
    if (!me) { who.textContent = 'Session expired'; return; }
    who.textContent = me.email;
    const tick = () => {
      const mins = Math.max(0, Math.round((me.expiresAt * 1000 - Date.now()) / 60000));
      expires.textContent = mins > 90 ? `Session ends in about ${Math.round(mins / 60)} hours` : `Session ends in ${mins} minutes`;
    };
    tick(); timer = window.setInterval(tick, 30000);
  });

  const keep = h('input', { type: 'checkbox', id: 'pref-keep' });
  keep.checked = prefs.keepChats;
  keep.addEventListener('change', () => { prefs.keepChats = keep.checked; });
  const motion = h('input', { type: 'checkbox', id: 'pref-motion' });
  motion.checked = document.documentElement.dataset.motion !== 'off';
  motion.addEventListener('change', () => { try { localStorage.setItem('nexus.motion', motion.checked ? 'on' : 'off'); } catch { /* blocked */ } document.documentElement.dataset.motion = motion.checked ? 'on' : 'off'; });
  const cleared = h('small', { class: 'muted', 'aria-live': 'polite' }, '');

  const table = (rows: string[][], tone: 'ok' | 'err', head: string) => h('div', { class: 'card tbl' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, head), h('th', {}, tone === 'ok' ? 'Access' : 'Use instead'))),
    h('tbody', {}, ...rows.map(([what, how]) => h('tr', {}, h('td', {}, what), h('td', {}, tone === 'ok' ? pill(how, 'ok') : how))))));

  root.append(h('div', { class: 'stack' },
    h('section', { class: 'card row-card' },
      h('div', {}, h('span', { class: 'stat-l' }, 'Signed in with Cloudflare Access'), who, expires),
      h('button', { type: 'button', class: 'btn', onclick: signOut }, 'Sign out')),
    h('div', { class: 'two' }, table(ALLOWED, 'ok', 'The web can'), table(BLOCKED, 'err', 'The web never does')),
    h('section', { class: 'card prefs' },
      h('h2', {}, 'This device'),
      h('label', { class: 'check', for: 'pref-keep' }, keep, h('span', {}, h('b', {}, 'Keep chats after closing the tab'), h('small', {}, 'Off by default so nothing stays on a computer that isn\'t yours.'))),
      h('label', { class: 'check', for: 'pref-motion' }, motion, h('span', {}, h('b', {}, 'Animations'), h('small', {}, 'On by default. Turn them off here if you prefer a still page.'))),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => { clearLocalData(); keep.checked = false; cleared.textContent = 'Chats and settings cleared from this browser.'; } }, 'Clear chats from this browser'), cleared))));
  return () => clearInterval(timer);
}
