// Gateway routes Nexus Online may call. Mirrors Nexus Desktop's classifier
// (NexusWindows crates/nexus-security/src/gateway.rs): only Read and Inference
// routes pass. Mutations, the SSH relay and unknown routes are denied.
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
];

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
