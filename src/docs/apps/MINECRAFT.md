<div align="center">

# ⛏️ Nexus Minecraft

**[ljcatherine/NexusMinecraft](https://github.com/ljcatherine/NexusMinecraft)** · React · TypeScript · FastAPI · Debian

</div>

A private control room for Minecraft servers that already run as systemd units on the
Debian server. It shows every server's state, players, memory, CPU and uptime, streams the
console, and manages players, files, backups and extensions. The systemd units stay the
source of truth: the panel never replaces your units, worlds or backup timer, and anything it
can't measure reads "Unavailable" instead of a made-up number.

## Features

| Page | What it does |
|---|---|
| **Dashboard** | Every server at a glance, plus live host CPU and memory charts |
| **Servers** | Start, stop and restart through the existing units, with confirmation before players are disconnected |
| **Console** | Live journal output with search and severity filters; commands go over loopback RCON |
| **Players** | Online players, whitelist, ops and bans, each action confirmed |
| **Files** | Browse and edit server files with revision checks and path confinement |
| **Backups** | The existing nightly maintenance sets, inspection and logs |
| **Extensions** | Installed plugins or Forge mods, and trusted JAR uploads |
| **Diagnostics** | Read-only checks of units, paths, permissions and RCON |
| **Accounts** | Admin and viewer accounts, single-use invitations and an audit log |

## How it's reached

```
Browser ──► Cloudflare Access (Nexus sign-in) ──► nexus-gateway Worker (panel hostname only)
        ──► Workers VPC ──► cloudflared ──► gateway 127.0.0.1:8787 ──► panel 127.0.0.1:8080
```

The panel listens on loopback and has its own login, CSRF checks and sessions. It's
published on its own hostname, such as `minecraft.example.com`, through the `nexus-gateway`
Worker with `PANEL_HOSTNAME` set. That hostname serves only the panel, and the Worker strips
Cloudflare's cookies before forwarding. A visitor passes Cloudflare Access, the Worker's
owner check, the gateway's verification and then the panel's own sign-in.

## Set it up

1. **Install the panel** on the Debian server from a release build: review and run
   `deploy/install.sh`, create your account with `panel.cli user <name>`, then configure RCON
   with `deploy/configure-rcon.py`. The [README](https://github.com/ljcatherine/NexusMinecraft#install)
   has the full steps.
2. **Point the gateway at it**: set `NEXUS_MINECRAFT_PANEL_ORIGIN` and
   `NEXUS_MINECRAFT_PUBLIC_ORIGIN`, and grant `minecraft.panel`. See the
   [Debian backend](/docs/backend/debian/) guide.
3. **Give it its own hostname**: add a custom domain to the `nexus-gateway` Worker and set
   `PANEL_HOSTNAME`. See [Cloudflare](/docs/backend/cloudflare/).

[Publish with Cloudflare](https://github.com/ljcatherine/NexusMinecraft/blob/main/docs/CLOUDFLARE.md)
in the repo walks through each setting and how to check it.

## Security notes

- Never forward the panel, RCON or Minecraft ports to the internet.
- State-changing requests need a matching origin and CSRF token; file operations stay inside each server's root.
- Privileged actions go through a root helper that hard-codes the allowed units.
- The repo's [security folder](https://github.com/ljcatherine/NexusMinecraft/tree/main/security) has the threat model, audits and test results.
