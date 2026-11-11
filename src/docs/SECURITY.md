# Security

Nexus is built for one owner. Every layer assumes the one in front of it might
fail, so each check is repeated where the action actually happens.

## Layers

| Layer | Enforced by | What it does |
|---|---|---|
| Sign-in | Cloudflare Access | Hostname-based application with an exact-email policy (add MFA). Managed OAuth with PKCE for native apps, so no client secret exists anywhere. |
| Front door | `nexus-gateway` and `nexus-online` Workers | Fail closed without a matching `ctx.access` audience and owner email. Fixed routes only. Forward only Cloudflare's signed `Cf-Access-Jwt-Assertion`, never the bearer token or cookies. |
| Transport | Workers VPC and `cloudflared` | Outbound-only QUIC tunnel. No inbound ports, no public origin. |
| Identity | Nexus gateway | Verifies the assertion against the Access JWKS (issuer, audience, signature, time). |
| Permission | Nexus gateway | The verified email needs each permission (`ai.models`, `ai.chat`, `ai.search`, `ai.history`, `ssh.connect`, `minecraft.panel`, …) in `NEXUS_SUBJECT_PERMISSIONS_JSON`. The policy parser rejects duplicate or ambiguous keys. |
| Limits | Nexus gateway | Request size, message count, rate, concurrency and stream size are all bounded. Upstream URLs can't carry credentials, and redirects aren't followed. |
| Read-only Debian | Desktop policy engine and `nexus-ro` | Desktop treats the Debian server as read-only, and the server enforces it with a forced-command catalog. AI agents never get write access, in any mode. |
| Read-only web | `nexus-online` Worker | Only read and inference routes are forwarded. Writes, model load/unload, agent runs, patches, commands and the SSH relay are refused. |
| Host identity | Every app | SSH host keys are pinned per endpoint, first use needs explicit fingerprint confirmation, and changed keys are rejected. No TLS or host-key bypass exists. |
| Secrets at rest | Each platform keystore | iOS Keychain, Windows Credential Manager or the Linux Secret Service. The PS5 stores only a hash of its control token. |
| App lock | iPhone, desktops | Face ID or passcode on iOS. The desktops lock with a 4-digit, 20-second TOTP from the iPhone ([spec](https://github.com/ljcatherine/NexusiOS/blob/main/docs/OTP.md)). |
| AI context | Every app | Secret-pattern warnings before sending, sensitive files excluded from context, every shared file shown. AI tools are limited to approved reads of cached snapshots. |

## What is deliberately not exposed

- No public SSH, inference, gateway or management port, and no router port forwarding.
- No arbitrary-host proxy: Workers and gateway accept only fixed routes and aliases.
- No interactive shell from Nexus Desktop to Debian, and no free-text Debian commands.
- No AI tool that runs commands, writes files or changes policy.
- No developer analytics or telemetry in any app.

## Residual risks

- The PS5's `:8082` control API is plain HTTP. Bind it to the LAN only with its
  marker file and firewall it to the Debian server.
- Desktop "Bypass" mode gives a local agent the owner's account rights on that PC.
  The Debian rule still applies, but it's a guardrail, not a sandbox.
- Workers VPC and Managed OAuth are Cloudflare betas.
- The OTP app lock stops casual use of an unattended PC. It isn't strong authentication.

## Reporting a vulnerability

Use the repository's **Security → Report a vulnerability** form on the affected
repo, not a public issue. Never include credentials in a report.
