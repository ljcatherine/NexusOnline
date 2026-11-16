// Push-to-talk voice view: mic -> 16-bit WAV -> POST /api/v1/voice/chat (SSE) -> spoken reply.
// Gateway strings and model output are untrusted: textContent / createElement only.
import { mountAiStatus } from './aistatus.ts';
import { raw, h } from './lib.ts';
import { encodeWav, MAX_SECONDS } from './wav.ts';

export const MAX_HISTORY = 20;
/** Gateway cap on the decoded WAV (mediaValMaxAudioBytes). */
export const MAX_AUDIO_BYTES = 10 << 20;
const IDLE_MS = 120_000;

export type Turn = { role: 'user' | 'assistant'; content: string };

export type VoiceEvent =
  | { type: 'status'; status: string }
  | { type: 'transcript'; text: string }
  | { type: 'text'; delta: string }
  | { type: 'audio'; audio_b64: string }
  | { type: 'done'; reply: string }
  | { type: 'error'; message: string };

/** Incremental SSE parser. Feed text as it arrives; returns the data payload of each completed event. */
export class SseParser {
  private buf = '';
  private data: string[] = [];
  private skipLF = false;   // previous chunk ended in \r, so a leading \n here is the second half of CRLF

  push(chunk: string): string[] {
    let text = chunk;
    if (this.skipLF && text.startsWith('\n')) text = text.slice(1);
    this.skipLF = text.endsWith('\r');
    const parts = (this.buf + text).split(/\r\n|\r|\n/);
    this.buf = parts.pop()!;
    const out: string[] = [];
    for (const line of parts) {
      if (line === '') {
        if (this.data.length) out.push(this.data.join('\n'));
        this.data = [];
      } else if (line.startsWith('data:')) {
        this.data.push(line.startsWith('data: ') ? line.slice(6) : line.slice(5));
      } // comments (":") and other fields (event:, id:, retry:) are not used by the gateway
    }
    return out;
  }
}

/** Maps one SSE data payload to a typed event. Unknown or malformed payloads return null. */
export function parseVoiceEvent(data: string): VoiceEvent | null {
  let o: any;
  try { o = JSON.parse(data); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  if (o.type === 'error' || o.error) {
    const msg = typeof o.message === 'string' ? o.message : typeof o.error?.message === 'string' ? o.error.message : '';
    return { type: 'error', message: msg || 'The voice service returned an error.' };
  }
  switch (o.type) {
    case 'transcript': return typeof o.text === 'string' ? { type: 'transcript', text: o.text } : null;
    case 'text': return typeof o.delta === 'string' ? { type: 'text', delta: o.delta } : null;
    case 'audio': return typeof o.audio_b64 === 'string' ? { type: 'audio', audio_b64: o.audio_b64 } : null;
    case 'done': return { type: 'done', reply: typeof o.reply === 'string' ? o.reply : '' };
  }
  return typeof o.status === 'string' ? { type: 'status', status: o.status } : null;
}

/** Keeps the last MAX_HISTORY user/assistant turns that have content. */
export function trimHistory(turns: Turn[], max = MAX_HISTORY): Turn[] {
  return turns.filter(t => (t.role === 'user' || t.role === 'assistant') && t.content).slice(-max);
}

/** Request body for /v1/voice/chat. The system prompt is fixed server-side, so it is never sent. */
export function buildVoiceRequest(audioB64: string, history: Turn[]) {
  return { audio_b64: audioB64, messages: trimHistory(history).map(({ role, content }) => ({ role, content })) };
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

/** Message when an encoded WAV is over the gateway cap, otherwise null. */
export function clipError(wavBytes: number): string | null {
  return wavBytes > MAX_AUDIO_BYTES ? `The recording is too large to send. Keep it under ${MAX_SECONDS} seconds.` : null;
}

export function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

const micError = (e: unknown) => {
  const name = (e as Error)?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was blocked. Allow the microphone for this site and try again.';
  if (name === 'NotFoundError') return 'No microphone was found.';
  return e instanceof Error ? e.message : 'The microphone could not be started.';
};

export function mountVoiceView(root: HTMLElement): () => void {
  let history: Turn[] = [];
  let holding = false;          // push-to-talk button is down
  let busy = false;             // request in flight
  let abort: AbortController | null = null;
  let timedOut = false;
  let idle = 0;
  let cap = 0;
  let rec: { ctx: AudioContext; stream: MediaStream; source: MediaStreamAudioSourceNode; node: ScriptProcessorNode; chunks: Float32Array[] } | null = null;

  // Playback: one <audio> element, sentences played in arrival order from blob URLs.
  const audio = new Audio();
  const queue: string[] = [];
  let current = '';

  const status = h('div', { class: 'ai-status' });
  const stopStatus = mountAiStatus(status);
  const talk = h('button', { class: 'btn primary', type: 'button', 'aria-pressed': 'false' }, 'Hold to talk');
  const cancel = h('button', { class: 'btn', type: 'button', disabled: '' }, 'Cancel');
  const reset = h('button', { class: 'btn', type: 'button' }, 'New conversation');
  const note = h('p', { class: 'muted', role: 'status' });
  const err = h('div');
  const heardLabel = h('h3', {}, 'You said');
  const heard = h('p', { class: 'voice-heard' });
  const replyLabel = h('h3', {}, 'NexusAI');
  const reply = h('p', { class: 'voice-reply', 'aria-live': 'polite' });
  const controls = h('div', { class: 'voice-controls' }, talk, cancel, reset);
  root.append(
    h('header', { class: 'view-head' }, h('div', {}, h('h1', {}, 'Voice'), h('p', {}, 'Hold the button, speak, release. The reply is spoken back one sentence at a time.'))),
    h('section', { class: 'card voice' }, status, controls, note, err, heardLabel, heard, replyLabel, reply),
  );

  function setUi() {
    talk.disabled = busy;
    talk.setAttribute('aria-pressed', String(holding));
    talk.textContent = holding ? 'Recording… release to send' : busy ? 'Waiting for the reply…' : 'Hold to talk';
    cancel.toggleAttribute('disabled', !(busy || current || queue.length));
    reset.toggleAttribute('disabled', busy);
  }

  const showError = (e: unknown) => err.replaceChildren(h('div', { class: 'error', role: 'alert' }, e instanceof Error ? e.message : String(e)));

  function playNext() {
    if (current || !queue.length) return;
    current = queue.shift()!;
    audio.src = current;
    audio.play().catch(() => { stopPlayback(); showError(new Error('Playback was blocked. Hold to talk again to retry.')); });
    setUi();
  }
  audio.onended = audio.onerror = () => {
    if (current) URL.revokeObjectURL(current);
    current = '';
    playNext();
    setUi();
  };

  function stopPlayback() {
    audio.pause();
    audio.removeAttribute('src');
    for (const u of queue.splice(0)) URL.revokeObjectURL(u);
    if (current) URL.revokeObjectURL(current);
    current = '';
    setUi();
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot record audio.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    // shortcut: ScriptProcessorNode is deprecated but needs no worklet file; move to AudioWorklet if browsers drop it
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    node.onaudioprocess = e => {
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      e.outputBuffer.getChannelData(0).fill(0);
    };
    source.connect(node);
    node.connect(ctx.destination);
    return { ctx, stream, source, node, chunks };
  }

  function stopRecording(): { samples: Float32Array; rate: number } | null {
    clearTimeout(cap);
    const r = rec;
    rec = null;
    if (!r) return null;
    r.node.disconnect();
    r.source.disconnect();
    r.stream.getTracks().forEach(t => t.stop());
    void r.ctx.close();
    return { samples: concat(r.chunks), rate: r.ctx.sampleRate };
  }

  async function startTalk() {
    if (holding || busy) return;
    holding = true;
    err.replaceChildren();
    setUi();
    try {
      const r = await startRecording();
      if (!holding) {               // released before the mic opened
        r.stream.getTracks().forEach(t => t.stop());
        void r.ctx.close();
        return;
      }
      rec = r;
      cap = window.setTimeout(() => { note.textContent = `Reached the ${MAX_SECONDS} s limit, sending.`; endTalk(); }, MAX_SECONDS * 1000);
      note.textContent = '';
    } catch (e) {
      holding = false;
      showError(new Error(micError(e)));
    }
    setUi();
  }

  function endTalk() {
    if (!holding) return;
    holding = false;
    const clip = stopRecording();
    setUi();
    if (!clip) return;            // mic still opening; startTalk will discard it
    if (!clip.samples.length) { showError(new Error('Nothing was recorded. Check the microphone and try again.')); return; }
    void send(clip.samples, clip.rate);
  }

  async function send(samples: Float32Array, rate: number) {
    busy = true;
    timedOut = false;
    heard.textContent = '';
    reply.textContent = '';
    note.textContent = 'Sending…';
    setUi();
    const ctrl = new AbortController();
    abort = ctrl;
    const kick = () => {
      clearTimeout(idle);
      idle = window.setTimeout(() => { timedOut = true; ctrl.abort(); }, IDLE_MS);
    };
    kick();

    let text = '';
    let heardText = '';
    let finished = false;
    try {
      const wav = encodeWav(samples, rate);
      const tooBig = clipError(wav.byteLength);
      if (tooBig) throw new Error(tooBig);
      const res = await raw('/v1/voice/chat', {
        method: 'POST', body: JSON.stringify(buildVoiceRequest(toBase64(wav), history)), signal: ctrl.signal,
        headers: { accept: 'text/event-stream' },
      });
      if (!res.body) throw new Error('The gateway sent no reply.');
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      const parser = new SseParser();
      read: for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        kick();
        for (const data of parser.push(value)) {
          if (data === '[DONE]') { finished = true; break read; }
          const ev = parseVoiceEvent(data);
          if (!ev) continue;
          switch (ev.type) {
            case 'status': note.textContent = ev.status === 'loading' ? 'Loading the voice models, this can take about a minute…' : 'Preparing the voice engine…'; break;
            case 'transcript': heardText = ev.text; heard.textContent = ev.text; note.textContent = ''; break;
            case 'text': text += ev.delta; reply.textContent = text; break;
            case 'audio': queue.push(URL.createObjectURL(new Blob([fromBase64(ev.audio_b64)], { type: 'audio/wav' }))); playNext(); break;
            case 'done': finished = true; if (ev.reply) { text = ev.reply; reply.textContent = text; } break;
            case 'error': throw new Error(ev.message);
          }
        }
      }
      await reader.cancel().catch(() => {});
      if (!finished) throw new Error('The connection closed before the reply finished. Try again.');
      if (heardText && text) history = trimHistory([...history, { role: 'user', content: heardText }, { role: 'assistant', content: text }]);
      note.textContent = '';
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        if (timedOut) showError(new Error('The voice reply stopped responding. Try again.'));
        else note.textContent = 'Cancelled.';
      } else showError(e);
    } finally {
      clearTimeout(idle);
      abort = null;
      busy = false;
      setUi();
    }
  }

  talk.addEventListener('pointerdown', e => { if (e.button === 0) { e.preventDefault(); void startTalk(); } });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) talk.addEventListener(type, endTalk);
  talk.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); void startTalk(); } });
  talk.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); endTalk(); } });
  cancel.addEventListener('click', () => { abort?.abort(); stopPlayback(); });
  reset.addEventListener('click', () => {
    history = [];
    stopPlayback();
    heard.textContent = '';
    reply.textContent = '';
    note.textContent = '';
    err.replaceChildren();
  });
  setUi();

  return () => {
    holding = false;
    stopRecording();
    abort?.abort();
    clearTimeout(idle);
    stopPlayback();
    stopStatus();
  };
}
