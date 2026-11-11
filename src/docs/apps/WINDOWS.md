<div align="center">

# 🪟 Nexus Desktop for Windows

**[ljcatherine/NexusWindows](https://github.com/ljcatherine/NexusWindows)** · Rust stable (MSVC) · egui 0.37 · Windows 10/11 x64

</div>

The Windows edition of Nexus Desktop: the same IDE, AI agents and infrastructure
tools as the Linux edition, with native Windows terminals and credential storage.

## Features

| Area | What it does |
|---|---|
| **IDE** | Explorer honouring `.gitignore`, `.cursorignore` and `.nexusignore`. Multi-tab editor, 15+ languages, multi-cursor, find/replace, minimap, split view, Git gutter, quick open, command palette, search, source control, tasks and a Problems list. PowerShell, Command Prompt, WSL and Git Bash terminals over ConPTY. |
| **AI** | Codex and Claude Code in Ask, Plan, Agent and Bypass modes, OpenAI-compatible APIs and NexusAI. Context sharing you can see, secret detection, attachments, command approvals, hunk review, Ctrl+K inline edits and resumable sessions. |
| **Infrastructure** | Live telemetry, alerts, devices with pinned host keys, services, logs, processes, network probes, SSH/SFTP, NixOS dry-build and switch, Debian shadow workspaces, Minecraft and PS5LM status. |
| **Security** | Rust policy engine for every remote action. Debian is read-only by default and enforced by `nexus-ro`. Timed owner unlock; agents never get write access. Access session encrypted with DPAPI. App lock with the iPhone's 4-digit code. |

## Install

Download the latest build from
[Releases](https://github.com/ljcatherine/NexusWindows/releases/latest):

| File | Use it when |
|---|---|
| `NexusDesktop-<version>-x64.msi` | Normal install with a Start menu entry |
| `NexusDesktop-<version>-x64-portable.zip` | Run from a folder |
| `NexusDesktop-<version>-x64.exe` | Just the executable |

Check downloads against `SHA256SUMS.txt` in the same release.

## Configure

AI providers work as on Linux (`codex login`, `claude auth login`, or an
endpoint in Settings). API keys go to Windows Credential Manager. Settings, the
session database, the audit log and `known_hosts.json` live in
`%APPDATA%\NexusDesktop\`. See [Configuration](/docs/configuration/#nexus-desktop-windows)
for the gateway values.

## Build from source

Needs Rust stable (MSVC), Visual Studio Build Tools with the Windows SDK, and Git.

```powershell
cargo build --release -p nexus-app      # target\release\NexusDesktop.exe
cargo test --workspace
powershell -ExecutionPolicy Bypass -File scripts\release.ps1   # local release, no CI
```
