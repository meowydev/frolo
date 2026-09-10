# Frolo beta release artifacts

Frolo ships as a **Docker-based self-hosted web panel**, not a standalone binary.
The beta release consists of:

| Artifact | What it is |
| --- | --- |
| `ghcr.io/meowerity/frolo:<version>` | Multi-arch container image (**linux/amd64** + **linux/arm64**) running the Fastify server + built web panel |
| `docker-compose.yml` | Deploy bundle pinned to the release image, with a persistent data volume + health check |
| `install.sh` | Installer for Debian/Ubuntu (amd64/arm64): installs/validates Docker, writes `/opt/frolo`, pulls the pinned image, starts it, waits for health, prints the ready URL |
| `SHA256SUMS.txt` | Checksums for the shipped `docker-compose.yml` and `install.sh` |

## Building the artifacts

```bash
# Local (single arch, loaded into the local Docker):
FROLO_IMAGE=frolo scripts/build-release.sh --load --platform linux/amd64

# CI (multi-arch, pushed to a registry):
scripts/build-release.sh --push
```

Output lands in `release/<version>/`. The image is built by the multi-stage
[`Dockerfile`](../Dockerfile): a builder stage compiles the packages + web panel
(with the native `better-sqlite3` addon), and a slim `node:22-bookworm-slim`
runtime stage runs the server and serves the built UI.

## Verifying a download

```bash
sha256sum -c SHA256SUMS.txt
```

## No bundled keys

Release artifacts contain **no development or production signing keys**. The
license verifier ships only a public key; the private signing key lives in the
separate closed-source issuer service (see
[PRIVATE_SERVICE_BOUNDARY.md](PRIVATE_SERVICE_BOUNDARY.md)).

## `.deb` packaging — later task

A native Debian package is **not** part of this beta. Producing a clean `.deb`
that bundles the Node runtime, the native SQLite addon (per-arch), and a systemd
unit needs its own packaging pipeline and reproducible-build setup. It is tracked
as a follow-up task. The supported beta install path is Docker via `install.sh`,
which works on Debian and Ubuntu for amd64 and arm64.
