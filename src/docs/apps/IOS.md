<div align="center">

# 📱 Nexus for iPhone

**[ljcatherine/NexusiOS](https://github.com/ljcatherine/NexusiOS)** · Swift 6.4 · SwiftUI · iOS 17+ · built on Linux with xtool

</div>

The native SwiftUI client for iPhone and iPad. It's also the home of the
backend: the Go gateway, the Cloudflare Worker, the agent orchestrator, the
workspace agent and the NexusAI PS5 integration all live in this repository.

## Features

| Area | What it does |
|---|---|
| **SSH and terminal** | Saved device profiles with ordered LAN, Tailscale and Cloudflare-relay endpoints. Ed25519 key import and on-device generation. Credentials and host pins in the Keychain, explicit first-use fingerprint confirmation, changed-key rejection and guarded rotation. Interactive PTY tabs on SwiftTerm, reconnect, optional tmux, keyboard controls and search. |
| **Overview** | CPU, memory, storage, uptime, load and GPU snapshots. History and rates come only from real samples. Optional active-screen refresh and local low-resource notifications. |
| **Files** | SFTP and app-local browsing, bounded previews and edits, multi-file and recursive transfers with progress and cancellation, explicit conflict handling. |
| **Services** | systemd controls and logs, guarded NixOS dry-build and switch, network/DNS/TCP diagnostics, confirmed command recipes, a Minecraft panel launcher, and the **One Time Passcode** that unlocks Nexus Desktop. |
| **AI** | Streaming chat for NexusAI, OpenAI-compatible APIs, Open WebUI, Ollama and Apple Intelligence (iOS 26+). Response profiles, protected conversations, text/CSV/TSV/XLSX/PDF and image attachments, on-device OCR, opt-in local knowledge, secret warnings, approved sharing of cached host snapshots, web research through the gateway, PS5 model switching and agent runs. |

## Install

Each [release](https://github.com/ljcatherine/NexusiOS/releases) has:

| Asset | What it is |
|---|---|
| `Nexus-v<version>-build.<n>-unsigned.ipa` | Unsigned device build |
| `…-unsigned.ipa.sha256` | Checksum |
| `…-metadata.json` | Source commit, version and build |

The IPA is **unsigned**. Sign it yourself with a provisioning profile for an
identifier you control, then install it with Apple Configurator, your signing
service or `ideviceinstaller`. See
[Signing](https://github.com/ljcatherine/NexusiOS/blob/main/docs/SIGNING.md).

## Build from source (no Mac needed)

```sh
nix develop
./scripts/setup-swift-toolchain.sh      # Swift 6.4.1 via Swiftly, signature-checked
./scripts/setup-xtool.sh                # xtool 1.24.0, checksum-pinned
xtool sdk install /path/to/Xcode.xip    # Apple SDK, downloaded yourself
./scripts/xtool-build.sh --release --ipa
```

The build validates the bundle, version, unsigned structure, privacy manifest,
executable and SSH linkage, and rejects any private IPv4 address or Tailscale
name in the bundle. Tests:

```sh
./scripts/test-swift.sh                 # NexusCore and NexusSSH
bash scripts/test-openssh.sh            # against a disposable OpenSSH container
```

Full details:
[Building](https://github.com/ljcatherine/NexusiOS/blob/main/docs/BUILDING.md).

## Connect it to your backend

Add your Worker host, Access issuer and client ID with a
[deployment plist](/docs/configuration/#nexus-for-iphone) at build time, or in
**Settings → API Connections** on the device. Sign-in uses Cloudflare Managed
OAuth with PKCE in the system browser. Tokens stay in the Keychain.

## Repository map

| Path | What it is |
|---|---|
| `App/` | The SwiftUI app |
| `Sources/NexusCore`, `Sources/NexusSSH` | Models and logic, SSH transport (Citadel + SwiftTerm, vendored) |
| `gateway/` | Go gateway: identity, permissions, AI, SSH relay, search, sync |
| `cloudflare/` | `nexus-gateway` Worker |
| `agent-orchestrator/` | Python agent orchestrator |
| `workspace-agent/` | Go read-only workspace bridge |
| `integrations/ps5lm-plus` | NexusAI NexusAI fork |
| `integrations/hermes` | Optional Hermes agent engine |
| `scripts/` | Build, release, validation and Debian hardening |

## Security notes

- Keys, passwords, tokens and host pins live only in the iOS Keychain and are never exported.
- HTTP is allowed only to explicitly configured private addresses.
- SSH sessions close when the app goes to the background.
- The app never grants sudo; elevated actions rely on the server's existing policy and need confirmation.
- No analytics or tracking. See [Privacy](https://github.com/ljcatherine/NexusiOS/blob/main/docs/PRIVACY.md).
