<div align="center">

# 🐧 Nexus Desktop for Linux

**[ljcatherine/NexusNix](https://github.com/ljcatherine/NexusNix)** · Rust 1.95+ · egui 0.37 · Nix flake · NixOS 26.05

</div>

An AI IDE and home-lab control room for Linux, built around NixOS. It shares its
design (Midnight Liquid Glass), data formats and security model with the
Windows edition and the iPhone app.

## Features

| Area | What it does |
|---|---|
| **IDE** | Workspace explorer that honours `.gitignore`, `.cursorignore` and `.nexusignore`. Multi-tab editor with highlighting for 15+ languages, multi-cursor, find/replace, minimap, split view and a Git gutter. Quick open, command palette, workspace search, source control, build/test tasks with a Problems list, and terminals for your login shell, Bash, Zsh, Fish and PowerShell. |
| **AI** | Codex (official `codex app-server`) and Claude Code (official CLI) in Ask, Plan, Agent and Bypass modes, plus OpenAI-compatible APIs and NexusAI. Visible context sharing, secret detection, image and PDF attachments, command approvals, hunk-by-hunk review of agent edits, Ctrl+K inline edits, resumable sessions with task memory. |
| **Infrastructure** | Dashboard with live telemetry and alerts, devices with pinned SSH host keys, services, logs, processes and network probes. SSH and SFTP terminals, NixOS dry-build and switch, Debian shadow workspaces, Minecraft and PS5LM status. |
| **Security** | One Rust policy engine for every remote action. The protected Debian server is read-only by default, enforced on the server by `nexus-ro`. The owner can unlock writes for 30 minutes; agents never can. Optional app lock with the iPhone's 4-digit code. |

## Install

Needs Nix with flakes on x86_64 or aarch64 Linux.

```bash
nix run github:ljcatherine/NexusNix
```

On NixOS:

```nix
# flake.nix
inputs.nexus-nix.url = "github:ljcatherine/NexusNix";

# a NixOS module
imports = [ inputs.nexus-nix.nixosModules.default ];
programs.nexus-desktop.enable = true;
```

The module installs the app, a desktop entry, the sign-in URL handler and an XDG
portal. The package is marked unfree; the flake's outputs allow it.

Runtime needs: a Secret Service provider (KWallet or GNOME Keyring) and an XDG
desktop portal. It runs through XWayland by default so the app lock can detect
minimising; `NEXUS_WAYLAND=1` switches to native Wayland.

## Configure

Copy `docs/site.example.json` to `~/.config/nexus-desktop/site.json`, or set
`programs.nexus-desktop.site` in NixOS. See [Configuration](/docs/configuration/#nexus-desktop-linux).

### AI providers

| Provider | Setup |
|---|---|
| OpenAI Codex | Install the Codex CLI, `codex login` |
| Claude Code | Install Claude Code, `claude auth login` |
| OpenAI-compatible | Settings → AI providers; keys go to the Secret Service |
| NexusAI | Settings → AI providers → its LAN URL |

A provider shows **Connected** only after sign-in and a real test turn both succeed.

### Read-only Debian with `nexus-ro`

Build `nexus-ro` from the workspace and install it on the Debian server as a
forced command for the Desktop key. See
[Debian → nexus-ro](/docs/backend/debian/#8-nexus-ro-for-nexus-desktop).

## Build from source

```bash
nix develop
cargo build --release -p nexus-app
cargo test --workspace
nix build            # runs the full test suite in the sandbox, then packages
```

## Crates

`nexus-app` (application) · `nexus-ui` (design system) · `nexus-ide` (editor) ·
`nexus-terminal` (PTY on `alacritty_terminal`) · `nexus-providers` (Codex, Claude
Code, OpenAI-compatible) · `nexus-agents` (sessions, snapshots, memory) ·
`nexus-context` (context rules, secret scan) · `nexus-workspaces` (search, shadow
workspaces) · `nexus-git` · `nexus-security` (policy engine, catalog, audit,
host keys, OTP) · `nexus-ro` (server helper) · `nexus-ssh` · `nexus-access`
(Cloudflare sign-in) · `nexus-telemetry` · `nexus-core` (iOS-compatible device
model, XDG integration).

Docs in the repo: `STATUS`, `PARITY-LINUX`, `PARITY`, `SECURITY-MODEL`, `OTP`,
`BUILD-AND-RELEASE`.
