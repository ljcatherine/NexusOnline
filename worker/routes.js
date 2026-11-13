// Gateway routes Nexus Online may call: the same set the iPhone app uses for
// status, AI, PS5 model control and agent runs. Workspace patches/commands,
// conversation writes and unknown routes are denied. The SSH relay
// (/v1/ssh/{debian|nixos}) is a WebSocket and is handled in index.js.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const HEX32 = '[0-9a-f]{32}';
const WORKSPACE = '(?:debian|nixos)/[a-z][a-z0-9_-]{0,31}';
const KB = 1024, MB = 1024 * KB;
const re = s => new RegExp(`^${s}$`);

const ROUTES = [
  ['GET', re('/v1/models')],
  ['GET', re('/v1/context')],
  ['GET', re('/v1/conversations')],
  ['GET', re(`/v1/conversations/${UUID}`)],
  ['GET', re('/v1/nexus/status')],
  ['GET', re('/v1/nexus/models')],
  ['GET', re('/v1/nexus/models/status')],
  ['GET', re('/v1/nexus/agent-runs')],
  ['GET', re('/v1/nexus/agent-runs/active')],
  ['GET', re(`/v1/nexus/agent-runs/${HEX32}`)],
  ['GET', re('/v1/nexus/workspaces')],
  ['GET', re('/v1/nexus/workspaces/(?:debian|nixos)')],
  ['GET', re(`/v1/nexus/workspaces/${WORKSPACE}/files`), { pathQuery: true }],
  ['GET', re(`/v1/nexus/workspaces/${WORKSPACE}/context`), { pathQuery: true, pathRequired: true }],
  ['POST', re('/v1/chat/completions'), { maxBody: 8 * MB }],
  ['POST', re('/v1/chat/completions/input_tokens'), { maxBody: 8 * MB }],
  ['POST', re('/v1/search'), { maxBody: 16 * KB }],
  ['POST', re('/v1/research'), { maxBody: 2 * MB }],
  // iPhone-app controls. These POSTs carry no body.
  ['POST', re('/v1/nexus/models/unload'), { noBody: true }],
  ['POST', re('/v1/nexus/models/[0-9a-f]{16}/load'), { noBody: true }],
  ['POST', re(`/v1/nexus/agent-runs/${HEX32}/cancel`), { noBody: true }],
  ['POST', re(`/v1/nexus/agent-runs/${HEX32}/subagents/${HEX32}/cancel`), { noBody: true }],
  ['POST', re('/v1/nexus/agent-runs'), { maxBody: 2 * MB }],
];

/** SSH relay targets reachable over the WebSocket tunnel. */
export const SSH_TARGET = /^\/v1\/ssh\/(debian|nixos)$/;

/** Returns the route's rules, or null when the web may not call it. */
export function classify(method, path) {
  const hit = ROUTES.find(([m, pattern]) => m === method && pattern.test(path));
  return hit ? { method, ...hit[2] } : null;
}

/** Validates `?path=` for workspace routes (same rules as the gateway Worker). Returns the clean query or null. */
export function workspaceQuery(params, required) {
  const keys = [...params.keys()];
  if (keys.some(k => k !== 'path') || keys.length > 1) return null;
  const path = params.get('path') ?? '';
  if (required && !path) return null;
  if (path.length > 512 || path.startsWith('/') || /[\\\0\r\n]/.test(path)) return null;
  if (path && path.split('/').some(p => !p || p === '.' || p === '..')) return null;
  return keys.length ? `?path=${encodeURIComponent(path)}` : '';
}
