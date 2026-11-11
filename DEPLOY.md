# Deploying Nexus Online

Nexus Online is one Cloudflare Worker with the built site as static assets.

| Path | Who can open it | Checked by |
|---|---|---|
| `/`, `/_astro/*` | Anyone | — |
| `/app/*` | Owner only | Cloudflare Access, then the Worker verifies the Access token |
| `/api/v1/*` | Owner only | Same, then the route allowlist, then the gateway verifies the token again |

The Worker checks the Access token's signature, issuer, audience, expiry and email
on every `/app` and `/api` request. If Access is missing, misconfigured or the
Worker's settings are empty, those paths answer **401**. They fail closed.

`/api` forwards only the routes Nexus Desktop classes as read or inference
(`worker/routes.js`). Writes, model load/unload, agent run start/cancel, patches,
commands and the SSH relay are refused before they reach the gateway.

## Before you start

You need the pieces the iPhone app already uses:

- The Cloudflare Access application in front of the `nexus-gateway` Worker.
- The VPC service that connects Cloudflare to the gateway on Debian.

Nexus Online reuses both. The gateway accepts one Access audience
(`NEXUS_OIDC_AUDIENCE`), so the web app must sit in the **same** Access
application. This needs no change on Debian.

## 1. Pick a hostname

For example `online.yourdomain`, in the same Cloudflare zone.

## 2. Add the hostname to the existing Access application

In Zero Trust → Access → Applications, open the application the gateway
Worker uses. Add two public hostnames:

- `online.yourdomain/app`
- `online.yourdomain/api`

Do not add the bare hostname. The landing page stays public.

Recommended on the same application:

- **Policy:** Allow, include only your email. Add **Require** → an
  authentication method with MFA (a hardware key or authenticator app).
- **Session duration:** 8 hours or less.
- **Cookie settings:** turn on *HTTP Only* and *Binding cookie*.

Copy the **Application Audience (AUD) tag** from the application's overview.

## 3. Fill in the Worker config

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

`wrangler.jsonc` is git-ignored. Replace the five values:

| Setting | Where to find it |
|---|---|
| `routes[0].pattern` | Your hostname from step 1 |
| `ACCESS_TEAM_DOMAIN` | Zero Trust → Settings → Custom pages, e.g. `yourteam.cloudflareaccess.com` |
| `ACCESS_AUDIENCE` | The AUD tag from step 2 |
| `OWNER_EMAIL` | The one email allowed in |
| `vpc_services[0].service_id` | The same ID as in the `nexus-gateway` Worker's config |

## 4. Deploy

```bash
npx wrangler login
```

```bash
npm run deploy
```

`npm run deploy` runs the Worker security tests, builds the site and deploys.
It stops if a test fails.

## 5. Check it

1. In a private window, open `https://online.yourdomain/`. It loads without sign-in.
2. Open `/app`. Cloudflare Access asks you to sign in. Sign in as the owner. The overview loads.
3. Sign in as any other account. Access refuses it, and so does the Worker.
4. Signed in, run this in the browser console. It should print `403`:
   ```js
   (await fetch('/api/v1/nexus/models/unload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status
   ```
5. Check the response headers of `/app/`: `content-security-policy`,
   `x-frame-options: DENY` and `cache-control: no-store, private`.

## Optional hardening in the Cloudflare dashboard

- **WAF → Rate limiting:** for example 120 requests per minute per IP on `online.yourdomain/api/*`.
- **SSL/TLS:** minimum TLS 1.2, *Always Use HTTPS* on.

## Undo

- `npx wrangler rollback` returns to the previous version.
- Removing the two hostnames from the Access application blocks `/app` and `/api`
  immediately. The Worker then answers 401.

## Try it locally

```bash
npm run build
```

```bash
npm run preview:worker
```

This runs the real Worker at `http://localhost:8788` with sample data and a
locally signed token. `SIGNED_OUT=1 npm run preview:worker` shows the sign-in
page. `scripts/preview.mjs` is never deployed.
