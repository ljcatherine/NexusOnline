// Audio view: speech to text (POST /api/v1/audio/transcriptions) and text to speech (POST /api/v1/audio/speech).
// Gateway replies and transcripts are untrusted: they are only ever written with textContent, and
// audio is only played from blob: URLs created from the response bytes.
import { mountAiStatus } from './aistatus.ts';
import { raw, h, viewHeader, errorBox, type Cleanup } from './lib.ts';

export const MAX_STT_BYTES = 10 * 1024 * 1024;
export const MAX_TTS_CHARS = 1000;
export const MAX_REFERENCE_BYTES = 2 * 1024 * 1024;
/** Hidden until the gateway reports ai.voice.clone to the client; no client-visible permission source exists yet. */
export const VOICE_CLONE_VISIBLE = false;
const STT_TIMEOUT_MS = 2 * 60_000;
const TTS_TIMEOUT_MS = 5 * 60_000;

export type TranscriptionRequest = { audio_b64: string; language?: string; translate?: boolean };
export type SpeechRequest = { input: string; language?: string; voice_reference_b64?: string; consent?: true };

const sizeProblem = (size: number, max: number, what: string) =>
  size > max ? `${what} is ${(size / 1048576).toFixed(1)} MiB; the limit is ${max / 1048576} MiB.` : null;

/** True when the bytes start with a RIFF....WAVE header. */
export function isWav(bytes: Uint8Array): boolean {
  const ascii = (off: number) => String.fromCharCode(...bytes.subarray(off, off + 4));
  return bytes.length >= 12 && ascii(0) === 'RIFF' && ascii(8) === 'WAVE';
}

/** A user-facing problem with a WAV upload, or null when it is acceptable. */
export function wavProblem(bytes: Uint8Array, max: number, what = 'File'): string | null {
  return sizeProblem(bytes.length, max, what) ?? (isWav(bytes) ? null : `${what} is not a WAV file.`);
}

/** A user-facing problem with TTS text (trimmed), or null when it can be sent. */
export function checkSpeechText(text: string): string | null {
  const t = text.trim();
  if (!t) return 'Enter some text.';
  return t.length > MAX_TTS_CHARS ? `Text is over ${MAX_TTS_CHARS} characters.` : null;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function buildTranscriptionRequest(wav: Uint8Array, opts: { language?: string; translate?: boolean } = {}): TranscriptionRequest {
  const problem = wavProblem(wav, MAX_STT_BYTES);
  if (problem) throw new RangeError(problem);
  return {
    audio_b64: toBase64(wav),
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.translate ? { translate: true } : {}),
  };
}

/** A voice reference is only ever sent with explicit consent: no consent, no request. */
export function buildSpeechRequest(opts: { input: string; language?: string; voiceReference?: Uint8Array; consent?: boolean }): SpeechRequest {
  const problem = checkSpeechText(opts.input);
  if (problem) throw new RangeError(problem);
  const req: SpeechRequest = { input: opts.input.trim(), ...(opts.language ? { language: opts.language } : {}) };
  if (opts.voiceReference) {
    if (opts.consent !== true) throw new Error('Voice cloning needs the speaker\'s consent.');
    const wrong = wavProblem(opts.voiceReference, MAX_REFERENCE_BYTES, 'Reference voice');
    if (wrong) throw new RangeError(wrong);
    req.voice_reference_b64 = toBase64(opts.voiceReference);
    req.consent = true;
  }
  return req;
}

export async function transcribe(wav: Uint8Array, signal: AbortSignal): Promise<{ text: string; language: string }> {
  const res = await raw('/v1/audio/transcriptions', { method: 'POST', body: JSON.stringify(buildTranscriptionRequest(wav)), signal });
  const j = await res.json().catch(() => { throw new Error('The gateway sent an invalid reply.'); });
  if (typeof j?.text !== 'string') throw new Error('The gateway sent an unexpected transcription reply.');
  return { text: j.text, language: typeof j.language === 'string' ? j.language : '' };
}

export async function synthesize(req: SpeechRequest, signal: AbortSignal): Promise<Uint8Array> {
  const res = await raw('/v1/audio/speech', { method: 'POST', body: JSON.stringify(req), signal, headers: { accept: 'audio/wav' } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!isWav(bytes)) throw new Error('The gateway did not return a WAV file.');
  return bytes;
}

/** Mounts the audio view into `root`. Returns a cleanup that aborts any request and frees audio URLs. */
export function mountAudioView(root: HTMLElement): Cleanup {
  let active: AbortController | null = null;
  let sttBytes: Uint8Array | null = null;
  let refBytes: Uint8Array | null = null;

  const statusEl = h('p', { class: 'muted' });
  const stopStatus = mountAiStatus(statusEl);
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => active?.abort() }, 'Cancel');

  /** Runs one request at a time; buttons are disabled meanwhile and the request times out. */
  async function run(ms: number, out: HTMLElement, job: (signal: AbortSignal) => Promise<void>) {
    if (active) return;
    const ctl = new AbortController();
    let timedOut = false;
    active = ctl;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
    out.replaceChildren();
    refresh();
    try {
      await job(ctl.signal);
    } catch (e) {
      const aborted = (e as Error)?.name === 'AbortError';
      out.replaceChildren(aborted
        ? h('p', { class: 'muted' }, timedOut ? `Timed out after ${ms / 1000} s. Try again.` : 'Cancelled.')
        : errorBox(e));
    } finally {
      clearTimeout(timer);
      active = null;
      refresh();
    }
  }

  /** Plays WAV bytes in `out`, revoking the blob URL of whatever it replaces. */
  function playInto(out: HTMLElement, bytes: Uint8Array) {
    const old = out.querySelector('audio');
    if (old) URL.revokeObjectURL(old.src);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const audio = h('audio', { controls: true, src: url });
    out.replaceChildren(audio);
    audio.play().catch(() => { /* autoplay blocked: the controls still work */ });
  }

  /** Reads a WAV picked by the user; size is checked before reading the whole file. */
  async function loadWav(file: File | undefined, max: number, what: string, out: HTMLElement): Promise<Uint8Array | null> {
    if (!file) return null;
    const tooBig = sizeProblem(file.size, max, what);
    if (tooBig) { out.replaceChildren(errorBox(new Error(tooBig))); return null; }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const problem = wavProblem(bytes, max, what);
    if (problem) { out.replaceChildren(errorBox(new Error(problem))); return null; }
    return bytes;
  }

  // Speech to text
  const sttFile = h('input', { type: 'file', id: 'stt-file', accept: '.wav,audio/wav', 'aria-label': 'WAV file to transcribe' });
  const sttOut = h('div', { class: 'audio-out', 'aria-live': 'polite' });
  const sttBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => run(STT_TIMEOUT_MS, sttOut, async signal => {
    const bytes = sttBytes;
    if (!bytes) throw new Error('Choose a WAV file first.');
    const r = await transcribe(bytes, signal);
    sttOut.replaceChildren(h('p', {}, r.text || '(no speech found)'), r.language ? h('small', { class: 'muted' }, `Language: ${r.language}`) : null);
  }) }, 'Transcribe');
  sttFile.addEventListener('change', async () => {
    sttBytes = null; sttOut.replaceChildren(); refresh();
    sttBytes = await loadWav(sttFile.files?.[0], MAX_STT_BYTES, 'File', sttOut);
    refresh();
  });

  // Text to speech
  const ttsText = h('textarea', { id: 'tts-text', rows: 4, 'aria-label': 'Text to speak', placeholder: 'Text to speak' });
  const ttsHint = h('small', { class: 'muted' });
  const ttsOut = h('div', { class: 'audio-out', 'aria-live': 'polite' });
  const speakBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => run(TTS_TIMEOUT_MS, ttsOut, async signal => {
    const req = buildSpeechRequest({ input: ttsText.value });
    playInto(ttsOut, await synthesize(req, signal));
  }) }, 'Speak');
  ttsText.addEventListener('input', refresh);

  // Voice clone (hidden while VOICE_CLONE_VISIBLE is false)
  const refFile = h('input', { type: 'file', id: 'clone-ref', accept: '.wav,audio/wav', 'aria-label': 'Reference voice WAV' });
  const consent = h('input', { type: 'checkbox', id: 'clone-consent' });
  const cloneText = h('textarea', { id: 'clone-text', rows: 3, 'aria-label': 'Text to speak in the cloned voice', placeholder: 'Text to speak' });
  const cloneOut = h('div', { class: 'audio-out', 'aria-live': 'polite' });
  const cloneBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => run(TTS_TIMEOUT_MS, cloneOut, async signal => {
    if (!refBytes) throw new Error('Choose a reference WAV first.');
    const req = buildSpeechRequest({ input: cloneText.value, voiceReference: refBytes, consent: consent.checked });
    playInto(cloneOut, await synthesize(req, signal));
  }) }, 'Speak in this voice');
  refFile.addEventListener('change', async () => {
    refBytes = null; cloneOut.replaceChildren(); refresh();
    refBytes = await loadWav(refFile.files?.[0], MAX_REFERENCE_BYTES, 'Reference voice', cloneOut);
    refresh();
  });
  consent.addEventListener('change', refresh);
  cloneText.addEventListener('input', refresh);

  function refresh() {
    const busy = active !== null;
    const speechProblem = checkSpeechText(ttsText.value);
    sttBtn.disabled = busy || !sttBytes;
    speakBtn.disabled = busy || speechProblem !== null;
    cloneBtn.disabled = busy || !refBytes || !consent.checked || checkSpeechText(cloneText.value) !== null;
    cancel.disabled = !busy;
    ttsHint.textContent = speechProblem ?? `${ttsText.value.trim().length}/${MAX_TTS_CHARS}`;
  }

  root.append(
    viewHeader('Audio', 'Transcribe a WAV file or read text aloud on the PS5, through the gateway.'),
    h('section', { class: 'card' }, statusEl, h('div', { class: 'audio-tools' }, cancel)),
    h('section', { class: 'card' },
      h('h2', {}, 'Speech to text'),
      h('p', { class: 'muted' }, 'WAV only, up to 10 MiB.'),
      sttFile, sttBtn, sttOut),
    h('section', { class: 'card' },
      h('h2', {}, 'Text to speech'),
      ttsText, ttsHint, speakBtn, ttsOut),
    h('section', { class: 'card', hidden: !VOICE_CLONE_VISIBLE },
      h('h2', {}, 'Voice clone'),
      h('p', { class: 'muted' }, 'Reference WAV, up to 2 MiB. Use only a voice you have permission to clone.'),
      refFile,
      h('label', { class: 'check', for: 'clone-consent' }, consent, 'I have the speaker\'s permission to clone this voice'),
      cloneText, cloneBtn, cloneOut),
  );
  refresh();

  return () => {
    active?.abort();
    stopStatus();
    root.querySelectorAll('audio').forEach(a => URL.revokeObjectURL(a.src));
  };
}
