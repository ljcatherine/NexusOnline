# Architecture

Nexus is four clients and one optional backend. The clients talk directly to
your hosts over LAN or Tailscale. The backend adds owner-only remote access
through Cloudflare without opening inbound ports.

## Components

| Component | Runs on | Source | Role |
|---|---|---|---|
| Nexus for iPhone | iPhone, iPad (iOS 17+) | [NexusiOS `App/`](https://github.com/ljcatherine/NexusiOS/tree/main/App) | Mobile client |
| Nexus Desktop | NixOS / Linux | [NexusNix](https://github.com/ljcatherine/NexusNix) | IDE, agents, infrastructure |
| Nexus Desktop | Windows 10/11 | [NexusWindows](https://github.com/ljcatherine/NexusWindows) | IDE, agents, infrastructure |
| Nexus Online | Cloudflare Worker | [NexusOnline](https://github.com/ljcatherine/NexusOnline) | Landing page and read-only web client |
| `nexus-gateway` Worker | Cloudflare | [NexusiOS `cloudflare/`](https://github.com/ljcatherine/NexusiOS/tree/main/cloudflare) | Fixed-route front door for the apps |
| Nexus gateway | Debian, `127.0.0.1:8787` | [NexusiOS `gateway/`](https://github.com/ljcatherine/NexusiOS/tree/main/gateway) | Identity, permissions, AI, SSH relay, search, sync |
| `cloudflared` | Debian | Cloudflare | Outbound-only tunnel to Workers VPC |
| Agent orchestrator | Debian, `127.0.0.1:8897` | [NexusiOS `agent-orchestrator/`](https://github.com/ljcatherine/NexusiOS/tree/main/agent-orchestrator) | Durable agent runs, approvals, context |
| Workspace agent | Debian and NixOS, `127.0.0.1:8896` | [NexusiOS `workspace-agent/`](https://github.com/ljcatherine/NexusiOS/tree/main/workspace-agent) | Read-only workspace bridge |
| `nexus-ro` | Debian | [NexusNix `crates/nexus-ro`](https://github.com/ljcatherine/NexusNix/tree/main/crates/nexus-ro) | SSH forced command, read-only catalog |
| NexusAI | PS5, `:8081` and `:8082` | [ljcatherine/NexusAI](https://github.com/ljcatherine/NexusAI) | Local LLM inference and model control |

## Request paths

### Direct (no backend)

```
App ──SSH (pinned host key)──► host on LAN / Tailscale
App ──HTTP(S)──► AI endpoint on a private address
```

Each app stores its own devices, endpoints and keys. Nothing goes through
Cloudflare.

### Through the gateway

```
App ──HTTPS──► Cloudflare Access (Managed OAuth, PKCE)
             ──► nexus-gateway Worker (checks ctx.access, fixed routes)
             ──► Workers VPC service ──► cloudflared on Debian
             ──► gateway 127.0.0.1:8787 (verifies Cf-Access-Jwt-Assertion, permissions)
             ──► PS5 :8081 / :8082, orchestrator :8897, SSH targets, search
```

### Nexus Online

```
Browser ──► Cloudflare Access (/app, /api only)
        ──► nexus-online Worker (verifies the Access JWT itself, route allowlist)
        ──► same Workers VPC service ──► gateway
```

Nexus Online sits in the **same** Access application as the gateway Worker, so
the gateway accepts its tokens without any change on Debian.

### SSH relay

```
App ──WebSocket /v1/ssh/{alias}──► Worker ──► gateway
gateway ──SSH (server-held Ed25519 key, strict known_hosts)──► target alias
```

The app pins the relay's own SSH host key and sends no client key. Targets are
fixed aliases in `NEXUS_SSH_TARGETS_JSON`; callers can't pick a host or user.

### Desktop to Debian

```
Desktop ──SSH, forced command──► nexus-ro (read-only catalog)
```

## Ports

| Port | Bound to | Service |
|---|---|---|
| 22 | LAN, Tailscale | OpenSSH (key-only after hardening) |
| 8787 | 127.0.0.1 | Nexus gateway |
| 8896 | 127.0.0.1 | Workspace agent |
| 8897 | 127.0.0.1 | Agent orchestrator |
| 8080 | 127.0.0.1 | Minecraft panel (optional) |
| 8081 | PS5 LAN | NexusAI llama-server |
| 8082 | PS5 LAN, opt-in | NexusAI model-control API |
| 7844/udp | outbound | `cloudflared` QUIC to Cloudflare |

Nothing listens publicly. Never port-forward any of these.

## Data and credentials

| Where | What |
|---|---|
| iOS Keychain | SSH keys, host pins, API and OAuth tokens, OTP secret |
| Windows Credential Manager / Linux Secret Service | API keys, SSH passphrases, app-lock secret |
| Debian `nexus.env` (0600) | Gateway policy, upstream tokens, encryption key |
| Debian gateway SSH directory (0600) | Relay host key, upstream key, `known_hosts` |
| PS5 `nexus-control.token` (0600) | SHA-256 of the control token, never the token |
| Cloudflare runtime variables | Access AUD tag and owner email (identifiers, not secrets) |
