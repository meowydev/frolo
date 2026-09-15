# Deploying Frolo on the Meowerity stack

Frolo runs as a single Docker container: the Fastify **local controller** on
port **4512** serving the built web panel, with all state in a persistent
volume. It is **LAN-only by default** and never exposes itself through a router —
put it behind your own HTTPS reverse proxy for remote access
(see [REVERSE_PROXY.md](REVERSE_PROXY.md)).

## Quick start (Meowerity overlay)

```bash
# 1) Configure the environment (pin an explicit image version).
cp deploy/meowerity/frolo.env.example deploy/meowerity/frolo.env
$EDITOR deploy/meowerity/frolo.env      # set FROLO_IMAGE, bind, TLS, license keys

# 2) Start it.
docker compose --env-file deploy/meowerity/frolo.env \
  -f deploy/meowerity/docker-compose.yml up -d

# 3) Verify health.
curl -fsS http://127.0.0.1:4512/api/health
# -> {"status":"ok","version":"...","mode":"mock"}
```

The overlay ([`deploy/meowerity/docker-compose.yml`](../deploy/meowerity/docker-compose.yml))
sets `restart: always`, a persistent `frolo-data` volume, a `/api/health`
container health check, `no-new-privileges`, bounded JSON logs, and binds to
`127.0.0.1` by default (front it with a reverse proxy or set `FROLO_BIND` for a
trusted LAN).

## Alternative: the installer

On a Debian/Ubuntu host you can use the installer from a GitHub release instead:

```bash
curl -fsSLO https://github.com/meowydev/frolo/releases/latest/download/install.sh
sudo bash install.sh                 # install/validate Docker, verify bundle, start, print URL
sudo bash install.sh update v0.1.0-beta.2   # move to a specific tag (checksum-verified)
sudo bash install.sh backup frolo.tar.gz    # back up the data volume
sudo bash install.sh restore frolo.tar.gz   # restore it
sudo bash install.sh diagnostics            # environment + health
sudo bash install.sh uninstall              # remove Frolo, KEEP data
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `FROLO_IMAGE` | — | **Pin** the image, e.g. `ghcr.io/meowydev/frolo:0.1.0-beta.1`. Required by the Meowerity overlay. |
| `FROLO_PORT` | `4512` | Listen port inside the container. |
| `FROLO_HOST` | `0.0.0.0` | Bind address inside the container. |
| `FROLO_BIND` | `127.0.0.1` (overlay) | Host interface the port maps to. Use `0.0.0.0` only on a trusted LAN with no proxy. |
| `FROLO_DATA_DIR` | `/opt/frolo/data` | Persistent state (SQLite, encrypted vault, keys). Mounted volume. |
| `FROLO_WEB_ROOT` | `/app/web` | Built panel static files (set by the image). |
| `FROLO_BEHIND_TLS` | `0` | Set `1` when behind an HTTPS reverse proxy (Secure cookies + Origin handling). |
| `FROLO_ALLOWED_ORIGINS` | — | Comma-separated extra hostnames allowed as request Origin (your external hostname when proxied). |
| `PLAYWRIGHT_BROWSERS_PATH` | `/opt/frolo/pw-browsers` | Chromium location baked into the image (router Teach Mode / replay). |
| **Real mode** | | |
| `FROLO_ENABLE_REAL_MODE` | `0` | Set `1` to *permit* real Proxmox/SSH/router automation. |
| `FROLO_REAL_SAFETY_TESTS_PASSED` | `0` | Set `1` to confirm you ran the real-mode validation on disposable hardware. Both flags AND an operator-selected connection are required before anything real happens. |
| **Licensing (PUBLIC keys only)** | | |
| `FROLO_LICENSE_KEYS` | — | Inline JSON array of `PublicVerificationKey`. Never a private key. |
| `FROLO_LICENSE_KEYS_FILE` | — | Path to a mounted JSON file of public keys (takes priority over the inline var). |
| **Source updater (source deployments only)** | | |
| `FROLO_RELEASE_ROOT` | — | Enables the in-app source updater; points at `<root>` containing `releases/` + `current`. Unset for Docker (which updates by pulling a new image tag). |
| `FROLO_UPDATE_PRERELEASE` | `0` | Set `1` to allow prerelease tags in the source updater. |
| `FROLO_GITHUB_TOKEN` | — | Optional, only to raise GitHub API rate limits for update checks. |
| **Development only** | | |
| `FROLO_DEV` / `FROLO_ALLOW_DEV_LICENSE_KEYS` | — | Set `1` for local dev to accept development-signed licenses and enable the dev issuer. Production leaves these unset; dev-signed licenses are refused. |

### Production public license keys

Provide one or more **public** Ed25519 verification keys. Never a private signing
key (the loader rejects any payload containing PEM `PRIVATE KEY` markers or a
`privateKey`/`secret` field, and fails safe to the free Home tier). Shape:

```json
[
  {
    "keyId": "frolo-prod-1",
    "alg": "ed25519",
    "publicKey": "<base64url of the raw 32-byte ed25519 public key>",
    "environment": "production"
  }
]
```

Inline:

```
FROLO_LICENSE_KEYS=[{"keyId":"frolo-prod-1","alg":"ed25519","publicKey":"...","environment":"production"}]
```

Or mounted (recommended): put `keys.json` on the host, mount it read-only, and
point `FROLO_LICENSE_KEYS_FILE` at it (see the commented volume in the overlay).

## Updating

- **Docker deployments** update by moving to a new **pinned image tag**:
  `install.sh update <tag>` downloads the checksum-verified bundle for that tag
  and repins the image. Never `main`/`latest`.
- **Source deployments** (with `FROLO_RELEASE_ROOT`) use `frolo-update`: it
  downloads the tagged `frolo-<version>.tar.gz` release asset, verifies its
  checksum, builds it, switches the `current` release atomically, restarts,
  health-checks, and rolls back on failure.

## Backup & restore

All state lives in the `frolo-data` volume. Use `install.sh backup` /
`install.sh restore`, or snapshot the volume with your stack's tooling. Uninstall
never deletes the volume unless you pass `--remove-data`.

## Validating against real Proxmox hardware

Real mode is off until you deliberately enable it. Before flipping it on, run the
controlled validation scripts against a **disposable** lab host (never
production). These are NOT part of `pnpm test` and never run automatically.

```bash
pnpm run build:packages   # build the providers first

# 1) READ-ONLY: connect, list templates + VMs. Mutates nothing.
FROLO_VALIDATE_HOST=https://pve.lab:8006 \
FROLO_VALIDATE_NODE=pve \
FROLO_VALIDATE_TOKEN_ID='frolo@pve!validate' \
FROLO_VALIDATE_TOKEN_SECRET='...' \
FROLO_VALIDATE_CERT_SHA256='<optional pinned leaf-cert sha256>' \
pnpm run validate:real:proxmox

# 2) DESTRUCTIVE lifecycle (clone -> delete) on a DISPOSABLE vmid. Runs the
#    read-only preflight first, refuses if the target vmid already exists, and
#    requires you to type `destroy <vmid>` to proceed. It deletes only the vmid
#    it created.
FROLO_VALIDATE_HOST=... FROLO_VALIDATE_NODE=pve \
FROLO_VALIDATE_TOKEN_ID='frolo@pve!validate' FROLO_VALIDATE_TOKEN_SECRET='...' \
FROLO_VALIDATE_TEMPLATE_VMID=9000 \
FROLO_VALIDATE_DISPOSABLE_VMID=9999 \
pnpm run validate:real:proxmox-lifecycle
```

Use a **restricted** Proxmox API token (read-only for the read-only check;
clone/config/start/delete scoped to the disposable VMID range for the lifecycle
check). See [PRIVATE_SERVICE_BOUNDARY.md](PRIVATE_SERVICE_BOUNDARY.md) for the
public/private split and where the production signing key lives.

## Security notes

- LAN-only by default; put Frolo behind an HTTPS reverse proxy for remote access
  and set `FROLO_BEHIND_TLS=1` + `FROLO_ALLOWED_ORIGINS`.
- Proxmox connections use restricted API tokens + optional per-connection TLS
  certificate pinning; guest SSH uses per-deployment keys + TOFU host-key
  verification; router credentials are never stored in workflows.
- Secrets live only in the encrypted vault on the data volume; SQLite holds no
  secret values.
