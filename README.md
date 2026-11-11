# Nexus Online

The browser client for the Nexus ecosystem, next to NexusiOS, NexusNix and
Nexus Desktop for Windows. Live at **https://nexus.liamjc.dev**.

Setup guides for the whole ecosystem are in [ljcatherine/Nexus](https://github.com/ljcatherine/Nexus)
and on the site at [nexus.liamjc.dev/docs](https://nexus.liamjc.dev/docs/).

- **`/`** is a public landing page with scroll animations.
- **`/docs`** renders the Nexus docs, synced from `ljcatherine/Nexus` with `npm run docs`.
- **`/app`** is an owner-only web app: NexusAI status, AI chat, read-only
  workspace files, PS5 models, agent runs and a security page.

It runs as one Cloudflare Worker that serves the built Astro site and proxies
a small set of read-only routes to the Nexus gateway on Debian.

## How it is secured

```
Browser ──► Cloudflare Access ──► nexus-online Worker ──► VPC service ──► Nexus gateway (Debian) ──► NexusAI / orchestrator
            (owner sign-in)       (token check + allowlist)                (token check + permissions)
```

1. **Cloudflare Access** guards `/app` and `/api`. It is the same Access
   application as the `nexus-gateway` Worker, so the gateway accepts its tokens.
2. **The Worker** (`worker/access.js`) verifies every Access token itself:
   RS256 signature against the team's keys, issuer, audience, expiry and the
   owner's email. Missing or wrong settings fail closed with 401.
3. **The route allowlist** (`worker/routes.js`) mirrors Nexus Desktop's gateway
   classifier: only read and inference routes are forwarded. Writes, model
   load/unload, agent run start/cancel, patches, commands and the SSH relay are
   refused before they reach the gateway.
4. **Request checks:** posts must be same-origin JSON within a size limit.
   Workspace paths are validated. Only the Access assertion is forwarded, never cookies.
5. **Headers:** strict CSP (no inline scripts), `frame-ancestors 'none'`, HSTS,
   and `no-store` on everything behind sign-in.
6. **In the browser:** gateway data is rendered as text, never HTML. Chats stay in
   `sessionStorage` unless you choose to keep them. Files that usually hold
   secrets (`.env`, keys) are never sent to the AI.

The web cannot write anything. SSH terminals, host metrics, the editor and
Codex/Claude Code stay in Nexus Desktop; model loading and agent runs stay in
the iPhone app.

## Layout

| Path | What it holds |
|---|---|
| `src/pages/index.astro` | Landing page: orbit hero, pinned client tour, diagram, security section |
| `src/pages/app/index.astro` | Web app shell and styles |
| `src/pages/docs/[...slug].astro`, `src/lib/docs.mjs` | Docs pages, sidebar and link rewriting |
| `src/docs/` | Copy of the Nexus docs (`npm run docs` refreshes it) |
| `src/app/` | Web app screens: `overview`, `chat`, `files`, `models`, `runs`, `settings` |
| `src/layouts/Base.astro`, `src/styles/global.css` | Shared layout, Midnight Liquid Glass tokens, scroll-animation fallback |
| `public/motion.js` | Applies the visitor's animation choice before first paint |
| `worker/` | Cloudflare Worker, Access verification, route allowlist, tests |
| `scripts/preview.mjs` | Local preview of the real Worker with sample data |
| `mockups/` | Original design concept |
| `DEPLOY.md` | Cloudflare setup and deployment steps |

## Develop

Needs Node 22 or newer.

```bash
npm install
```

```bash
npm test
```

```bash
npm run build && npm run preview:worker
```

`npm run preview:worker` serves the real Worker at http://localhost:8788 with a
sample gateway and a locally signed token. Set `SIGNED_OUT=1` to see the
sign-in page. `npm run dev` serves only the pages, without the Worker.

## Deploy

See [DEPLOY.md](DEPLOY.md). In short: copy `wrangler.example.jsonc` to the
git-ignored `wrangler.jsonc`, fill in the hostname, Access team domain, AUD tag,
owner email and VPC service ID, then run `npm run deploy` (tests, build, deploy).

## Known issues

- `/v1/models` and `/v1/context` return 502 from the gateway against NexusAI v0.8.3,
  while chat works. The chat model picker falls back to the PS5's loaded model,
  and the context meter stays blank.
- Synced iPhone conversations return 403: the gateway does not grant the web
  sign-in conversation history.
