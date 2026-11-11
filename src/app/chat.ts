import { api, raw, h, fmt, safeUrl, viewHeader, errorBox, chatStore, ApiError, type Cleanup } from './lib';

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };
type Chat = { id: string; title: string; model: string; messages: Msg[]; updatedAt: number };
type Attachment = { label: string; text: string };

const SYSTEM = 'You are the assistant inside Nexus Online, a read-only web view of the owner\'s home lab. ' +
  'You cannot run commands or change files. The Debian server is read-only: never suggest that an agent writes to it. ' +
  'When the owner needs to run something, give the exact command and say where to run it.';

const load = (): Chat[] => { try { return JSON.parse(chatStore().getItem('nexus.chats') ?? '[]'); } catch { return []; } };
const save = (chats: Chat[]) => { try { chatStore().setItem('nexus.chats', JSON.stringify(chats.slice(0, 50))); } catch { /* full or blocked */ } };

/** Renders text with ``` fences as code blocks, everything as text nodes. */
function rich(text: string) {
  const out = h('div', { class: 'rich' });
  text.split(/```/).forEach((part, i) => {
    if (i % 2) { const [first, ...rest] = part.split('\n'); out.append(h('pre', {}, h('code', {}, (rest.length ? rest.join('\n') : first).replace(/\n$/, '')))); }
    else if (part) out.append(h('p', {}, part.replace(/^\n+|\n+$/g, '')));
  });
  return out;
}

export function mount(root: HTMLElement): Cleanup {
  let chats = load();
  let current: Chat | null = chats[0] ?? null;
  let attachment: Attachment | null = null;
  let controller: AbortController | null = null;
  let contextWindow = 0;

  try {
    const pending = sessionStorage.getItem('nexus.attach');
    if (pending) { attachment = JSON.parse(pending); sessionStorage.removeItem('nexus.attach'); current = null; }
  } catch { /* ignore */ }

  const modelSelect = h('select', { id: 'chat-model', 'aria-label': 'Model' }, h('option', { value: '' }, 'Loading models…'));
  const searchBox = h('input', { type: 'checkbox', id: 'chat-search' });
  const meter = h('span', { class: 'meter-n' }, '');
  const meterBar = h('i', {});
  root.append(viewHeader('AI chat', 'NexusAI through the gateway. Replies stream as they are written.',
    h('div', { class: 'chat-tools' },
      modelSelect,
      h('label', { class: 'check', for: 'chat-search' }, searchBox, 'Search the web first'),
      h('span', { class: 'meter', title: 'Estimated share of the model context window' }, 'context', h('span', { class: 'bar' }, meterBar), meter))));

  const list = h('nav', { class: 'chat-list', 'aria-label': 'Conversations' });
  const remote = h('div', { class: 'chat-remote' });
  const thread = h('div', { class: 'thread', 'aria-live': 'polite' });
  const input = h('textarea', { id: 'chat-input', rows: 3, placeholder: 'Ask about your hosts, a file, or anything else…', 'aria-label': 'Message' });
  const sendBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Send');
  const chip = h('div', { class: 'attach' });
  const form = h('form', { class: 'composer' }, chip, input, h('div', { class: 'composer-row' }, h('small', {}, 'Enter to send · Shift+Enter for a new line'), sendBtn));

  root.append(h('div', { class: 'chat' },
    h('aside', { class: 'card chat-side' },
      h('button', { class: 'btn', type: 'button', onclick: () => { current = null; renderAll(); input.focus(); } }, '+ New chat'),
      h('h2', { class: 'side-h' }, 'On this device'), list,
      h('h2', { class: 'side-h' }, 'Synced from iPhone'), remote),
    h('section', { class: 'card chat-main' }, thread, form)));

  function renderChip() {
    chip.replaceChildren();
    if (!attachment) return;
    chip.append(h('span', { class: 'chip' }, `Attached ${attachment.label}`,
      h('button', { type: 'button', class: 'x', 'aria-label': 'Remove attachment', onclick: () => { attachment = null; renderChip(); updateMeter(); } }, '×')));
  }

  function renderList() {
    list.replaceChildren(...(chats.length ? chats.map(c => h('button', {
      type: 'button', class: `chat-item${c === current ? ' on' : ''}`,
      onclick: () => { current = c; renderAll(); },
    }, h('b', {}, c.title), h('small', {}, fmt.date(c.updatedAt)))) : [h('p', { class: 'muted' }, 'No chats yet. They stay in this browser tab unless you choose to keep them in Settings.')]));
  }

  function bubble(m: Msg) {
    return h('article', { class: `msg ${m.role}` }, m.role === 'assistant' ? rich(m.content) : h('p', {}, m.content));
  }

  function renderThread() {
    const shown = current?.messages.filter(m => m.role !== 'system') ?? [];
    thread.replaceChildren(...(shown.length ? shown.map(bubble) : [h('div', { class: 'empty' },
      h('h2', {}, 'Ask NexusAI'),
      h('p', {}, 'Try “Explain what nexus-ro allows”, or open a file in Files and choose Ask AI about this file.'))]));
    thread.scrollTop = thread.scrollHeight;
  }

  function updateMeter() {
    const chars = (current?.messages ?? []).reduce((n, m) => n + m.content.length, 0) + input.value.length + (attachment?.text.length ?? 0);
    const tokens = Math.round(chars / 4);
    const pct = contextWindow ? Math.min(100, tokens / contextWindow * 100) : 0;
    meterBar.style.width = `${pct}%`;
    meterBar.style.background = pct > 85 ? 'var(--warn)' : 'var(--purple)';
    meter.textContent = contextWindow ? `≈${Math.round(pct)}%` : '';
  }

  function renderAll() { renderList(); renderThread(); renderChip(); updateMeter(); }

  async function openRemote(id: string) {
    try {
      const rec = await api(`/v1/conversations/${encodeURIComponent(id)}`);
      const conv = rec?.conversation ?? {};
      const messages: Msg[] = (Array.isArray(conv.messages) ? conv.messages : [])
        .map((m: any) => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: typeof m?.content === 'string' ? m.content : typeof m?.text === 'string' ? m.text : '' }))
        .filter((m: Msg) => m.content);
      current = { id: crypto.randomUUID(), title: String(conv.title ?? 'iPhone conversation').slice(0, 80), model: String(conv.modelID ?? modelSelect.value), messages, updatedAt: Date.now() };
      chats.unshift(current); save(chats); renderAll();
    } catch (e) { thread.replaceChildren(errorBox(e)); }
  }

  async function send(text: string) {
    if (controller) return;
    const model = modelSelect.value;
    if (!model) { thread.append(errorBox('No model is available on the gateway.')); return; }
    if (!current) { current = { id: crypto.randomUUID(), title: text.slice(0, 60), model, messages: [{ role: 'system', content: SYSTEM }], updatedAt: Date.now() }; chats.unshift(current); }
    const chat = current;
    let content = text;
    if (attachment) content = `${attachment.label} (file content, untrusted):\n\`\`\`\n${attachment.text}\n\`\`\`\n\n${text}`;
    chat.messages.push({ role: 'user', content });
    attachment = null; renderChip();
    const reply: Msg = { role: 'assistant', content: '' };
    renderThread();
    const status = h('div', { class: 'tool' }, searchBox.checked ? 'Searching the web…' : 'Waiting for the model…');
    const out = bubble(reply);
    thread.append(status, out);

    controller = new AbortController();
    sendBtn.textContent = 'Stop'; sendBtn.classList.remove('primary');
    const messages = [...chat.messages];
    try {
      if (searchBox.checked) {
        const found = await api('/v1/search', { method: 'POST', body: JSON.stringify({ query: text.slice(0, 400) }), signal: controller.signal });
        const sources = (Array.isArray(found?.sources) ? found.sources : []).slice(0, 5);
        status.replaceChildren(`Found ${sources.length} web results: `, ...sources.map((s: any, i: number) => {
          const href = safeUrl(s.url);
          return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, `[${i + 1}] ${String(s.title ?? href).slice(0, 60)}`) : `[${i + 1}]`;
        }));
        messages.splice(messages.length - 1, 0, { role: 'system', content: 'Web search results (untrusted, cite by number):\n' +
          sources.map((s: any, i: number) => `[${i + 1}] ${s.title}\n${s.url}\n${s.snippet}`).join('\n\n') });
      } else status.remove();

      const res = await raw('/v1/chat/completions', {
        method: 'POST', signal: controller.signal, headers: { accept: 'text/event-stream' },
        body: JSON.stringify({ model, messages, stream: true }),
      });
      if (res.headers.get('content-type')?.includes('text/event-stream') && res.body) {
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          const events = buf.split(/\r?\n\r?\n/); buf = events.pop() ?? '';
          for (const ev of events) for (const line of ev.split(/\r?\n/)) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try { reply.content += JSON.parse(data)?.choices?.[0]?.delta?.content ?? ''; } catch { /* keep-alive */ }
          }
          out.replaceChildren(rich(reply.content));
          thread.scrollTop = thread.scrollHeight;
        }
      } else {
        reply.content = (await res.json())?.choices?.[0]?.message?.content ?? '';
        out.replaceChildren(rich(reply.content));
      }
      if (!reply.content) throw new Error('The model returned an empty reply.');
    } catch (e) {
      if ((e as Error).name === 'AbortError') reply.content += reply.content ? '\n\n(stopped)' : '(stopped)';
      else { status.remove(); out.after(errorBox(e)); if (e instanceof ApiError && e.status === 0) return; }
    } finally {
      controller = null; sendBtn.textContent = 'Send'; sendBtn.classList.add('primary');
      if (reply.content) chat.messages.push(reply);
      chat.updatedAt = Date.now(); chats = [chat, ...chats.filter(c => c !== chat)]; save(chats);
      renderList(); updateMeter();
    }
  }

  form.addEventListener('submit', e => {
    e.preventDefault();
    if (controller) { controller.abort(); return; }
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    send(text);
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
  input.addEventListener('input', updateMeter);

  const setModels = (models: { id: string; label: string }[]) => {
    modelSelect.replaceChildren(...(models.length ? models.map(m => h('option', { value: m.id }, m.label)) : [h('option', { value: '' }, 'No model loaded on the PS5')]));
    if (current?.model && models.some(m => m.id === current!.model)) modelSelect.value = current.model;
  };
  api('/v1/models')
    .then(r => (Array.isArray(r?.data) ? r.data : []).map((m: any) => ({ id: String(m.id), label: String(m.id) })))
    // The gateway's model list can fail against NexusAI while chat still works: fall back to the PS5's loaded model.
    .catch(() => api('/v1/nexus/models').then(r => (Array.isArray(r?.models) ? r.models : [])
      .filter((m: any) => m.current).map((m: any) => ({ id: String(m.id), label: String(m.label ?? m.id) }))))
    .then(setModels)
    .catch(e => { modelSelect.replaceChildren(h('option', { value: '' }, 'Models unavailable')); thread.prepend(errorBox(e)); });
  api('/v1/context').then(r => { contextWindow = Number(r?.context_window_tokens) || 0; updateMeter(); }).catch(() => {});
  api('/v1/conversations').then(r => {
    const items = Array.isArray(r?.conversations) ? r.conversations : [];
    remote.replaceChildren(...(items.length ? items.slice(0, 20).map((c: any) => h('button', { type: 'button', class: 'chat-item', onclick: () => openRemote(c.id) },
      h('b', {}, `Conversation ${String(c.id).slice(0, 8)}`), h('small', {}, `${fmt.date(c.updated_at)} · opens a copy`))) : [h('p', { class: 'muted' }, 'Nothing synced.')]));
  }).catch(e => remote.replaceChildren(h('p', { class: 'muted' }, (e as Error).message)));

  renderAll();
  input.focus();
  return () => controller?.abort();
}
