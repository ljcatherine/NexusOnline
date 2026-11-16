// Maps the gateway's PS5 busy answers to fixed client text. Server strings are only matched, never shown.

export const OFFLINE_TEXT = 'The PS5 is offline, so chat is unavailable. Try again once it is back.';
export const QUEUE_FULL_TEXT = 'The PS5 queue is full. Wait a moment and send again.';

/** Seconds from a Retry-After header (delta-seconds or HTTP date), or null. Capped at one hour. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | null {
  const v = value?.trim();
  if (!v) return null;
  const secs = /^\d+$/.test(v) ? Number(v) : (Date.parse(v) - now) / 1000;
  return Number.isFinite(secs) ? Math.min(3600, Math.max(0, Math.ceil(secs))) : null;
}

/** Fixed text for a PS5 offline (503) or queue-full (429) answer, or null for any other answer. */
export function busyText(status: number, retryAfter: string | null, serverError = ''): string | null {
  const base = status === 503 && /offline/i.test(serverError) ? OFFLINE_TEXT
    : status === 429 && /queue/i.test(serverError) ? QUEUE_FULL_TEXT : null;
  if (!base) return null;
  const secs = retryAfterSeconds(retryAfter);
  return secs ? `${base} Retry in about ${secs} s.` : base;
}

/** Gateway error text from `{"error":{"message"}}` or `{"error":"..."}`, clipped to 300 chars; '' otherwise. */
export function errorMessage(body: unknown): string {
  const err = (body as { error?: unknown } | null | undefined)?.error;
  const text = typeof err === 'string' ? err : (err as { message?: unknown } | null | undefined)?.message;
  return typeof text === 'string' ? text.slice(0, 300) : '';
}
