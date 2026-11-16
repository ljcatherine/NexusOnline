// Helpers shared by the Nexus Mail page and its composer.
import { h } from '../app/lib';

export type Addr = { name: string; address: string };

export class MailError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** fetch() to /api/mail. Shows the mail server's own error text; an Access redirect means the sign-in expired. */
export async function call<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  let res: Response;
  try {
    res = await fetch(`/api/mail${path}`, { ...init, headers, credentials: 'same-origin', redirect: 'manual' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new MailError(0, 'Could not reach Nexus Mail. Check your connection.');
  }
  if (res.type === 'opaqueredirect' || res.status === 401) throw new MailError(401, 'Your sign-in has expired. Reload the page to sign in again.');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new MailError(res.status, String(data?.error ?? `Request failed (${res.status}).`));
  return data as T;
}

// 24px outline icons, drawn with currentColor.
const PATHS: Record<string, string> = {
  inbox: 'M4 13h4l1.5 3h5l1.5-3h4M4 13l2.5-8h11L20 13v6H4z',
  star: 'M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.7l-5.1 2.7 1-5.6-4.1-4 5.7-.8z',
  send: 'M4 12l16-8-6 16-2.6-6.4zM11.4 13.6L20 4',
  draft: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h4',
  all: 'M3 6h18v12H3zM3 6l9 7 9-7',
  unread: 'M3 6h18v12H3zM3 6l9 7 9-7',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6',
  archive: 'M3 5h18v4H3zM5 9v10h14V9M10 13h4',
  restore: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4',
  reply: 'M10 8l-5 4 5 4M5 12h9a5 5 0 0 1 5 5v1',
  replyAll: 'M13 8l-5 4 5 4M8 8l-5 4 5 4M8 12h7a5 5 0 0 1 5 5v1',
  forward: 'M14 8l5 4-5 4M19 12h-9a5 5 0 0 0-5 5v1',
  attach: 'M16.5 6.5l-7.8 7.8a2 2 0 0 0 2.8 2.8l8-8a4 4 0 0 0-5.7-5.7l-8 8a6 6 0 0 0 8.5 8.5L20 14',
  back: 'M15 5l-7 7 7 7',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4',
  close: 'M6 6l12 12M18 6L6 18',
  min: 'M6 18h12',
  expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  menu: 'M4 6h16M4 12h16M4 18h16',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM15.5 15.5L20 20',
  pencil: 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  forever: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11l4 5M14 11l-4 5',
};
export function icon(name: string, filled = false) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', `i${filled ? ' filled' : ''}`);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PATHS[name] ?? '');
  svg.append(path);
  return svg;
}

export const size = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;

export function when(ms: number, long = false) {
  const d = new Date(ms), now = new Date();
  if (long) return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() && { year: 'numeric' }) });
}

let toastTimer = 0;
/** Bottom toast, optionally with one action such as Undo. */
export function toast(text: string, action?: { label: string; run: () => void }, tone: 'ok' | 'err' = 'ok') {
  const el = document.getElementById('toast')!;
  el.replaceChildren(h('span', {}, text), ...(action ? [h('button', { type: 'button', onclick: () => { el.classList.remove('on'); action.run(); } }, action.label)] : []));
  el.dataset.tone = tone;
  el.classList.add('on');
  const hide = (ms: number) => { clearTimeout(toastTimer); toastTimer = window.setTimeout(() => el.classList.remove('on'), ms); };
  hide(action ? 10_000 : 3500);
  // Hovering keeps an Undo within reach; leaving gives a few more seconds.
  el.onmouseenter = () => clearTimeout(toastTimer);
  el.onmouseleave = () => hide(3000);
}
