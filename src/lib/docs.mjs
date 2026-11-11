// Shared by scripts/sync-docs.mjs (link rewriting) and src/pages/docs (routes, sidebar).
import path from 'node:path';

export const REPO = 'https://github.com/ljcatherine/Nexus';

/** 'apps/IOS.md' -> 'apps/ios', 'README.md' -> '' */
export function docSlug(rel) {
  return rel.replace(/\\/g, '/').replace(/(^|\/)README\.md$/i, '').replace(/\.md$/i, '').toLowerCase().replace(/\/$/, '');
}

export const docHref = (slug) => `/docs/${slug ? `${slug}/` : ''}`;

/** Rewrites a link found in docs/<from> so it works on the site. */
export function rewriteLink(url, from) {
  if (/^([a-z][a-z0-9+.-]*:|#|\/)/i.test(url)) return url;
  const [target, hash] = url.split('#');
  const h = hash ? `#${hash}` : '';
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(from.replace(/\\/g, '/')), target));
  if (resolved.startsWith('..')) return `${REPO}/blob/main/${resolved.replace(/^(\.\.\/)+/, '')}${h}`;
  if (/\.md$/i.test(resolved)) return docHref(docSlug(resolved)) + h;
  return `${REPO}/blob/main/docs/${resolved}${h}`;
}

/** Sidebar order. Pages missing here still build and are listed under "More". */
export const NAV = [
  ['Start', [['', 'Overview'], ['setup', 'Full setup']]],
  ['Apps', [['apps/ios', 'NexusiOS'], ['apps/linux', 'NexusNix (Linux)'], ['apps/windows', 'Nexus Desktop for Windows'], ['apps/online', 'Nexus Online']]],
  ['Backend', [['backend/debian', 'Debian server'], ['backend/cloudflare', 'Cloudflare'], ['backend/nexusai', 'NexusAI']]],
  ['Reference', [['architecture', 'Architecture'], ['security', 'Security'], ['configuration', 'Configuration']]],
];
