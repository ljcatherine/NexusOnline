# Configuration

Each app keeps deployment-specific values out of its source. Without them,
every app still works against hosts and AI endpoints you add by hand; only the
Cloudflare relay and Access sign-in stay off.

You need three values from your [Cloudflare setup](/docs/backend/cloudflare/):

| Value | Example | Where it comes from |
|---|---|---|
| Worker host | `nexus-gateway.example.workers.dev` | The `nexus-gateway` Worker |
| Access issuer | `https://your-team.cloudflareaccess.com` | Zero Trust team domain |
| Access client ID | `00000000-0000-0000-0000-000000000000` | `register-cloudflare-access-client.py` (public, not a secret) |

## Nexus for iPhone

Copy [`Config/deployment.example.plist`](https://github.com/ljcatherine/NexusiOS/blob/main/Config/deployment.example.plist)
to the ignored `local/deployment.plist`. `scripts/xtool-build.sh` merges it into
that build's Info.plist.

| Key | Value |
|---|---|
| `NexusGatewayHost` | Worker host |
| `NexusAccessIssuer` | Access issuer |
| `NexusAccessClientID` | Access client ID |
| `NexusDefaultAIEndpoint` | Optional prefilled NexusAI URL |
| `NexusRelayDevices` | Optional `{name, username, target}` relay devices |

Or leave it out and enter the same values in **Settings → API Connections**.

## Nexus Desktop (Linux)

Copy [`docs/site.example.json`](https://github.com/ljcatherine/NexusNix/blob/main/docs/site.example.json)
to `~/.config/nexus-desktop/site.json`, or set `programs.nexus-desktop.site = { … };`
in the NixOS module.

| Field | Value |
|---|---|
| `gateway_host` | Worker host |
| `access_issuer` | Access issuer |
| `access_client_id` | Access client ID |
| `debian_user` | SSH account on the read-only Debian server |
| `nixos_user` | SSH account on the NixOS machine |

## Nexus Desktop (Windows)

The Windows build currently compiles the Worker host and Access issuer into
[`crates/nexus-access`](https://github.com/ljcatherine/NexusWindows/tree/main/crates/nexus-access).
For your own deployment, change them there and rebuild. A `site.json` like the
Linux edition's is the planned replacement. API keys and the Access session
go to Windows Credential Manager (DPAPI).

## Nexus Online

Copy `wrangler.example.jsonc` to the ignored `wrangler.jsonc` in
[NexusOnline](https://github.com/ljcatherine/NexusOnline) and set the route
hostname, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUDIENCE`, `OWNER_EMAIL` and the VPC
`service_id`. See [Nexus Online](/docs/apps/online/#deploy).

## Backend

| File | Template | Guide |
|---|---|---|
| Gateway `nexus.env` | [`gateway/.env.example`](https://github.com/ljcatherine/NexusBackend/blob/main/gateway/.env.example) | [Debian](/docs/backend/debian/#4-gateway) |
| Workspace agent env | [`workspace-agent/.env.example`](https://github.com/ljcatherine/NexusBackend/blob/main/workspace-agent/.env.example) | [Debian](/docs/backend/debian/#7-workspace-agents) |
| `cloudflare/wrangler.jsonc` | [`wrangler.example.jsonc`](https://github.com/ljcatherine/NexusBackend/blob/main/cloudflare/wrangler.example.jsonc) | [Cloudflare](/docs/backend/cloudflare/#5-nexus-gateway-worker) |

Keep every real config file out of Git and owner-only (`chmod 600`).
