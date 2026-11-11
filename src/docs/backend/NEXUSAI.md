<div align="center">

# 🧠 NexusAI

**Local LLM inference on a PS5, with an authenticated model-control API, an agent orchestrator and an optional Hermes engine.**

Source: [NexusiOS `integrations/ps5lm-plus`](https://github.com/ljcatherine/NexusiOS/tree/main/integrations/ps5lm-plus) · [`agent-orchestrator`](https://github.com/ljcatherine/NexusiOS/tree/main/agent-orchestrator) · [`integrations/hermes`](https://github.com/ljcatherine/NexusiOS/tree/main/integrations/hermes)

</div>

NexusAI is the AI side of Nexus. A custom PS5 app runs the model on the console's
GPU, the agent orchestrator on Debian turns chats into durable agent runs, and the
gateway exposes both to the apps behind Cloudflare Access.

```
Apps ──► gateway (Debian) ──► orchestrator :8897 ──► NexusAI PS5 app :8081 (inference)
                       │                        └──► :8082 (model control)
                       └──────────────────────────► :8081 (direct chat)
```

## The NexusAI PS5 app

A reproducible **GPL-3.0-or-later** fork of
[NexusAI](https://github.com/abhi245y/PS5LM-Plus) (itself built on Mert
Cobanov's PS5LM), kept in this ecosystem as patches plus new sources rather than
a copied tree. It ships as a separate PS5 homebrew title with its own title ID,
so it installs next to the original NexusAI instead of replacing it.

| | Original NexusAI | NexusAI PS5 app |
|---|---|---|
| Inference | llama-server on `:8081` (OpenAI-compatible) | Unchanged |
| Branding | PS5LM | NexusAI dashboard |
| Model control | On-console only | Opt-in authenticated HTTP API on `:8082` |
| Model metadata | Basic | Exact file size, architecture, GGUF quantisation type |
| Numeric JSON | Locale-sensitive parse (could abort) | Fixed |

### Model-control API (`:8082`)

| Route | Result |
|---|---|
| `GET /v1/nexus/status` | State, active model, context used/capacity, measured speeds and memory, load progress |
| `GET /v1/nexus/models` | Discovered models: stable 16-hex ID, label, drive, fits/current, size, architecture, quantisation |
| `POST /v1/nexus/models/{id}/load` | `202`: queues a GPU-safe restart into that model |
| `POST /v1/nexus/models/unload` | `202`: queues a restart with no model |

Every call needs `Authorization: Bearer <token>`. The console stores only the
token's **SHA-256** (`nexus-control.token`, `sha256:<64 hex>`, mode 0600). The raw
token lives only in the Debian configuration and the iPhone Keychain.

The controller is **off** without the token file and binds `127.0.0.1:8082`
unless the empty `nexus-control.lan` marker exists. A model switch restarts the
app to free GPU memory, so poll `/status` until the new model is ready.

### Build and install

You need a PS5 that can run homebrew and the upstream PS5_Vulkan toolchain and
SDK. Nexus doesn't provide console exploits or homebrew prerequisites.

```bash
./integrations/ps5lm-plus/clone-nexus-fork.sh                  # pinned upstream + Nexus patches
python3 integrations/ps5lm-plus/prepare-test-identity.py …     # pick an unused PPSA##### title ID
# build inside build/ps5lm-nexus-fork with the upstream scripts/build-app.sh
python3 integrations/ps5lm-plus/verify-test-title.py build/app-ps5/title/<TITLE_ID>
./integrations/ps5lm-plus/test-nexus-control.sh build/ps5lm-nexus-fork   # host-side controller tests
```

Rules for every install:

1. **Back up first**: the original title folder and the PS5LM state folder
   (`/data/PS5LM`, or `/download0/PS5LM` when sandboxed).
2. **Use a different title ID** from the original, and never run both at once,
   because they share the state folder.
3. **Fix permissions**: `eboot.bin` and `sce_module/libc.prx` must be `0755`.
   Normalise before transfer and check again after install. The verifier records
   modes as well as hashes.
4. **Reinstall, don't overwrite**: close the title, remove the previous test
   install with supported operations, and install the new build fresh. Keep
   rollback copies and shared models and settings.

### Turn on control

1. Generate a 32–128 character token on a trusted machine
   (`openssl rand -hex 32`).
2. Write only `sha256:<digest>` to `nexus-control.token` in the PS5LM state folder (0600).
3. Create `nexus-control.lan` only once the Debian firewall and gateway are ready.
4. Check: no token → `401`; with token → `/status` and `/models` show real models.

`:8081` and `:8082` are plain HTTP. Keep them on your LAN, firewall `:8082` to the
Debian server, and never port-forward them.

### Roll back

Stop the test title, keep `app.log` and `llama.log`, remove the token and LAN
marker, restore the state folder from backup if needed, and launch the original
title. Never delete the original title.

## Agent orchestrator

A Python service on Debian (`127.0.0.1:8897`) that runs durable agent jobs
against the PS5 and the workspace agents.

- Jobs are stored owner-only and survive restarts.
- Context capacity is read from the loaded model; `NEXUS_CONTEXT_TOKENS` can lower it.
- Before each PS5 stream it writes an **inference lease**. A crash or a stream that
  ends without its completion marker quarantines inference until you confirm the
  PS5 is idle: `clear-inference-quarantine.py "$RUNS_DIR" --confirmed-ps5-idle`.
- Patches and commands are proposals that need human review in the app. Workspace
  writes and command execution need separate grants.
- Optional native model switching through `NEXUS_PS5_CONTROL_URL` and its own token.

Setup is in [Debian → orchestrator](/docs/backend/debian/#6-agent-orchestrator).

## Hermes engine (optional)

An alternative agent engine the orchestrator can use, built as an isolated
container worker with a pinned base image. Build and verification steps are in
[`integrations/hermes`](https://github.com/ljcatherine/NexusiOS/tree/main/integrations/hermes).

## Using it from the apps

| App | What you can do |
|---|---|
| iPhone | Chat (direct or via the gateway), switch PS5 models, start and review agent runs, web research |
| Linux / Windows Desktop | Chat with NexusAI as a provider, see PS5 status |
| Nexus Online | Chat, see models, status and agent runs (read-only) |

For direct LAN use, point any app at `http://<ps5-address>:8081/v1`. For remote
use, go through the gateway, which only allows models in `NEXUS_AI_ALLOWED_MODELS`.
