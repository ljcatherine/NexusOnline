import { api, h, fmt, pill, viewHeader, errorBox, type Cleanup } from './lib';

export function mount(root: HTMLElement): Cleanup {
  root.append(viewHeader('Models', 'Models stored on the PS5. Loading and unloading change the PS5, so they stay in the iPhone app.'));
  const body = h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Loading models…'));
  root.append(body);

  Promise.allSettled([api('/v1/nexus/models'), api('/v1/nexus/status')]).then(([list, status]) => {
    body.replaceChildren();
    if (status.status === 'fulfilled') {
      const s = status.value;
      body.append(h('section', { class: 'card row-card' },
        h('div', {}, h('span', { class: 'stat-l' }, 'Running now'), h('b', { class: 'stat-v' }, s.model ?? 'Nothing loaded')),
        s.ready ? pill('Ready', 'ok') : pill(String(s.state ?? 'Unknown'), 'warn'),
        h('small', { class: 'muted' }, `${fmt.num(s.context_size)} token context · ${fmt.num(s.generation_tps, 1)} tokens/s`)));
    }
    if (list.status === 'rejected') { body.append(errorBox(list.reason)); return; }
    const models: any[] = Array.isArray(list.value?.models) ? list.value.models : [];
    if (!models.length) { body.append(h('p', { class: 'muted' }, 'No models found on the PS5.')); return; }
    body.append(h('div', { class: 'card tbl' }, h('table', {},
      h('thead', {}, h('tr', {}, ...['Model', 'Drive', 'Size', 'Architecture', 'State'].map(t => h('th', {}, t)))),
      h('tbody', {}, ...models.map(m => h('tr', { class: m.current ? 'current' : '' },
        h('td', {}, String(m.label ?? m.id)),
        h('td', {}, String(m.drive ?? '—')),
        h('td', { class: 'num' }, fmt.bytes(m.fileSizeBytes ?? m.file_size_bytes)),
        h('td', {}, String(m.architecture ?? '—')),
        h('td', {}, m.current ? pill('Loaded', 'ok') : m.fits ? pill('Fits', 'info') : pill('Too large', 'warn'))))))));
  });
  return () => {};
}
