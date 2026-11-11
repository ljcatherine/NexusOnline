// Shared helpers for the Nexus Online app. All gateway data is rendered with
// textContent / attributes only — never innerHTML — so responses can't inject markup.

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/** Only http(s) links from gateway data become clickable. */
export function safeUrl(raw: unknown): string | null {
  try { const u = new URL(String(raw)); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; } catch { return null; }
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function explain(status: number, message: string): string {
  if (status === 0 || status === 401) return 'Your sign-in has expired. Reload the page to sign in again.';
  if (status === 403) return message || 'This action is not allowed on the web.';
  if (status === 404) return 'Not found on the gateway.';
  if (status === 429) return 'The gateway is rate limiting requests. Wait a few seconds and try again.';
  if (status >= 500) return message || 'The gateway is unreachable right now.';
  return message || `Request failed (${status}).`;
}

/** fetch() to the Worker's /api proxy. An Access redirect (expired session) shows up as status 0. */
export async function raw(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!headers.has('accept')) headers.set('accept', 'application/json');
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers, credentials: 'same-origin', redirect: 'manual' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(0, explain(0, ''));
  }
  if (res.type === 'opaqueredirect' || !res.ok) {
    let message = '';
    try { message = String((await res.json())?.error ?? ''); } catch { /* not JSON */ }
    throw new ApiError(res.type === 'opaqueredirect' ? 0 : res.status, explain(res.status, message));
  }
  return res;
}

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  return (await raw(path, init)).json();
}

export const fmt = {
  num: (n: unknown, d = 0) => typeof n === 'number' && isFinite(n) ? n.toLocaleString('en-GB', { maximumFractionDigits: d, minimumFractionDigits: d }) : '—',
  gib: (n: unknown) => typeof n === 'number' ? `${n.toFixed(1)} GB` : '—',
  bytes: (n: unknown) => typeof n !== 'number' ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`,
  date: (v: unknown) => {
    const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(String(v));
    return isNaN(+d) ? '—' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  },
};

export function pill(text: string, tone: 'ok' | 'warn' | 'err' | 'info') { return h('span', { class: `pill ${tone}` }, text); }

export function viewHeader(title: string, lede: string, ...extra: Child[]) {
  return h('header', { class: 'view-head' }, h('div', {}, h('h1', {}, title), h('p', {}, lede)), ...extra);
}

export function errorBox(e: unknown) {
  return h('div', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e));
}

/** Sparkline with area fill, faint grid and an emphasised last point. */
export function sparkline(canvas: HTMLCanvasElement, values: number[], color = '#9CBCFF') {
  const d = devicePixelRatio || 1, W = Math.round(canvas.clientWidth * d), H = Math.round(canvas.clientHeight * d);
  if (!W || !H) return;
  canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d')!;
  g.strokeStyle = 'rgba(166,175,194,.12)'; g.lineWidth = d;
  for (const f of [.25, .5, .75]) { g.beginPath(); g.moveTo(0, H * f); g.lineTo(W, H * f); g.stroke(); }
  if (values.length < 2) return;
  const max = Math.max(...values, 1) * 1.15;
  const pts = values.map((v, i) => [i / (values.length - 1) * (W - 6 * d) + 3 * d, H - 4 * d - v / max * (H - 8 * d)]);
  const grad = g.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, color + '55'); grad.addColorStop(1, color + '00');
  const path = () => { g.beginPath(); pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); };
  path(); g.lineTo(pts.at(-1)![0], H); g.lineTo(pts[0][0], H); g.closePath(); g.fillStyle = grad; g.fill();
  path(); g.strokeStyle = color; g.lineWidth = 1.8 * d; g.lineJoin = 'round'; g.stroke();
  const [x, y] = pts.at(-1)!; g.fillStyle = color; g.beginPath(); g.arc(x, y, 3.2 * d, 0, 7); g.fill();
}

/** Chats live in sessionStorage unless the owner chooses to keep them on this device. */
const PREF = 'nexus.keepChats';
export const prefs = {
  get keepChats() { try { return localStorage.getItem(PREF) === '1'; } catch { return false; } },
  set keepChats(on: boolean) {
    try {
      const data = chatStore().getItem('nexus.chats');
      on ? localStorage.setItem(PREF, '1') : localStorage.removeItem(PREF);
      localStorage.removeItem('nexus.chats'); sessionStorage.removeItem('nexus.chats');
      if (data) chatStore().setItem('nexus.chats', data);
    } catch { /* storage blocked */ }
  },
};
export function chatStore(): Storage { return prefs.keepChats ? localStorage : sessionStorage; }

export function clearLocalData() {
  for (const s of [localStorage, sessionStorage]) {
    try { Object.keys(s).filter(k => k.startsWith('nexus.') && k !== 'nexus.motion').forEach(k => s.removeItem(k)); } catch { /* blocked */ }
  }
}

/** Mirrors Desktop's context rules: these files are never sent to an AI. */
export function isSensitive(path: string) {
  const name = path.split('/').pop() ?? '';
  return /^\.env(\..*)?$|\.pem$|\.key$|\.p12$|\.pfx$|^id_[a-z0-9]+(\.pub)?$|credentials|secrets?\.(json|ya?ml|toml)$|\.kdbx$/i.test(name);
}

export type Cleanup = () => void;
