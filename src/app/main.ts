import { me, type Cleanup } from './lib';
import * as overview from './overview';
import * as devices from './devices';
import * as terminal from './terminal';
import * as files from './files';
import * as chat from './chat';
import * as models from './models';
import * as runs from './runs';
import * as settings from './settings';

type View = { mount(root: HTMLElement): Cleanup };
// [view, tab index] — the tab bar mirrors the iPhone app: Overview · Devices · AI · Settings.
const VIEWS: Record<string, [View, number]> = {
  overview: [overview, 0], devices: [devices, 1], terminal: [terminal, 1], files: [files, 1],
  chat: [chat, 2], models: [models, 2], runs: [runs, 2], settings: [settings, 3], security: [settings, 3],
};
const root = document.getElementById('view')!;
const nav = document.querySelector<HTMLElement>('.app-nav')!;
let cleanup: Cleanup = () => {};
let lastTab = -1;

function route() {
  const name = location.hash.slice(1);
  if (!VIEWS[name] && name) history.replaceState(null, '', '#overview');
  const [view, tab] = VIEWS[name] ?? VIEWS.overview;
  const swap = () => {
    cleanup();
    root.replaceChildren();
    root.dataset.dir = lastTab < 0 || tab === lastTab ? 'same' : tab > lastTab ? 'fwd' : 'back';
    root.classList.remove('enter'); void root.offsetWidth; root.classList.add('enter');
    cleanup = view.mount(root);
    const h1 = root.querySelector('h1');
    document.title = `${h1?.textContent ?? 'Nexus Online'} · Nexus Online`;
    h1?.setAttribute('tabindex', '-1'); h1?.focus({ preventScroll: true });
  };
  // View Transitions where supported (cross-fade + slide); plain swap elsewhere or with motion off.
  const vt = (document as any).startViewTransition;
  if (vt && lastTab >= 0 && document.documentElement.dataset.motion !== 'off' && !matchMedia('(prefers-reduced-motion: reduce)').matches) vt.call(document, swap);
  else swap();
  nav.style.setProperty('--i', String(tab));
  nav.querySelectorAll<HTMLAnchorElement>('a').forEach((a, i) => a.toggleAttribute('aria-current', i === tab));
  lastTab = tab;
}

addEventListener('hashchange', route);
route();

me().then(m => { const el = document.getElementById('who'); if (el) el.textContent = m?.email ?? 'Session expired. Reload to sign in.'; });
document.getElementById('signout')?.addEventListener('click', settings.signOut);
