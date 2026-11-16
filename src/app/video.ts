// Video view: prompt (+ optional start image) -> POST job -> poll -> result served once as a blob.
// Gateway strings are untrusted; they are only written with textContent. Caps mirror the gateway (U-10).
import { raw, h, viewHeader, errorBox, type Cleanup } from './lib.ts';
import { mountAiStatus } from './aistatus.ts';

export const MAX_PROMPT_CHARS = 2000;
export const MAX_IMAGE_BYTES = 8 << 20;
export const MIN_DIM = 128;
export const MAX_DIM = 1280;
export const DIM_STEP = 16;
export const MAX_FRAMES = 33;
const POLL_MS = 5000;
const REQUEST_MS = 15000;
const RESULT_MS = 120000;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const TERMINAL_FAILURE = new Set(['failed', 'cancelled']);
const JOB_TEXT: Record<string, string> = {
  queued: 'Queued', switching: 'Switching the PS5 engine', loading: 'Loading the video model', generating: 'Generating frames', done: 'Done',
};

/** Job ids are 32 lowercase hex characters; anything else never reaches a URL. */
export const isJobId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);

/** Frame counts the model accepts: 4k+1 up to MAX_FRAMES (1, 5, ..., 33). */
export const framesValid = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_FRAMES && (n - 1) % 4 === 0;

export const dimsValid = (n: number) => Number.isInteger(n) && n >= MIN_DIM && n <= MAX_DIM && n % DIM_STEP === 0;

/** Magic-byte check: the file's bytes decide the type, not its name or MIME. */
export function sniffImage(bytes: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (bytes.length >= PNG_SIG.length && PNG_SIG.every((b, i) => bytes[i] === b)) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export type VideoRequest = { prompt: string; width: number; height: number; frames: number; init_image_b64?: string };

/** Validates the form values and builds the POST body. Throws RangeError with a message the user can read. */
export function buildVideoRequest(o: { prompt: string; width: number; height: number; frames: number; image?: Uint8Array }): VideoRequest {
  const prompt = o.prompt.trim();
  if (!prompt) throw new RangeError('Describe the video first.');
  if (prompt.length > MAX_PROMPT_CHARS) throw new RangeError(`The prompt is over ${MAX_PROMPT_CHARS} characters.`);
  if (!dimsValid(o.width) || !dimsValid(o.height)) throw new RangeError(`Width and height must be multiples of ${DIM_STEP} from ${MIN_DIM} to ${MAX_DIM}.`);
  if (!framesValid(o.frames)) throw new RangeError(`Frames must be 1, 5, 9 … ${MAX_FRAMES}.`);
  const req: VideoRequest = { prompt, width: o.width, height: o.height, frames: o.frames };
  if (o.image) {
    if (o.image.length > MAX_IMAGE_BYTES) throw new RangeError('The start image is over 8 MiB.');
    if (!sniffImage(o.image)) throw new RangeError('The start image must be a PNG or JPEG file.');
    req.init_image_b64 = toBase64(o.image);
  }
  return req;
}

/** Only the two video types the gateway serves are played; anything else is refused. */
export function videoType(contentType: string | null): 'video/mp4' | 'video/webm' | null {
  const t = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return t === 'video/mp4' || t === 'video/webm' ? t : null;
}

/** Progress text for a job state. The state comes from the gateway and is mapped, never echoed. */
export function jobText(state: unknown, position = 0): string {
  if (state === 'queued') return position ? `Queued, position ${position}` : 'Queued';
  return typeof state === 'string' && JOB_TEXT[state] ? `${JOB_TEXT[state]}…` : 'Working…';
}

const FRAME_OPTIONS = Array.from({ length: (MAX_FRAMES + 3) / 4 }, (_, i) => 4 * i + 1);

export function mountVideoView(root: HTMLElement): Cleanup {
  let disposed = false;
  let ctl: AbortController | null = null;
  let objectUrl: string | null = null;

  const prompt = h('textarea', { id: 'video-prompt', rows: 3, maxlength: MAX_PROMPT_CHARS, placeholder: 'A slow pan over a foggy harbour at dawn…', 'aria-label': 'Prompt' });
  const counter = h('small', {}, `0 / ${MAX_PROMPT_CHARS}`);
  prompt.addEventListener('input', () => { counter.textContent = `${prompt.value.length} / ${MAX_PROMPT_CHARS}`; });
  const image = h('input', { type: 'file', accept: 'image/png,image/jpeg', 'aria-label': 'Start image (optional)' });
  const width = h('input', { type: 'number', min: MIN_DIM, max: MAX_DIM, step: DIM_STEP, value: 416, 'aria-label': 'Width' });
  const height = h('input', { type: 'number', min: MIN_DIM, max: MAX_DIM, step: DIM_STEP, value: 240, 'aria-label': 'Height' });
  const frames = h('select', { 'aria-label': 'Frames' }, ...FRAME_OPTIONS.map(n => h('option', { value: n }, `${n} frame${n > 1 ? 's' : ''}`)));
  frames.value = '9';
  const submitBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Generate video');
  const stopBtn = h('button', { class: 'btn', type: 'button', hidden: true, onclick: () => ctl?.abort() }, 'Stop watching');
  const progress = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
  const alerts = h('div', { role: 'alert' });
  const statusEl = h('p', { class: 'muted' });
  const videoEl = h('video', { controls: true, playsinline: true, preload: 'metadata', 'aria-label': 'Generated video', hidden: true });
  const longRun = h('div', { role: 'note', style: 'border:1px solid var(--warn);border-radius:12px;padding:12px 14px;color:var(--warn)' },
    h('strong', {}, 'Long run. '),
    'A video can take several minutes, sometimes much longer. It unloads the chat and image models on the PS5 while it runs, so chat is unavailable until it finishes.');

  const form = h('form', { class: 'card', onsubmit: (e: Event) => { e.preventDefault(); void submit(); } },
    h('label', {}, 'Prompt', prompt), counter,
    h('label', {}, 'Start image (optional, PNG or JPEG, up to 8 MiB)', image),
    h('div', { class: 'row' },
      h('label', {}, 'Width', width), h('label', {}, 'Height', height), h('label', {}, 'Frames', frames)),
    h('p', { class: 'muted' }, `Width and height are multiples of ${DIM_STEP} from ${MIN_DIM} to ${MAX_DIM}. Frames are 1, 5, 9 … ${MAX_FRAMES}.`),
    h('div', { class: 'row' }, submitBtn, stopBtn));

  root.replaceChildren(
    viewHeader('Video', 'Text or image to video on the PS5, through the gateway.'),
    longRun, form, statusEl, progress, alerts, h('div', { class: 'card' }, videoEl));
  const stopAi = mountAiStatus(statusEl);

  function setRunning(on: boolean) {
    submitBtn.disabled = on;
    stopBtn.hidden = !on;
  }

  function setVideo(blob: Blob) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    videoEl.src = objectUrl;
    videoEl.hidden = false;
  }

  async function readImage(): Promise<Uint8Array | undefined> {
    const file = image.files?.[0];
    if (!file) return undefined;
    if (file.size > MAX_IMAGE_BYTES) throw new RangeError('The start image is over 8 MiB.');
    return new Uint8Array(await file.arrayBuffer());
  }

  async function submit() {
    if (ctl) return;
    const run = new AbortController();
    ctl = run;
    setRunning(true);
    alerts.replaceChildren();
    const started = Date.now();
    const signal = (ms: number) => AbortSignal.any([run.signal, AbortSignal.timeout(ms)]);
    try {
      const body = buildVideoRequest({ prompt: prompt.value, width: Number(width.value), height: Number(height.value), frames: Number(frames.value), image: await readImage() });
      const created = await (await raw('/v1/videos/generations', { method: 'POST', body: JSON.stringify(body), signal: signal(REQUEST_MS) })).json();
      if (!isJobId(created?.id)) throw new Error('The gateway sent an invalid job id.');
      const id = created.id;

      for (;;) {
        await sleep(POLL_MS, run.signal);
        const job = await (await raw(`/v1/ai/jobs/${id}`, { signal: signal(REQUEST_MS) })).json();
        const state = typeof job?.state === 'string' ? job.state : '';
        const elapsed = Math.round((Date.now() - started) / 1000);
        progress.textContent = `${jobText(state, Number(job?.position) || 0)} · ${Math.floor(elapsed / 60)}m ${String(elapsed % 60).padStart(2, '0')}s`;
        if (state === 'done') break;
        if (TERMINAL_FAILURE.has(state)) throw new Error(state === 'failed' ? 'The video job failed on the PS5.' : 'The video job was cancelled.');
      }

      const res = await raw(`/v1/ai/jobs/${id}/result`, { headers: { accept: 'video/mp4, video/webm' }, signal: signal(RESULT_MS) });
      const type = videoType(res.headers.get('content-type'));
      if (!type) throw new Error('The gateway returned no video.');
      if (!disposed) { setVideo(new Blob([await res.blob()], { type })); progress.textContent = 'Video ready.'; }
    } catch (e) {
      if (disposed) return;
      if (run.signal.aborted) progress.textContent = 'Stopped watching. The job may still finish on the PS5 and its result is then discarded.';
      else { progress.textContent = ''; alerts.append(errorBox(e)); }
    } finally {
      ctl = null;
      if (!disposed) setRunning(false);
    }
  }

  return () => {
    disposed = true;
    ctl?.abort();
    stopAi();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    root.replaceChildren();
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
