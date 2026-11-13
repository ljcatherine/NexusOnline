import { api, raw, h, fmt, pill, viewHeader, errorBox, subnav, segmented, findSecrets, type Cleanup } from './lib';

const DONE = new Set(['completed', 'failed', 'cancelled']);
const tone = (s: string) => s === 'completed' ? 'ok' : s === 'failed' ? 'err' : s === 'cancelled' ? 'info' : 'warn';
const HEX32 = /^[0-9a-f]{32}$/;
const PROMPT_LIMIT = 48 * 1024;
type Host = 'debian' | 'nixos';

export function mount(root: HTMLElement): Cleanup {
  root.append(viewHeader('AI', 'Agent runs on the PS5 orchestrator. Start one against a workspace, follow it live, cancel it any time.',
    subnav([['chat', 'Chat'], ['models', 'Models'], ['runs', 'Agent runs']], 'runs')));

  let host: Host = 'debian';
  const wsSelect = h('select', { 'aria-label': 'Workspace' }, h('option', { value: '' }, 'Loading…'));
  const path = h('input', { type: 'text', placeholder: 'Folder in the workspace (optional)', 'aria-label': 'Folder in the workspace' });
  const subagents = h('select', { 'aria-label': 'Subagents' }, ...[0, 1, 2, 3].map(n => h('option', { value: String(n) }, n ? `${n} subagent${n > 1 ? 's' : ''}` : 'No subagents')));
  const prompt = h('textarea', { rows: 3, placeholder: 'What should the agent do? It reads the workspace and reports back.', 'aria-label': 'Task for the agent' });
  const startBtn = h('button', { type: 'submit', class: 'btn primary small' }, 'Start run');
  const formMsg = h('div', {});
  const form = h('form', { class: 'card run-form' },
    h('div', { class: 'row' }, segmented<Host>('Host', [['debian', 'Debian'], ['nixos', 'NixOS']], host, v => { host = v; loadWorkspaces(); }), wsSelect, subagents),
    path, prompt, h('div', { class: 'row end' }, formMsg, startBtn));

  const listEl = h('div', { class: 'card runs' }, h('p', { class: 'muted shimmer' }, 'Loading runs…'));
  const detail = h('section', { class: 'card run-detail' }, h('div', { class: 'empty' }, h('h2', {}, 'Pick a run'), h('p', {}, 'Its phase, events and result appear here and refresh while it runs.')));
  root.append(form, h('div', { class: 'split' }, listEl, detail));
  let timer = 0, stopped = false, openId = '';

  async function loadWorkspaces() {
    wsSelect.replaceChildren(h('option', { value: '' }, 'Loading…'));
    try {
      const r = await api(`/v1/nexus/workspaces/${host}`);
      const list = (Array.isArray(r?.workspaces) ? r.workspaces : []).filter((w: any) => /^[a-z][a-z0-9_-]{0,31}$/.test(String(w?.id)));
      wsSelect.replaceChildren(...(list.length ? list.map((w: any) => h('option', { value: w.id }, String(w.name ?? w.id))) : [h('option', { value: '' }, 'No workspaces on this host')]));
    } catch (e) { wsSelect.replaceChildren(h('option', { value: '' }, (e as Error).message.slice(0, 60))); }
  }

  async function loadRuns() {
    try {
      const r = await api('/v1/nexus/agent-runs');
      const runs: any[] = (Array.isArray(r) ? r : Array.isArray(r?.runs) ? r.runs : Array.isArray(r?.data) ? r.data : []).filter((x: any) => HEX32.test(String(x?.id)));
      if (stopped) return;
      listEl.replaceChildren(...(runs.length ? runs.map(run => h('button', { type: 'button', class: `run-item${run.id === openId ? ' on' : ''}`, onclick: () => open(run.id) },
        h('b', {}, String(run.prompt ?? run.phase ?? run.id).slice(0, 80)),
        h('small', {}, `${fmt.date(run.created_at ?? run.createdAt)} · ${run.id.slice(0, 8)}`),
        pill(String(run.status ?? 'unknown'), tone(String(run.status))))) : [h('p', { class: 'muted' }, 'No agent runs yet.')]));
    } catch (e) { listEl.replaceChildren(errorBox(e)); }
  }

  async function cancel(id: string, sub?: string) {
    if (!confirm(sub ? 'Cancel this subagent?' : 'Cancel this run?')) return;
    try { await raw(`/v1/nexus/agent-runs/${id}${sub ? `/subagents/${sub}` : ''}/cancel`, { method: 'POST' }); open(id); loadRuns(); }
    catch (e) { detail.prepend(errorBox(e)); }
  }

  async function open(id: string) {
    openId = id; clearTimeout(timer);
    try {
      const run = await api(`/v1/nexus/agent-runs/${id}`);
      if (stopped || openId !== id) return;
      const status = String(run?.status ?? 'unknown');
      const result = run?.result;
      const text = typeof result === 'string' ? result : result?.response ?? result?.text ?? result?.summary;
      const live = !DONE.has(status);
      detail.replaceChildren(
        h('header', { class: 'viewer-h' }, h('div', {}, h('b', {}, `Run ${id.slice(0, 8)}`), h('small', { class: 'muted' }, String(run?.phase ?? ''))),
          h('div', { class: 'row' }, pill(status, tone(status)), live && status !== 'cancelling' ? h('button', { type: 'button', class: 'btn small', onclick: () => cancel(id) }, 'Cancel run') : null)),
        ...(Array.isArray(run?.subagents) && run.subagents.length ? [h('ul', { class: 'subs' }, ...run.subagents.map((s: any) => h('li', {}, `${s.role ?? 'subagent'}`, pill(String(s.status), tone(String(s.status))),
          live && HEX32.test(String(s.id)) && !DONE.has(String(s.status)) ? h('button', { type: 'button', class: 'icon-b', 'aria-label': 'Cancel subagent', onclick: () => cancel(id, s.id) }, '✕') : null)))] : []),
        ...(Array.isArray(run?.events) ? [h('ol', { class: 'events' }, ...run.events.slice(-30).map((e: any) => h('li', {}, h('time', {}, fmt.date(e.at)), String(e.phase ?? ''))))] : []),
        ...(run?.error ? [h('div', { class: 'error' }, String(run.error))] : []),
        ...(text ? [h('pre', { class: 'result' }, String(text))] : result ? [h('pre', { class: 'result' }, JSON.stringify(result, null, 2))] : []),
        ...(live ? [h('p', { class: 'muted small live-note' }, h('span', { class: 'dot' }), 'Refreshing every 3 seconds')] : []));
      if (live) timer = window.setTimeout(() => open(id), 3000);
    } catch (e) { detail.replaceChildren(errorBox(e)); }
  }

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const text = prompt.value.trim();
    const folder = path.value.trim().replace(/^\/+|\/+$/g, '');
    formMsg.replaceChildren();
    if (!text || !wsSelect.value) { formMsg.append(errorBox('Pick a workspace and describe the task.')); return; }
    if (new TextEncoder().encode(text).length > PROMPT_LIMIT) { formMsg.append(errorBox('The task is longer than 48 KB.')); return; }
    if (folder && (folder.length > 512 || folder.split('/').some(p => !p || p === '.' || p === '..'))) { formMsg.append(errorBox('That folder path is not valid.')); return; }
    const secrets = findSecrets(text);
    if (secrets.length && !confirm(`The task looks like it contains a ${secrets.join(', ')}. Send it anyway?`)) return;
    startBtn.disabled = true;
    try {
      const r = await api('/v1/nexus/agent-runs', { method: 'POST', body: JSON.stringify({
        prompt: text, history: [], workspace: { host, workspace_id: wsSelect.value, path: folder },
        subagents: Number(subagents.value), auto_compact: true,
      }) });
      if (!HEX32.test(String(r?.id))) throw new Error('The orchestrator returned an unexpected reply.');
      prompt.value = '';
      await loadRuns(); open(r.id);
    } catch (err) { formMsg.append(errorBox(err)); }
    startBtn.disabled = false;
  });

  loadWorkspaces(); loadRuns();
  return () => { stopped = true; clearTimeout(timer); };
}
