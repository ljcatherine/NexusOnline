import type { Cleanup } from './lib';
import * as overview from './overview';
import * as chat from './chat';
import * as files from './files';
import * as models from './models';
import * as runs from './runs';
import * as settings from './settings';

const VIEWS: Record<string, { mount(root: HTMLElement): Cleanup }> = { overview, chat, files, models, runs, security: settings };
const root = document.getElementById('view')!;
let cleanup: Cleanup = () => {};

function route() {
  const name = location.hash.slice(1);
  const view = VIEWS[name] ?? overview;
  if (!VIEWS[name] && name) history.replaceState(null, '', '#overview');
  cleanup();
  root.replaceChildren();
  root.classList.remove('enter'); void root.offsetWidth; root.classList.add('enter');
  cleanup = view.mount(root);
  document.querySelectorAll<HTMLAnchorElement>('.app-nav a').forEach(a => {
    a.toggleAttribute('aria-current', a.hash === `#${VIEWS[name] ? name : 'overview'}`);
  });
  const h1 = root.querySelector('h1');
  document.title = `${h1?.textContent ?? 'Nexus Online'} · Nexus Online`;
  h1?.setAttribute('tabindex', '-1'); h1?.focus({ preventScroll: true });
}

addEventListener('hashchange', route);
route();

fetch('/api/me', { credentials: 'same-origin', redirect: 'manual' })
  .then(r => r.ok ? r.json() : null)
  .then(me => { const el = document.getElementById('who'); if (el) el.textContent = me?.email ?? 'Session expired. Reload to sign in.'; })
  .catch(() => {});
document.getElementById('signout')?.addEventListener('click', settings.signOut);
