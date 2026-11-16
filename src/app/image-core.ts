// Pure helpers for the image view: request building, PNG check, SSE splitting, progress text.
// No DOM access, so they run under node --test.
import { errorMessage } from './queue.ts';

/** Model folders the gateway serves. '' lets the server pick its default. Must match the gateway allow-list (U-22). */
export const IMAGE_MODELS = [
  { id: '', label: 'Server default' },
  { id: 'sd-turbo-fp16', label: 'SD Turbo (fast)' },
  { id: 'flux2-klein-4b', label: 'FLUX.2 klein 4B' },
] as const;

export const IMAGE_SIZES = ['512x512', '768x768', '1024x1024', '768x512', '512x768'] as const;
export const MAX_PROMPT = 2000;

/** Validates the form and returns the JSON body for POST /v1/images/generations. Throws RangeError with user-facing text. */
export function buildImageRequest(input: { prompt: string; model: string; size: string }): string {
  const prompt = input.prompt.trim();
  if (!prompt) throw new RangeError('Describe the image first.');
  if (prompt.length > MAX_PROMPT) throw new RangeError(`The prompt is over ${MAX_PROMPT} characters.`);
  if (!(IMAGE_SIZES as readonly string[]).includes(input.size)) throw new RangeError('Choose a size preset.');
  if (!IMAGE_MODELS.some(m => m.id === input.model)) throw new RangeError('That model is not available.');
  const body: Record<string, unknown> = { prompt, size: input.size, stream: true };
  if (input.model) body.model = input.model;
  return JSON.stringify(body);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** True when the base64 text is well formed and decodes to bytes starting with the PNG signature. */
export function isPngBase64(b64: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4) return false;
  const head = atob(b64.slice(0, 12)); // 12 base64 chars = 9 bytes, enough for the 8-byte signature
  return PNG_SIGNATURE.every((byte, i) => head.charCodeAt(i) === byte);
}

/** Splits complete SSE events off the buffer and returns their data payloads plus the unfinished tail. */
export function splitSse(buffer: string): { events: string[]; rest: string } {
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  const events = parts
    .map(p => p.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n'))
    .filter(Boolean);
  return { events, rest };
}

/** One line for a progress event from the gateway, or null for events the view does not show. */
export function describeProgress(ev: any): string | null {
  switch (ev?.status) {
    case 'loading': return `Loading the model: ${Number(ev.progress) || 0}%`;
    case 'preparing':
    case 'generating': return `Generating: step ${Number(ev.step) || 0} of ${Number(ev.steps) || 0}`;
    case 'decoding': return 'Decoding the image…';
    case 'unloading': return 'Unloading speech models to free memory…';
    default: return null;
  }
}

/** Returns the base64 PNG from a final response, or throws with the gateway's error text. */
export function pngFromResponse(body: any): string {
  if (body?.error || (typeof body?.http_status === 'number' && body.http_status >= 400)) {
    throw new Error(errorMessage(body) || 'Image generation failed.');
  }
  const b64 = body?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || !isPngBase64(b64)) throw new Error('The gateway did not return a PNG image.');
  return b64;
}

