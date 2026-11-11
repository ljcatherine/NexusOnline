import { api, h, fmt, pill, viewHeader, errorBox, type Cleanup } from './lib';

const DONE = new Set(['completed', 'failed', 'cancelled']);
const tone = (s: string) => s === 'completed' ? 'ok' : s === 'failed' ? 'err' : s === 'cancelled' ? 'info' : 'warn';
const validRun = (id: unknown) => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);

export function mount(root: HTMLElement): Cleanup {
  root.append(viewHeader('Agent runs', 'Runs started from the iPhone app. You can follow them here; starting or cancelling stays on the phone.'));
  const listEl = h('div', { class: 'card runs' }, h('p', { class: 'muted' }, 'Loading runs…'));
  const detail = h('section', { class: 'card run-detail' }, h('div', { class: 'empty' }, h('h2', {}, 'Pick a run'), h('p', {}, 'Its phase, events and result appear here and refresh while it runs.')));
  root.append(h('div', { class: 'split' }, listEl, detail));
  let timer = 0, stopped = false, openId = '';

  api('/v1/nexus/agent-runs').then(r => {
    const runs: any[] = (Array.isArray(r) ? r : Array.isArray(r?.runs) ? r.runs : Array.isArray(r?.data) ? r.data : []).filter(x => validRun(x?.id));
    listEl.replaceChildren(...(runs.length ? runs.map(run => h('button', { type: 'button', class: 'run-item', onclick: () => open(run.id) },
      h('b', {}, String(run.prompt ?? run.phase ?? run.id).slice(0, 80)),
      h('small', {}, `${fmt.date(run.created_at ?? run.createdAt)} · ${run.id.slice(0, 8)}`),
      pill(String(run.status ?? 'unknown'), tone(String(run.status))))) : [h('p', { class: 'muted' }, 'No agent runs yet.')]));
  }).catch(e => listEl.replaceChildren(errorBox(e)));

  async function open(id: string) {
    openId = id; clearTimeout(timer);
    try {
      const run = await api(`/v1/nexus/agent-runs/${id}`);
      if (stopped || openId !== id) return;
      const status = String(run?.status ?? 'unknown');
      const result = run?.result;
      const text = typeof result === 'string' ? result : result?.response ?? result?.text ?? result?.summary;
      detail.replaceChildren(
        h('header', { class: 'viewer-h' }, h('div', {}, h('b', {}, `Run ${id.slice(0, 8)}`), h('small', { class: 'muted' }, String(run?.phase ?? ''))), pill(status, tone(status))),
        ...(Array.isArray(run?.subagents) && run.subagents.length ? [h('ul', { class: 'subs' }, ...run.subagents.map((s: any) => h('li', {}, `${s.role ?? 'subagent'}`, pill(String(s.status), tone(String(s.status))))))] : []),
        ...(Array.isArray(run?.events) ? [h('ol', { class: 'events' }, ...run.events.slice(-30).map((e: any) => h('li', {}, h('time', {}, fmt.date(e.at)), String(e.phase ?? ''))))] : []),
        ...(run?.error ? [h('div', { class: 'error' }, String(run.error))] : []),
        ...(text ? [h('pre', { class: 'result' }, String(text))] : result ? [h('pre', { class: 'result' }, JSON.stringify(result, null, 2))] : []));
      if (!DONE.has(status)) timer = window.setTimeout(() => open(id), 3000);
    } catch (e) { detail.replaceChildren(errorBox(e)); }
  }
  return () => { stopped = true; clearTimeout(timer); };
}
