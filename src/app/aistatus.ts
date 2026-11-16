// PS5 AI status from the gateway (GET /v1/ai/status, proxied by the Worker).
// Gateway strings are untrusted: they are only ever written with textContent.

export type AiState = 'online' | 'offline' | 'busy' | 'switching' | 'loading';
export type StatusLabel = { state: AiState; text: string };

type Parsed = { online: boolean; ready: boolean; busy: boolean; reason: string; warning: string; queue_length: number };

const POLL_MS = 5000;
const MAX_BACKOFF_MS = 60000;

const str = (v: unknown) => typeof v === 'string' ? v.trim().slice(0, 300) : '';

/** Returns null for anything that is not a usable status object. */
function parse(v: unknown): Parsed | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.online !== 'boolean' || typeof o.ready !== 'boolean' || typeof o.busy !== 'boolean') return null;
  return {
    online: o.online, ready: o.ready, busy: o.busy,
    reason: str(o.reason), warning: str(o.warning),
    queue_length: typeof o.queue_length === 'number' && isFinite(o.queue_length) ? o.queue_length : 0,
  };
}

// Gateway `reason` values that mean the PS5 cannot serve (ps5_health.go, ai_status.go).
const OFFLINE_REASONS = new Map([
  ['ps5_offline', 'PS5 is off or unreachable.'],
  ['restart_failed', 'the PS5 server failed to restart.'],
  ['failed', 'the PS5 server reported a failure.'],
  ['no_model', 'no model is loaded on the PS5.'],
  ['media_unavailable', 'PS5 media services are unavailable.'],
]);

const offline = (reason: string): StatusLabel => ({ state: 'offline', text: `Offline: ${reason}` });

/** Maps a gateway status to one label. The reason field decides the state; the warning is display text only. */
export function statusLabel(input: unknown): StatusLabel {
  const s = parse(input);
  if (!s) return offline('status unavailable');
  if (!s.online || OFFLINE_REASONS.has(s.reason)) return offline(OFFLINE_REASONS.get(s.reason) ?? (s.reason || 'unknown reason'));
  if (s.reason === 'switching') return { state: 'switching', text: s.warning || 'Switching engine, about 100 s.' };
  // An unknown reason while not ready is still a load in progress.
  if (s.reason === 'loading' || !s.ready) return { state: 'loading', text: s.warning || 'Loading the model, about 100 s.' };
  const base = s.busy ? (s.queue_length ? `Busy: ${s.queue_length} queued.` : 'Busy.') : 'Online.';
  return { state: s.busy ? 'busy' : 'online', text: [base, s.warning].filter(Boolean).join(' ') };
}

/** Delay before the next poll: 5 s while healthy, doubling after each error, capped at 60 s. */
export function retryDelay(failures: number): number {
  return failures <= 0 ? POLL_MS : Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** failures);
}

async function fetchStatus(): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch('/api/v1/ai/status', { credentials: 'same-origin', redirect: 'manual', headers: { accept: 'application/json' } });
  } catch {
    throw new Error('gateway unreachable');
  }
  if (res.type === 'opaqueredirect') throw new Error('sign-in expired, reload the page');
  if (!res.ok) throw new Error(`gateway error ${res.status}`);
  return res.json().catch(() => { throw new Error('gateway sent an invalid reply'); });
}

/**
 * Polls the status at most every 5 s, only while the document is visible.
 * Returns a cleanup that stops polling.
 */
export function pollAiStatus(onLabel: (label: StatusLabel) => void): () => void {
  let timer = 0, inFlight = false, stopped = false, failures = 0, lastStart = 0;

  const schedule = (ms: number) => { clearTimeout(timer); timer = window.setTimeout(tick, Math.max(0, ms)); };

  async function tick() {
    timer = 0;
    if (stopped || inFlight || document.hidden) return;
    inFlight = true;
    lastStart = Date.now();
    let delay = POLL_MS;
    try {
      const label = statusLabel(await fetchStatus());
      failures = 0;
      if (!stopped) onLabel(label);
    } catch (e) {
      failures++;
      delay = retryDelay(failures);
      if (!stopped) onLabel(offline((e as Error).message));
    } finally {
      inFlight = false;
    }
    if (!stopped && !document.hidden) schedule(delay);
  }

  const onVisibility = () => {
    if (document.hidden) { clearTimeout(timer); timer = 0; return; }
    if (!inFlight && !timer) schedule(POLL_MS - (Date.now() - lastStart));
  };

  onVisibility();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** Keeps `el` showing the PS5 status until the returned cleanup runs. */
export function mountAiStatus(el: HTMLElement): () => void {
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  return pollAiStatus(({ state, text }) => {
    el.dataset.state = state;
    el.textContent = text;
  });
}
