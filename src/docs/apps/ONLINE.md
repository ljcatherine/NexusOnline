<div align="center">

# 🌐 Nexus Online

**[ljcatherine/NexusOnline](https://github.com/ljcatherine/NexusOnline)** · Astro 7 · Cloudflare Workers · live at **[nexus.liamjc.dev](https://nexus.liamjc.dev)**

</div>

The browser client. One Cloudflare Worker serves the built Astro site and
proxies a small set of read-only routes to the Nexus gateway.

| Path | Who | Contents |
|---|---|---|
| `/` | Anyone | Landing page with an orbit hero, a pinned client tour, a diagram and the security story |
| `/app` | Owner only | NexusAI status, AI chat, read-only workspace files, PS5 models, agent runs and a security page |
| `/api/v1/*` | Owner only | Allowlisted read and inference routes to the gateway |

## How it is secured

```
Browser ──► Cloudflare Access ──► nexus-online Worker ──► VPC service ──► gateway ──► NexusAI / orchestrator
            (owner sign-in)       (JWT check + allowlist)               (JWT check + permissions)
```

1. **Access** guards `/app` and `/api`, in the same application as the gateway Worker.
2. **The Worker verifies every token itself**: RS256 signature against the team keys, issuer, audience, expiry and owner email. Missing settings fail closed with 401.
3. **Route allowlist** mirrors Nexus Desktop's gateway classifier. Writes, model load/unload, agent run start/cancel, patches, commands and the SSH relay are refused.
4. **Request checks**: same-origin JSON within a size limit, validated workspace paths, only the Access assertion forwarded.
5. **Headers**: strict CSP with no inline scripts, `frame-ancestors 'none'`, HSTS, `no-store` behind sign-in.
6. **Browser**: gateway data is rendered as text, chats stay in `sessionStorage` unless kept, and files that usually hold secrets are never sent to the AI.

## Develop

Needs Node 22+.

```bash
npm install
npm test
npm run build && npm run preview:worker   # real Worker on :8788 with sample data
```

`SIGNED_OUT=1 npm run preview:worker` shows the sign-in page.

## Deploy

1. Add `<your-host>/app` and `<your-host>/api` to the **existing** Access
   application used by the gateway Worker. Don't add the bare hostname: the
   landing page stays public.
2. `cp wrangler.example.jsonc wrangler.jsonc` and set the route pattern,
   `ACCESS_TEAM_DOMAIN`, `ACCESS_AUDIENCE`, `OWNER_EMAIL` and the same VPC
   `service_id` as the gateway Worker.
3. `npx wrangler login`, then `npm run deploy` (tests, build, deploy).
4. Check: `/` loads signed out, `/app` asks for sign-in, other accounts are refused,
   and a `POST /api/v1/nexus/models/unload` from the console returns `403`.

Full steps, hardening and rollback are in the repo's `DEPLOY.md` and in
[Cloudflare → Nexus Online](/docs/backend/cloudflare/#6-nexus-online-worker).
