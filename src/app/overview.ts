import { api, h, fmt, pill, viewHeader, sparkline, type Cleanup } from './lib';
import { hostState, hostStats, TITLE, type Target, type HostStats } from './hosts';
import { statsBlock } from './devices';

function stat(label: string, wide = false) {
  const value = h('b', { class: 'stat-v' }, '—');
  const sub = h('small', { class: 'stat-s' }, '');
  const extra = h('div', { class: 'stat-x' });
  const el = h('section', { class: `card stat${wide ? ' wide' : ''}` }, h('span', { class: 'stat-l' }, label), value, sub, extra);
  return { el, value, sub, extra, set(v: string, s = '') { value.textContent = v; sub.textContent = s; } };
}

function bar(fraction: number, tone = 'var(--accent)') {
  const pct = Math.max(0, Math.min(100, fraction * 100));
  return h('div', { class: 'bar', role: 'meter', 'aria-valuenow': Math.round(pct), 'aria-valuemin': 0, 'aria-valuemax': 100 },
    h('i', { style: `width:${pct}%;background:${tone}` }));
}

export function mount(root: HTMLElement): Cleanup {
  const live = h('span', { class: 'chip' }, h('span', { class: 'dot' }), 'Updating');
  root.append(viewHeader('Overview', 'Live status from the gateway, NexusAI and your hosts. Refreshes every 5 seconds while this tab is open.', live));

  const inference = stat('NexusAI inference', true);
  const canvas = h('canvas', { class: 'spark', 'aria-label': 'Generation speed over the last few minutes' });
  inference.extra.append(canvas);
  const context = stat('Context in use');
  const memory = stat('PS5 memory');
  const models = stat('Models on the PS5');
  const runs = stat('Agent runs active');
  const convs = stat('Synced conversations');
  let stopped = false;
  const hostCards = (['debian', 'nixos'] as Target[]).map(t => {
    const el = h('section', { class: 'card stat host' });
    const draw = (s?: HostStats | string) => {
      const st = hostState(t);
      el.replaceChildren(h('span', { class: 'stat-l' }, `${TITLE[t]} host`),
        typeof s === 'object' ? statsBlock(s) : h('div', { class: 'row' },
          h('small', { class: 'muted' }, typeof s === 'string' ? s : st.status === 'connecting' ? 'Connecting…' : 'CPU, memory and disk come over the SSH tunnel.'),
          st.status === 'connecting' ? null : h('button', { type: 'button', class: 'btn small', onclick: () => poll() }, 'Connect')));
    };
    const poll = () => hostStats(t).then(s => { if (!stopped) draw(s); }, e => { if (!stopped) draw((e as Error).message); });
    draw();
    return { el, refresh: () => { if (hostState(t).status === 'on') poll(); } };
  });

  root.append(h('div', { class: 'cards stagger' }, inference.el, context.el, memory.el, models.el, runs.el, convs.el, ...hostCards.map(c => c.el)));

  const speeds: number[] = [];
  let timer = 0;

  async function refresh() {
    const [status, list, active, history] = await Promise.allSettled([
      api('/v1/nexus/status'), api('/v1/nexus/models'), api('/v1/nexus/agent-runs/active'), api('/v1/conversations'),
    ]);
    if (stopped) return;

    if (status.status === 'fulfilled') {
      const s = status.value;
      const tone = s.ready ? 'ok' : s.state === 'loading' ? 'warn' : 'err';
      const label = s.ready ? 'Ready' : s.state === 'loading' && typeof s.load_progress === 'number' ? `Loading ${Math.round(s.load_progress * 100)}%` : String(s.state ?? 'Unknown');
      inference.set(s.model ?? 'No model loaded', `${fmt.num(s.generation_tps, 1)} tokens/s generating · ${fmt.num(s.prompt_tps, 0)} tokens/s reading`);
      inference.value.after(pill(label, tone));
      inference.el.querySelectorAll('.pill').forEach((p, i, all) => { if (i < all.length - 1) p.remove(); });
      if (typeof s.generation_tps === 'number') { speeds.push(s.generation_tps); if (speeds.length > 60) speeds.shift(); }
      sparkline(canvas, speeds, '#C9ADFF');

      const used = s.context_used ?? 0, size = s.context_size ?? 0;
      context.set(size ? `${Math.round(used / size * 100)}%` : '—', `${fmt.num(used)} of ${fmt.num(size)} tokens`);
      context.extra.replaceChildren(bar(size ? used / size : 0, used / size > .85 ? 'var(--warn)' : 'var(--purple)'));

      const pool = s.memory_pool_gib ?? 0, free = s.memory_free_gib ?? 0;
      memory.set(fmt.gib(pool - free), `used of ${fmt.gib(pool)} · model ${fmt.gib(s.model_gib)} · cache ${fmt.gib(s.kv_cache_gib)}`);
      memory.extra.replaceChildren(bar(pool ? (pool - free) / pool : 0, (pool - free) / pool > .9 ? 'var(--warn)' : 'var(--accent)'));
    } else {
      inference.set('Unavailable', status.reason?.message ?? '');
    }

    if (list.status === 'fulfilled') {
      const all = Array.isArray(list.value?.models) ? list.value.models : [];
      const current = all.find((m: any) => m.current);
      models.set(String(all.length), current ? `Loaded: ${current.label}` : 'None loaded');
    } else models.set('—', list.reason?.message ?? '');

    if (active.status === 'fulfilled') {
      const v = active.value;
      const n = Array.isArray(v) ? v.length : Array.isArray(v?.runs) ? v.runs.length : v?.id ? 1 : 0;
      runs.set(String(n), n ? 'See Agent runs' : 'Nothing running');
    } else runs.set('—', active.reason?.message ?? '');

    if (history.status === 'fulfilled') {
      const c = Array.isArray(history.value?.conversations) ? history.value.conversations : [];
      convs.set(String(c.length), c[0] ? `Latest ${fmt.date(c[0].updated_at)}` : 'None yet');
    } else convs.set('—', history.reason?.message ?? '');

    live.lastChild!.textContent = `Updated ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  }

  const loop = async () => {
    if (!document.hidden) { hostCards.forEach(c => c.refresh()); await refresh().catch(() => {}); }
    if (!stopped) timer = window.setTimeout(loop, 5000);
  };
  loop();
  return () => { stopped = true; clearTimeout(timer); };
}
