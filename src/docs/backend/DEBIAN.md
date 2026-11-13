# Debian backend

This guide sets up the server that sits behind Cloudflare: the Nexus gateway, the
`cloudflared` tunnel, the agent orchestrator, a workspace agent and the
`nexus-ro` read-only helper. Everything listens on loopback, and the only network
path in is the outbound tunnel.

Commands assume Debian 13, a non-root admin account with `sudo`, and a checkout of
[NexusBackend](https://github.com/ljcatherine/NexusBackend) on a trusted build machine.
Replace `server` with your account name.

> [!IMPORTANT]
> Keep a second way in (console or Tailscale) while you change SSH or the
> firewall. Never expose ports 8787, 8896, 8897, 8080, 8081 or 8082, and never
> disable SSH host-key or TLS checks to make something work.

## 1. Base system

```bash
sudo apt update && sudo apt install -y openssh-server nftables git curl
```

Install [Tailscale](https://tailscale.com/download/linux) and sign in. It's your
recovery path and the private route for the apps' direct SSH.

## 2. Key-only SSH and firewall

Install your Ed25519 public key first. From your computer, use
`scripts/install-verified-ssh-key.sh`, which checks the host fingerprint you read
on the server before running `ssh-copy-id`:

```bash
# on the server
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
# on your computer
./scripts/install-verified-ssh-key.sh server.example.ts.net server ~/.ssh/nexus-ed25519.pub 'SHA256:…'
```

Then copy `scripts/debian-harden.sh` and `scripts/debian/nexus-hardening.nft` to
the server, edit the home-network ranges in the `.nft` file, and apply:

```bash
sudo SSH_OWNER=server ./debian-harden.sh apply     # rolls back after 5 minutes unless confirmed
# open a NEW SSH session to check you can still get in, then:
sudo SSH_OWNER=server ./debian-harden.sh confirm
```

This turns off password and keyboard-interactive SSH, and loads an inbound
firewall: loopback, Tailscale and your home ranges are allowed, RCON is blocked,
and everything else is dropped. It refuses to run if your account has no Ed25519
key or Tailscale is down. `rollback` undoes everything.

## 3. Service account and folders

The system unit runs as a dedicated user:

```bash
sudo useradd --system --home /var/lib/nexus-gateway --shell /usr/sbin/nologin nexus-gateway
sudo install -d -m 0750 -o root -g nexus-gateway /etc/nexus-gateway
```

You can instead run the gateway as your own user with
`gateway/nexus-gateway-user.service`, which reads
`~/.config/nexus-gateway/nexus.env`. The rest of this guide uses the system unit.

## 4. Gateway

Build a static binary on your computer and copy it over:

```bash
cd gateway
CGO_ENABLED=0 go test ./...
CGO_ENABLED=0 go build -trimpath -o nexus-gateway .
scp nexus-gateway gateway/nexus-gateway.service server@server.example.ts.net:
```

```bash
sudo install -m 0755 nexus-gateway /usr/local/bin/nexus-gateway
sudo install -m 0644 nexus-gateway.service /etc/systemd/system/
```

Create `/etc/nexus-gateway/nexus.env` from
[`gateway/.env.example`](https://github.com/ljcatherine/NexusBackend/blob/main/gateway/.env.example)
(mode `0640`, `root:nexus-gateway`). The gateway refuses to start until the
required values are set:

| Setting | Value |
|---|---|
| `NEXUS_GATEWAY_LISTEN` | `127.0.0.1:8787` (non-loopback is refused) |
| `NEXUS_OIDC_ISSUER` | `https://<team>.cloudflareaccess.com` |
| `NEXUS_OIDC_AUDIENCE` | The Access application's **AUD tag** |
| `NEXUS_OIDC_JWKS_URL` | `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` |
| `NEXUS_OIDC_PRINCIPAL_CLAIM` | `email` |
| `NEXUS_SUBJECT_PERMISSIONS_JSON` | `{"you@example.com":["ai.models","ai.chat","ssh.connect"]}` (add `ai.search`, `ai.history`, `minecraft.panel` as needed) |
| `NEXUS_AI_UPSTREAM_URL` | `http://<ps5-address>:8081/v1` |
| `NEXUS_AI_ALLOWED_MODELS` | Model IDs from the PS5's `/v1/models` |
| `NEXUS_MODEL_STATE_PATH` | `/var/lib/nexus-gateway/model-state/pending-switch.json` |
| `NEXUS_ORCHESTRATOR_TOKEN` | Same value as the orchestrator's (step 6) |

Optional features stay off until configured:

| Feature | Settings |
|---|---|
| Web search | `NEXUS_SEARCH_PROVIDER=brave` + `NEXUS_BRAVE_API_KEY`, or `searxng` + `NEXUS_SEARXNG_URL`; grant `ai.search` |
| Conversation sync | `NEXUS_CONVERSATION_ENCRYPTION_KEY` (base64 of 32 random bytes; back it up), `NEXUS_CONVERSATIONS_DIR`; grant `ai.history` |
| Minecraft panel | `NEXUS_MINECRAFT_PANEL_ORIGIN`, and `NEXUS_MINECRAFT_PUBLIC_ORIGIN` set to the panel's own Access-protected hostname (see [Cloudflare](/docs/backend/cloudflare/)); grant `minecraft.panel` |

Generate the sync key straight into the file so it's never printed:

```bash
echo "NEXUS_CONVERSATION_ENCRYPTION_KEY=$(head -c32 /dev/urandom | base64)" | sudo tee -a /etc/nexus-gateway/nexus.env >/dev/null
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now nexus-gateway
curl -s http://127.0.0.1:8787/healthz
```

## 5. SSH relay keys

The relay lets the apps open SSH through the Worker without holding a key for the
target. The gateway authenticates to each target with its own key.

```bash
sudo install -d -m 0700 -o nexus-gateway -g nexus-gateway /var/lib/nexus-gateway/ssh
sudo -u nexus-gateway ssh-keygen -t ed25519 -N '' -f /var/lib/nexus-gateway/ssh/upstream_ed25519
sudo -u nexus-gateway ssh-keygen -t ed25519 -N '' -f /var/lib/nexus-gateway/ssh/relay_host_ed25519
```

On each target account, authorise the upstream public key restricted to a PTY:

```
restrict,pty ssh-ed25519 AAAA… nexus-gateway-relay
```

Record each target's host key in `/var/lib/nexus-gateway/ssh/known_hosts` after
checking its fingerprint on that machine, then set:

```bash
NEXUS_SSH_UPSTREAM_KEY=/var/lib/nexus-gateway/ssh/upstream_ed25519
NEXUS_SSH_RELAY_HOST_KEY=/var/lib/nexus-gateway/ssh/relay_host_ed25519
NEXUS_SSH_KNOWN_HOSTS=/var/lib/nexus-gateway/ssh/known_hosts
NEXUS_SSH_TARGETS_JSON='{"nixos":{"host":"192.0.2.10","port":22,"username":"user"},"debian":{"host":"127.0.0.1","port":22,"username":"server"}}'
```

The apps pin the relay host key on first use, separately from TLS.

## 6. Agent orchestrator

```bash
git clone https://github.com/ljcatherine/NexusBackend.git ~/nexus
mkdir -p ~/.config/nexus-orchestrator ~/.local/share/nexus-orchestrator/runs
chmod 700 ~/.config/nexus-orchestrator ~/.local/share/nexus-orchestrator
```

`~/.config/nexus-orchestrator/env` (mode 0600):

```bash
NEXUS_ORCHESTRATOR_TOKEN=<openssl rand -hex 32>
NEXUS_ORCHESTRATOR_LISTEN=127.0.0.1:8897
NEXUS_ORCHESTRATOR_RUNS_DIR=/home/server/.local/share/nexus-orchestrator/runs
NEXUS_PS5_CHAT_URL=http://<ps5-address>:8081/v1
NEXUS_PS5_MODEL_ID=auto
# optional model switching (step 9)
NEXUS_PS5_CONTROL_URL=http://<ps5-address>:8082/v1
NEXUS_PS5_CONTROL_TOKEN=<raw control token>
```

`~/.config/systemd/user/nexus-orchestrator.service`:

```ini
[Unit]
Description=Nexus agent orchestrator

[Service]
EnvironmentFile=%h/.config/nexus-orchestrator/env
ExecStart=/usr/bin/python3 %h/nexus/agent-orchestrator/server.py
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now nexus-orchestrator
sudo loginctl enable-linger server
```

Put the same `NEXUS_ORCHESTRATOR_TOKEN` in the gateway's `nexus.env`.

## 7. Workspace agents

One per host (Debian and NixOS), each with its **own** token and roots. It needs
Go 1.22+ and Linux.

```bash
cd ~/nexus/workspace-agent && go test ./... && go build -o ~/.local/bin/nexus-workspace-agent .
```

Environment, from
[`workspace-agent/.env.example`](https://github.com/ljcatherine/NexusBackend/blob/main/workspace-agent/.env.example) (0600):

```bash
NEXUS_WORKSPACE_HOST=debian          # nixos on the workstation
NEXUS_WORKSPACE_LISTEN=127.0.0.1:8896
NEXUS_WORKSPACE_TOKEN=<openssl rand -hex 32>
NEXUS_WORKSPACE_ROOTS_JSON='[{"id":"projects","name":"Projects","path":"/home/server/Projects"}]'
```

Run it as a user service like the orchestrator, with `ProtectHome=read-only`.
Roots must already exist, can't contain symlinks, and can't be `/` or a whole home
folder. Git inspection is opt-in per root (`"git_read":true`) and needs bubblewrap
0.12+. Give the orchestrator the URLs and tokens
(`NEXUS_DEBIAN_WORKSPACE_URL/TOKEN`, `NEXUS_NIXOS_WORKSPACE_URL/TOKEN`).

## 8. `nexus-ro` for Nexus Desktop

Nexus Desktop treats this server as read-only. `nexus-ro` enforces that on the
server: a forced command that only runs the Desktop's fixed read-only catalog.

Build it from [NexusNix](https://github.com/ljcatherine/NexusNix) (or NexusWindows):

```bash
cargo build --release -p nexus-ro
scp target/release/nexus-ro server@server.example.ts.net:
ssh server@server.example.ts.net 'sudo install -m 0755 nexus-ro /usr/local/bin/nexus-ro'
```

Add the Desktop's public key to `~/.ssh/authorized_keys` with the forced command:

```
restrict,command="/usr/local/bin/nexus-ro --root /home/server/Projects" ssh-ed25519 AAAA… nexus-desktop
```

Turn on the server catalog for that device in Nexus Desktop. The helper refuses
SFTP and anything outside the catalog with exit code 126, opens files with
`O_NOFOLLOW`, and writes nothing.

## 9. Cloudflare tunnel

Create the tunnel in Cloudflare first ([Cloudflare → tunnel](/docs/backend/cloudflare/#2-tunnel-and-workers-vpc)),
then install `cloudflared` 2025.7.0 or newer from Cloudflare's Debian repository
and store the token in a root-owned file:

```bash
sudo useradd --system --shell /usr/sbin/nologin cloudflared
sudo install -d -m 0750 -o root -g cloudflared /etc/nexus-cloudflared
sudo install -m 0640 -o root -g cloudflared /dev/stdin /etc/nexus-cloudflared/tunnel-token   # paste, then Ctrl-D
sudo install -m 0644 gateway/nexus-cloudflared.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now nexus-cloudflared
```

The unit uses `--token-file` so the token never appears in process arguments, and
forces QUIC (outbound UDP 7844). It requires the gateway unit to be running.

## 10. Check it

```bash
systemctl status nexus-gateway nexus-cloudflared
systemctl --user status nexus-orchestrator
ss -tlnp | grep -E '8787|8896|8897'        # all on 127.0.0.1
sudo nft list table inet nexus_hardening
journalctl -u nexus-gateway -n 50          # audit events contain no tokens or prompts
```

From a phone or the Desktop, sign in through Access and load the model list.

## Updating and rolling back

- Gateway: keep the previous binary (`/usr/local/bin/nexus-gateway.previous`),
  install the new one, restart, and swap back if `/healthz` or sign-in fails.
- Orchestrator: `git -C ~/nexus pull`, then restart. Stop it before clearing an
  inference quarantine.
- Firewall and SSH: `sudo SSH_OWNER=server ./debian-harden.sh rollback`.
- Tunnel: `sudo systemctl stop nexus-cloudflared` cuts all remote access at once.
