// Verifies the Cloudflare Access application token (Cf-Access-Jwt-Assertion).
// Access already blocks unauthenticated requests at the edge; this is the second,
// independent check, so a missing or misconfigured Access policy fails closed.
const enc = new TextEncoder();
const dec = new TextDecoder();
const TEAM = /^[a-z0-9-]{1,63}\.cloudflareaccess\.com$/;
const JWKS_TTL = 10 * 60_000, REFETCH_FLOOR = 60_000;
let jwks = { url: '', at: 0, keys: new Map() };

function b64url(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
}

async function signingKey(url, kid) {
  const age = Date.now() - jwks.at;
  const stale = jwks.url !== url || age > JWKS_TTL;
  // An unknown kid may mean key rotation: refetch, but at most once a minute.
  if (stale || (!jwks.keys.has(kid) && age > REFETCH_FLOOR)) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`JWKS ${res.status}`);
    const { keys } = await res.json();
    const map = new Map();
    for (const k of Array.isArray(keys) ? keys : []) {
      if (k?.kty !== 'RSA' || typeof k.kid !== 'string' || (k.alg && k.alg !== 'RS256')) continue;
      map.set(k.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    }
    jwks = { url, at: Date.now(), keys: map };
  }
  return jwks.keys.get(kid) ?? null;
}

/** Test hook: forget cached keys. */
export function resetKeyCache() { jwks = { url: '', at: 0, keys: new Map() }; }

/**
 * Returns { email, exp } when the token is a valid Access token for this
 * application and belongs to the owner; otherwise null. Never throws.
 */
export async function verifyAccess(token, env, now = Date.now() / 1000) {
  try {
    const team = String(env.ACCESS_TEAM_DOMAIN ?? '').trim().toLowerCase();
    const audience = String(env.ACCESS_AUDIENCE ?? '').trim();
    const owner = String(env.OWNER_EMAIL ?? '').trim().toLowerCase();
    if (!TEAM.test(team) || !/^[a-f0-9]{64}$/.test(audience) || !owner.includes('@')) return null;

    if (typeof token !== 'string' || token.length > 16_384) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) return null;
    const header = JSON.parse(dec.decode(b64url(parts[0])));
    const claims = JSON.parse(dec.decode(b64url(parts[1])));
    if (header?.alg !== 'RS256' || typeof header.kid !== 'string') return null;

    const key = await signingKey(`https://${team}/cdn-cgi/access/certs`, header.kid);
    if (!key) return null;
    const signed = enc.encode(`${parts[0]}.${parts[1]}`);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), signed)) return null;

    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!auds.includes(audience)) return null;
    if (claims.iss !== `https://${team}`) return null;
    if (typeof claims.exp !== 'number' || claims.exp <= now) return null;
    if (typeof claims.nbf === 'number' && claims.nbf > now + 60) return null;
    if (typeof claims.iat === 'number' && claims.iat > now + 60) return null;
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
    if (email !== owner) return null;
    return { email, exp: claims.exp };
  } catch {
    return null;
  }
}
