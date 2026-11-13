import { api, raw, h, fmt, pill, tile, viewHeader, errorBox, subnav, type Cleanup } from './lib';

const MODEL_ID = /^[0-9a-f]{16}$/;

export function mount(root: HTMLElement): Cleanup {
  root.append(viewHeader('AI', 'Models stored on the PS5. Loading one replaces the model that is running now.', subnav([['chat', 'Chat'], ['models', 'Models'], ['runs', 'Agent runs']], 'models')));
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted shimmer' }, 'Loading models…'));
  root.append(body);
  let timer = 0, stopped = false, busy = '';

  async function action(path: string, label: string) {
    busy = label; draw();
    try { await raw(path, { method: 'POST' }); }
    catch (e) { body.prepend(errorBox(e)); }
    busy = '';
    poll();
  }

  async function draw() {
    const [list, status] = await Promise.allSettled([api('/v1/nexus/models'), api('/v1/nexus/status')]);
    if (stopped) return;
    body.replaceChildren();
    let loading = false;
    if (status.status === 'fulfilled') {
      const s = status.value;
      loading = s.state === 'loading';
      const progress = typeof s.load_progress === 'number' ? Math.round(s.load_progress * 100) : null;
      body.append(h('section', { class: 'card row-card hero-card' },
        tile('✦', 'purple'),
        h('div', {}, h('span', { class: 'stat-l' }, 'Running now'), h('b', { class: 'stat-v' }, s.model ?? 'Nothing loaded'),
          h('small', { class: 'muted' }, `${fmt.num(s.context_size)} token context · ${fmt.num(s.generation_tps, 1)} tokens/s`)),
        s.ready ? pill('Ready', 'ok') : pill(loading && progress !== null ? `Loading ${progress}%` : String(s.state ?? 'Unknown'), 'warn'),
        s.model ? h('button', { type: 'button', class: 'btn small', disabled: !!busy || loading, onclick: () => confirm(`Unload ${s.model}? Chat stops working until another model is loaded.`) && action('/v1/nexus/models/unload', 'unload') }, busy === 'unload' ? 'Unloading…' : 'Unload') : null));
      if (loading && progress !== null) body.append(h('span', { class: 'bar wide' }, h('i', { style: `width:${progress}%;background:var(--purple)` })));
    }
    if (list.status === 'rejected') { body.append(errorBox(list.reason)); return; }
    const models: any[] = Array.isArray(list.value?.models) ? list.value.models : [];
    if (!models.length) { body.append(h('p', { class: 'muted' }, 'No models found on the PS5.')); return; }
    // The gateway can report current:false for the running model, so also match the status's model_id.
    const running = status.status === 'fulfilled' ? status.value.model_id : undefined;
    body.append(h('div', { class: 'model-grid stagger' }, ...models.map(m => {
      const id = String(m.id);
      const cur = !!m.current || (!!running && id === running);
      return h('section', { class: `card model${cur ? ' current' : ''}` },
        h('header', {}, tile(cur ? '●' : '◇', cur ? 'green' : 'blue'), h('b', {}, String(m.label ?? id))),
        h('small', { class: 'muted mono' }, `${String(m.architecture ?? '—')} · ${fmt.bytes(m.fileSizeBytes ?? m.file_size_bytes)} · ${String(m.drive ?? '—')}`),
        h('div', { class: 'row' },
          cur ? pill('Loaded', 'ok') : m.fits ? pill('Fits', 'info') : pill('Too large', 'warn'),
          !cur && MODEL_ID.test(id) ? h('button', {
            type: 'button', class: 'btn small primary', disabled: !!busy || loading || m.fits === false,
            onclick: () => confirm(`Load ${m.label ?? id}? This replaces the running model.`) && action(`/v1/nexus/models/${id}/load`, id),
          }, busy === id ? 'Loading…' : 'Load') : null));
    })));
    if (loading) poll(2000);
  }

  function poll(ms = 1500) { clearTimeout(timer); timer = window.setTimeout(() => { if (!stopped) draw(); }, ms); }
  draw();
  return () => { stopped = true; clearTimeout(timer); };
}
