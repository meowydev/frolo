<!-- Screenshot placeholder: replace with a real OOBE/dashboard screenshot before publishing. -->
<p align="center">
  <img src="docs/screenshots/hero.png" alt="Frolo — self-hosted Proxmox deployment panel" width="820" />
</p>

# Frolo

Frolo is a friendly **self-hosted web panel** that deploys applications onto
**Proxmox VE** for homelab users. You install it inside a small Linux VM and open
it in your browser at **`http://<frolo-vm-ip>:4512`**. Frolo clones a cloud-init
template, configures the VM (CPU, RAM, disk, hostname, networking), boots it,
installs a declarative application recipe, checks it actually works, and can open
ports through your routers — always with a review-and-confirm step before
anything changes.

Frolo runs **mock-first**: a built-in "Try Frolo safely" mode demonstrates the
whole Nginx deployment flow against a realistic simulation, so you can explore
everything before connecting real infrastructure.

> **Status: beta.** The UI carries a visible beta label. Real Proxmox/router
> connectivity lives behind the same typed interfaces as the mock and is gated by
> safety checks.

## Access model

- Frolo listens on **port 4512** and is intended for a **trusted LAN**.
- It **never opens a router mapping to expose itself**. For remote access, put it
  behind an HTTPS reverse proxy you control — see
  [docs/REVERSE_PROXY.md](docs/REVERSE_PROXY.md).
- Over plain HTTP, Frolo shows a clear "trusted LAN" warning but does not block
  setup.

## What it does

- Clone a **QEMU Ubuntu cloud-init** template; configure resources + hostname.
- Networking: **DHCP**, **manual IPv4**, or **VM-ID-derived IPv4** (reusable
  network profiles).
- Install the built-in **Nginx** recipe, create a recognizable Frolo test page,
  enable the service, and **verify it over HTTP** with a unique marker.
- A persistent, resumable **deployment state machine**
  (Queued → Cloning → Configuring → Booting → Installing → Checking → Exposing →
  Ready / Failed), backed by an operation journal so a crash never duplicates
  infrastructure. **Failure never deletes anything.**
- **Frolo Teach Mode**: record how you create a port-forward in your router's web
  UI, then replay it with ranked semantic locators. Credentials stay in the vault;
  workflows store only variable references; on an ambiguous target Frolo stops and
  asks you to repair the step instead of guessing.
- **Router chains** (e.g. Internet → modem → Keenetic → Archer C6U → VM) with a
  full review screen and innermost-out apply / reverse-order teardown.

## First run (OOBE)

On first visit Frolo walks you through a Material stepper:

1. Welcome (Frolo controls local infrastructure)
2. Mode — **Try Frolo safely** (mock) or **Connect my Proxmox**
3. Create the first administrator (scrypt-hashed password)
4. Save your **vault recovery code** (shown once, confirm you saved it)
5. Connect + **validate** Proxmox read-only (optionally pin its TLS fingerprint)
6. Default network profile (DHCP / VM-ID)
7. Router chain (optional, skippable)
8. Nginx gateway (optional, skippable)
9. Review, then Finish

No infrastructure is created, changed, or deleted during setup. After finishing,
OOBE never shows again unless you reset setup from the VM terminal.

## System requirements

- A small Linux VM (Debian 12 / Ubuntu 22.04+), **amd64 or arm64**.
- **Docker Engine** + Docker Compose v2.
- ~512 MB RAM and ~1 GB disk are plenty for the panel itself.

## Beta installation

The supported beta install path is Docker via the installer:

```bash
curl -fsSLO https://example/frolo/install.sh   # or copy install/install.sh onto the VM
sudo bash install.sh
# → Frolo is ready at http://<detected-ip>:4512
```

The installer checks your architecture and dependencies, installs/validates
Docker, creates `/opt/frolo`, generates local secrets with `0600` permissions,
pulls the pinned release image, starts it, waits for the health check, and prints
the panel address. It is safe to rerun and provides more commands:

```bash
sudo bash install.sh update                 # pull the pinned release + restart
sudo bash install.sh backup frolo.tar.gz    # back up the data volume
sudo bash install.sh restore frolo.tar.gz   # restore the data volume
./install.sh diagnostics                     # environment + health info
sudo bash install.sh uninstall               # remove Frolo, KEEP your data
sudo bash install.sh uninstall --remove-data # also delete persistent data (explicit)
```

Or with Compose directly:

```bash
docker compose up -d      # then open http://<vm-ip>:4512
```

## Backup & restore

All state (SQLite, encrypted vault, keys) lives in a single Docker volume
(`frolo-data`). Back it up with `install.sh backup` and restore with
`install.sh restore`. Uninstall never deletes this volume unless you pass the
explicit `--remove-data` flag. See [docs/RELEASE.md](docs/RELEASE.md).

## Development

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm run typecheck        # tsc -b across the workspace
pnpm run test             # vitest: unit + integration + e2e (mock only)
pnpm run build            # build library packages + the web panel

# Run the panel locally (API on :4512, Vite UI on :5273 proxying /api):
pnpm dev
# → open the panel at http://localhost:5273
```

> Native module: `better-sqlite3` compiles a binding on install. On very new Node
> versions use Node 22 (as the Docker image does) if you hit a native GC issue in
> local dev.

## Architecture

Frolo is a pnpm/TypeScript monorepo. Everything privileged runs together on the
Frolo VM: the Fastify controller/API, SQLite, the encrypted vault, the Proxmox
provider, the SSH guest provider, the Playwright router automation, and the web
server. The React/Vite panel talks to it only through the authenticated HTTP API
+ SSE. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
packages/
  contracts/   shared types, zod schemas, provider interfaces, licensing contract
  core/         pure domain logic (state machine, network, recipe engine, locators, chain planner, sanitizer)
  vault/        AES-256-GCM vault + keychain adapters (file/OS/in-memory)
  store/        SQLite store + operation journal (non-secret only)
  providers-*   Proxmox / Guest / Router providers (fake + real)
  controller/   orchestrator, journal, exposure, confirmation gates, audit, licensing
  server/       Fastify web panel: auth, sessions, CSRF, OOBE, REST API, SSE
  licensing/    offline signed-license verifier (public key only) + dev issuer + admin CLI
apps/
  ui/           React + Vite Material Design 2 web panel (MUI)
fixtures/       static router fixtures for record/replay
e2e/            end-to-end mock workflow + web-panel + installer tests
```

## Security model

- First-admin account with **scrypt** password hashing, HttpOnly `SameSite=Strict`
  session cookies, **CSRF** double-submit protection, **login rate limiting**, and
  **session revocation**.
- Credentials encrypted at rest with **AES-256-GCM**; the master key lives in a
  `0600` key file on the data volume, wrapped by a one-time **recovery code** the
  operator saves. **SQLite holds no secret values.**
- A single sanitizer strips passwords, tokens, cookies, keys, and CSRF values
  from every log and audit entry.
- Recipes are **declarative, versioned, checksum-verified**, limited to known
  typed operations — never arbitrary scripts.
- Opening public ports or deleting a VM each require an **explicit confirmation**.
- LAN-only by default; Frolo never exposes itself through a router.

See [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md). Router and Proxmox
credentials **stay on your machine**.

## Subscriptions

Frolo Home is the free, genuinely useful tier (local deployment + Teach Mode +
single-hop exposure). Paid tiers (Frolo AdvancedUser, Frolo Powerfullness) add
conveniences. Verification is **offline and signature-based**: you send a device
code from your subscribed Boosty account and paste back a signed key the app
verifies with a bundled public key. **Expiry never stops or deletes anything** —
it only pauses paid conveniences. See [docs/LICENSING.md](docs/LICENSING.md).

## Public / private boundary

This repository is **frolo-app** — the public, open self-hosted application. The
production license-issuer service, Boosty subscriber records, and production
signing keys are **frolo-server**, a separate private service that is **not** in
this repo. The app ships only the public verification key. See
[docs/PRIVATE_SERVICE_BOUNDARY.md](docs/PRIVATE_SERVICE_BOUNDARY.md).

## Specification

The full spec lives in [`.kiro/specs/frolo/`](.kiro/specs/frolo/):
`requirements.md`, `design.md`, and `tasks.md`.

## License

Apache-2.0. See [LICENSE](LICENSE) and
[docs/LICENSE_DECISION.md](docs/LICENSE_DECISION.md).
