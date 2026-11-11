# Cloudflare

Cloudflare is the only way into the backend from outside your network. This guide
sets up the tunnel, the Workers VPC service, one Access application with Managed
OAuth, the `nexus-gateway` Worker for the apps, and the `nexus-online` Worker for
the browser.

```
                 ┌──────────── Access application (owner email + MFA) ────────────┐
Apps ── HTTPS ──►│ nexus-gateway.<sub>.workers.dev  ──►  nexus-gateway Worker     │──┐
Browser ────────►│ nexus.example.com/app, /api      ──►  nexus-online Worker      │──┤
                 └────────────────────────────────────────────────────────────────┘  │
                                                    Workers VPC service ◄──────────┘
                                                           │ cloudflared (outbound QUIC)
                                                    Debian 127.0.0.1:8787 gateway
```

Workers VPC and Managed OAuth are Cloudflare betas.

## 1. Before you start

- A Cloudflare account with Zero Trust enabled (the free plan works) and a team
  domain, e.g. `your-team.cloudflareaccess.com`.
- A zone for the web client's hostname, if you want one (for example `nexus.example.com`).
- `npx wrangler login` on your computer.
- The Debian server from the [Debian guide](/docs/backend/debian/), with the gateway running on loopback.

## 2. Tunnel and Workers VPC

1. **Zero Trust → Networks → Tunnels → Create a tunnel** (Cloudflared). Copy its
   token into `/etc/nexus-cloudflared/tunnel-token` on Debian and start
   `nexus-cloudflared` ([Debian step 9](/docs/backend/debian/#9-cloudflare-tunnel)).
2. Don't add any public hostname to the tunnel. Nothing should be reachable
   through it except via the VPC service.
3. **Workers → VPC → Create a VPC service** targeting the tunnel with origin
   `http://127.0.0.1:8787`. Copy the **service ID**.

The tunnel needs `cloudflared` 2025.7.0+ and outbound UDP 7844.

## 3. Access application

**Zero Trust → Access → Applications → Add → Self-hosted**:

| Setting | Value |
|---|---|
| Hostnames | `nexus-gateway.<subdomain>.workers.dev` (the Worker from step 5). Add the Online paths in step 6. |
| Policy | **Allow**, *Include* → **Emails** → your exact address. Add *Require* → an MFA method. |
| Session duration | 8 hours or less |
| Cookies | HTTP Only and Binding cookie on |
| Managed OAuth | **On**. Access token lifetime 15 minutes, grant session one week |
| Allowed redirect URIs | `https://nexus-gateway.<subdomain>.workers.dev/oauth2redirect` |

Use a **hostname-based** application. Worker-level Access rejects WebSocket
upgrades, which breaks the SSH relay. Avoid "Cloudflare account" or email-domain
policies, which let in more people than you.

Copy the **Application Audience (AUD) tag**.

## 4. Register the public OAuth client

From a NexusiOS checkout:

```bash
python3 scripts/register-cloudflare-access-client.py \
  https://your-team.cloudflareaccess.com \
  --resource-url https://nexus-gateway.<subdomain>.workers.dev
```

It prints a public client ID for PKCE. It's an identifier, not a secret: there is
no client secret, and none goes in any app.

## 5. `nexus-gateway` Worker

From [NexusiOS `cloudflare/`](https://github.com/ljcatherine/NexusiOS/tree/main/cloudflare):

```bash
cd cloudflare
cp wrangler.example.jsonc wrangler.jsonc       # git-ignored
node --test worker.test.mjs
```

In `wrangler.jsonc`, set `vpc_services[0].service_id` to the ID from step 2,
keep `preview_urls: false`, and set `workers_dev: true` to serve on
`*.workers.dev`. If you manage variables in the dashboard, add `"keep_vars": true`
and remove the `vars` block so deploys don't overwrite them.

```bash
npx wrangler deploy
```

Then in **Workers & Pages → nexus-gateway → Settings → Variables and Secrets**
(runtime, not build variables):

| Variable | Value |
|---|---|
| `ACCESS_AUDIENCE` | AUD tag from step 3 |
| `OWNER_EMAIL` | Your email, lowercase |

The Worker answers `403` until both are set. It accepts only fixed AI routes, the
`/v1/ssh/{alias}` WebSocket for the aliases you configured, `/oauth2redirect`, and
the Minecraft panel root. It forwards only Cloudflare's signed
`Cf-Access-Jwt-Assertion`.

### Gateway settings that must match

| Gateway (`nexus.env`) | Cloudflare |
|---|---|
| `NEXUS_OIDC_ISSUER` | `https://your-team.cloudflareaccess.com` |
| `NEXUS_OIDC_AUDIENCE` | The AUD tag (not the Worker URL) |
| `NEXUS_OIDC_JWKS_URL` | `https://your-team.cloudflareaccess.com/cdn-cgi/access/certs` |
| `NEXUS_SUBJECT_PERMISSIONS_JSON` key | `OWNER_EMAIL` |

## 6. Nexus Online Worker

From [NexusOnline](https://github.com/ljcatherine/NexusOnline):

1. In the **same** Access application, add the hostnames `nexus.example.com/app`
   and `nexus.example.com/api`. Don't add the bare hostname, so the landing page
   stays public. Using the same application means the gateway accepts the web
   tokens with no change on Debian.
2. Configure and deploy:

   ```bash
   cp wrangler.example.jsonc wrangler.jsonc
   # routes[0].pattern     nexus.example.com (custom domain)
   # ACCESS_TEAM_DOMAIN    your-team.cloudflareaccess.com
   # ACCESS_AUDIENCE       the AUD tag
   # OWNER_EMAIL           your email
   # vpc_services[0].service_id  same ID as the gateway Worker
   npm install && npm run deploy
   ```

3. Attach the hostname as a **Custom Domain** on the Worker, or as a route in your zone.

The Worker verifies the Access JWT itself (RS256, issuer, audience, expiry, email)
and forwards only read and inference routes.

## 7. Check it

| Check | Expected |
|---|---|
| `curl -i https://nexus-gateway.<sub>.workers.dev/v1/models` | Access redirect or `401`/`403`, never data |
| Sign in from Nexus for iPhone, load models | Model list |
| Open an SSH relay profile | Relay host-key prompt, then a shell |
| `https://nexus.example.com/` in a private window | Landing page, no sign-in |
| `https://nexus.example.com/app` | Access sign-in, then the overview |
| Another account | Refused by Access and by the Worker |
| `POST /api/v1/nexus/models/unload` from the browser console | `403` |

## 8. Hardening and recovery

- **WAF → Rate limiting**: e.g. 120 requests a minute per IP on `/api/*` and `/v1/*`.
- **SSL/TLS**: minimum TLS 1.2, Always Use HTTPS.
- Keep preview URLs off on both Workers.
- **Diagnosing 403s**: the gateway Worker logs only booleans (variables set,
  audience match, identity match) to Worker Observability, never emails, tokens
  or cookies.
- **Roll back** a Worker with `npx wrangler rollback`.
- **Cut access instantly** by disabling the Access application, removing the VPC
  binding, or stopping `nexus-cloudflared` on Debian.
