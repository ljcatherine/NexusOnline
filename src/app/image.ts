// Image view: prompt, allow-listed model and size presets, progress and a PNG result.
// Gateway and model text is untrusted and only ever written with textContent.
import { raw, h, viewHeader, errorBox, type Cleanup } from './lib.ts';
import { mountAiStatus } from './aistatus.ts';
import { IMAGE_MODELS, IMAGE_SIZES, MAX_PROMPT, buildImageRequest, describeProgress, pngFromResponse, splitSse } from './image-core.ts';

/** Cold model loads take about 100 s; past this the request is abandoned so the buttons come back. */
const TIMEOUT_MS = 5 * 60_000;

/** Reads the SSE reply, reporting progress, and returns the base64 PNG from the final event. */
async function readStream(res: Response, onProgress: (ev: any) => void): Promise<string> {
  if (!res.body) throw new Error('The gateway sent an empty reply.');
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '', final: any = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    const { events, rest } = splitSse(buf);
    buf = rest;
    for (const ev of events) {
      if (ev === '[DONE]') continue;
      let obj: any;
      try { obj = JSON.parse(ev); } catch { throw new Error('The gateway sent an invalid reply.'); }
      if (obj?.http_status != null || obj?.data || obj?.error) final = obj;
      else onProgress(obj);
    }
  }
  return pngFromResponse(final);
}

export function mountImageView(root: HTMLElement): Cleanup {
  const prompt = h('textarea', { id: 'img-prompt', rows: 4, maxlength: MAX_PROMPT, placeholder: 'A lighthouse on a cliff at dusk, oil painting', 'aria-label': 'Prompt' });
  const model = h('select', { id: 'img-model', 'aria-label': 'Model' }, ...IMAGE_MODELS.map(m => h('option', { value: m.id }, m.label)));
  const size = h('select', { id: 'img-size', 'aria-label': 'Size' }, ...IMAGE_SIZES.map(s => h('option', { value: s }, s.replace('x', ' × '))));
  const generate = h('button', { class: 'btn primary', type: 'submit' }, 'Generate');
  const cancel = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => controller?.abort() }, 'Cancel');
  const status = h('div', { class: 'ai-status' });
  const progress = h('p', { class: 'muted', role: 'status' });
  const error = h('div');
  const result = h('figure', { class: 'image-out' });
  const form = h('form', { class: 'card image-form' },
    h('label', {}, 'Prompt', prompt),
    h('div', { class: 'chat-tools' }, h('label', {}, 'Model', model), h('label', {}, 'Size', size)),
    h('div', { class: 'composer-row' }, generate, cancel));
  const view = h('section', { class: 'image-view' }, viewHeader('Images', 'Generated on the PS5 through the gateway. The first image after a restart waits for the model to load.'), status, form, progress, error, result);
  root.append(view);
  const stopStatus = mountAiStatus(status);

  let controller: AbortController | null = null;

  async function run(e: Event) {
    e.preventDefault();
    if (controller) return;
    error.replaceChildren(); result.replaceChildren();
    let body: string;
    try { body = buildImageRequest({ prompt: prompt.value, model: model.value, size: size.value }); }
    catch (err) { error.append(errorBox(err)); return; }

    const ac = controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, TIMEOUT_MS);
    generate.disabled = true; cancel.hidden = false; progress.textContent = 'Starting…';
    try {
      const res = await raw('/v1/images/generations', { method: 'POST', body, signal: ac.signal, headers: { accept: 'text/event-stream' } });
      const streaming = res.headers.get('content-type')?.includes('text/event-stream');
      const b64 = streaming ? await readStream(res, ev => { progress.textContent = describeProgress(ev) ?? progress.textContent; }) : pngFromResponse(await res.json());
      result.append(h('img', { src: `data:image/png;base64,${b64}`, alt: 'Generated image' }));
    } catch (err) {
      if ((err as Error).name === 'AbortError') error.append(errorBox(timedOut ? 'Timed out waiting for the PS5. It may be busy or offline.' : 'Cancelled.'));
      else error.append(errorBox(err));
    } finally {
      clearTimeout(timer);
      controller = null;
      generate.disabled = false; cancel.hidden = true; progress.textContent = '';
    }
  }

  form.addEventListener('submit', run);
  return () => {
    controller?.abort();
    stopStatus();
    view.remove();
  };
}
