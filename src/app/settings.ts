import { h, pill, tile, viewHeader, prefs, clearLocalData, me, type Cleanup } from './lib';
import { pins, forgetPin, TARGETS, TITLE } from './hosts';

const CAN = [
  ['Gateway, PS5 and host status', 'Read'], ['AI chat, web search and research', 'Use'], ['Terminal on Debian and NixOS (SSH)', 'Full'],
  ['Files on Debian and NixOS (SFTP)', 'Full'], ['Load and unload PS5 models', 'Control'], ['Start and cancel agent runs', 'Control'],
  ['Conversations synced from iPhone', 'Read'],
];
const NEVER = [
  ['Approve workspace patches or commands', 'iPhone · Desktop'], ['Change or delete synced conversations', 'iPhone'],
  ['Store SSH keys or passwords', 'The relay holds the key'],
];

export function signOut() {
  clearLocalData();
  location.href = '/cdn-cgi/access/logout';
}

export function mount(root: HTMLElement): Cleanup {
  root.append(viewHeader('Settings', 'Your sign-in, what the web can do, pinned host keys, and what stays on this device.'));
  const who = h('b', { class: 'stat-v' }, '…');
  const expires = h('small', { class: 'muted' }, '');
  let timer = 0;
  me().then(m => {
    if (!m) { who.textContent = 'Session expired'; return; }
    who.textContent = m.email;
    const tick = () => {
      const mins = Math.max(0, Math.round((m.expiresAt * 1000 - Date.now()) / 60000));
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

  const table = (rows: string[][], ok: boolean, head: string) => h('div', { class: 'card tbl' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', {}, head), h('th', {}, ok ? 'Access' : 'Where instead'))),
    h('tbody', {}, ...rows.map(([what, how]) => h('tr', {}, h('td', {}, what), h('td', {}, ok ? pill(how, how === 'Read' ? 'ok' : 'info') : how))))));

  const pinList = h('div', { class: 'stack tight' });
  const drawPins = () => {
    const p = pins();
    pinList.replaceChildren(...TARGETS.map(t => h('div', { class: 'pin-row' },
      h('span', {}, h('b', {}, TITLE[t]), h('code', {}, p[t] ?? 'Not pinned yet')),
      p[t] ? h('button', { type: 'button', class: 'btn small', onclick: () => {
        if (confirm(`Forget the pinned ${TITLE[t]} relay key? Only do this after rotating the relay host key on purpose. You will confirm the new key on next connect.`)) { forgetPin(t); drawPins(); }
      } }, 'Forget') : null)));
  };
  drawPins();

  root.append(h('div', { class: 'stack stagger' },
    h('section', { class: 'card row-card' },
      tile('⛨', 'green'),
      h('div', {}, h('span', { class: 'stat-l' }, 'Signed in with Cloudflare Access'), who, expires),
      h('button', { type: 'button', class: 'btn', onclick: signOut }, 'Sign out')),
    h('section', { class: 'card prefs' },
      h('h2', {}, 'SSH host keys'),
      h('p', { class: 'muted small' }, 'The first connection to each relay shows its fingerprint for you to confirm. After that, a changed key is refused.'),
      pinList),
    h('div', { class: 'two' }, table(CAN, true, 'The web can'), table(NEVER, false, 'The web never does')),
    h('section', { class: 'card prefs' },
      h('h2', {}, 'This device'),
      h('label', { class: 'check', for: 'pref-keep' }, keep, h('span', {}, h('b', {}, 'Keep chats after closing the tab'), h('small', {}, 'Off by default so nothing stays on a computer that isn\'t yours.'))),
      h('label', { class: 'check', for: 'pref-motion' }, motion, h('span', {}, h('b', {}, 'Animations'), h('small', {}, 'On by default. Turn them off here if you prefer a still page.'))),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'btn', onclick: () => { clearLocalData(); keep.checked = false; cleared.textContent = 'Chats cleared from this browser.'; } }, 'Clear chats from this browser'), cleared))));
  return () => clearInterval(timer);
}
