# Frolo beta release artifacts

Frolo ships as a **Docker-based self-hosted web panel**, not a standalone binary.
The beta release consists of:

| Artifact | What it is |
| --- | --- |
| `ghcr.io/meowydev/frolo:<version>` | Multi-arch container image (**linux/amd64** + **linux/arm64**) running the Fastify server + built web panel |
| `docker-compose.yml` | Deploy bundle pinned to the release image, with a persistent data volume + health check |
| `install.sh` | Installer for Debian/Ubuntu (amd64/arm64): installs/validates Docker, writes `/opt/frolo`, pulls the pinned image, starts it, waits for health, prints the ready URL |
| `frolo-<version>.tar.gz` | Source archive consumed by the in-app source updater (`frolo-update`) — checksum-verified before build |
| `SHA256SUMS.txt` | Checksums for the shipped `docker-compose.yml`, `install.sh`, and source archive |

All artifacts are published on the GitHub release for the tag at
[github.com/meowydev/frolo](https://github.com/meowydev/frolo/releases).

## Automated release (GitHub Actions)

Releases are produced **only** by pushing an explicit semantic-version tag:

```bash
git tag v0.1.0-beta.2
git push origin v0.1.0-beta.2
```

`.github/workflows/release.yml` then:

1. runs the full CI gate (lint, typecheck, tests, production build, `pnpm audit --prod`);
2. builds and pushes the **multi-arch** image (`linux/amd64` + `linux/arm64`) to
   `ghcr.io/meowydev/frolo:<version>` and `:latest`;
3. produces the deploy bundle + the **exact** `frolo-<version>.tar.gz` source
   archive (via `git archive` from the tagged commit) + `SHA256SUMS.txt`;
4. self-verifies the checksums (`sha256sum -c`) before publishing; and
5. creates the GitHub Release and uploads all four assets.

The workflow never publishes off `main`/`latest`/a branch — only a version tag.

## Building the artifacts locally

```bash
# Local (single arch, loaded into the local Docker):
FROLO_IMAGE=frolo scripts/build-release.sh --load --platform linux/amd64

# CI (multi-arch, pushed to a registry):
scripts/build-release.sh --push
```

Output lands in `release/<version>/`. The image is built by the multi-stage
[`Dockerfile`](../Dockerfile): a builder stage compiles the packages + web panel
(with the native `better-sqlite3` addon), and a slim `node:22-bookworm-slim`
runtime stage runs the server, serves the built UI, and installs the real
runtime dependencies used in real mode:

- **`ssh2`** — the real guest provider's SSH transport (per-deployment key auth,
  TOFU host-key verification, typed recipe execution).
- **`playwright` + Chromium** — router Teach Mode recording and replay. Chromium
  and its Linux libraries are installed into `PLAYWRIGHT_BROWSERS_PATH`
  (`/opt/frolo/pw-browsers`) via `playwright install --with-deps chromium`, and
  the build fails early if Chromium cannot launch (`scripts/chromium-smoke.mjs`).

## The source updater and checksum coherence

The in-app source updater (`frolo-update`, and the panel's Updates screen)
downloads the **named release asset** `frolo-<version>.tar.gz` — the exact file
`SHA256SUMS.txt` covers — and verifies its SHA-256 **before** extracting and
building. It never downloads GitHub's auto-generated tag tarball (whose bytes
differ and would never match the published checksum), and it only installs
tagged releases (never `main`/`latest`/an unpinned ref). Because the archive is
produced with `git archive` from the tagged commit, its bytes are reproducible
and the checksum is stable.

## Verifying a download

```bash
sha256sum -c SHA256SUMS.txt
```

## Security posture of the image

- The web panel is served by `@fastify/static` **v10+**, which fixes the known
  path-traversal and authorization-bypass advisories (route-guard bypass,
  encoded-separator bypass, non-canonical-URL auth bypass). `pnpm audit --prod`
  reports no known vulnerabilities and CI fails on any high/critical advisory.
- Real Proxmox/SSH/router automation is **off by default**. It requires
  `FROLO_ENABLE_REAL_MODE=1` **and** `FROLO_REAL_SAFETY_TESTS_PASSED=1` **and** an
  operator-selected Proxmox connection in the panel.
- The private issuer (`frolo-server/`), production signing key, and subscriber
  data are excluded from the build context by `.dockerignore` and never appear
  in the image or its layers.

## No bundled keys

Release artifacts contain **no development or production signing keys**. The
license verifier ships only a public key; the private signing key lives in the
separate private `frolo-server` issuer service (see
[PRIVATE_SERVICE_BOUNDARY.md](PRIVATE_SERVICE_BOUNDARY.md)).

## `.deb` packaging — later task

A native Debian package is **not** part of this beta. Producing a clean `.deb`
that bundles the Node runtime, the native SQLite addon (per-arch), and a systemd
unit needs its own packaging pipeline and reproducible-build setup. It is tracked
as a follow-up task. The supported beta install path is Docker via `install.sh`,
which works on Debian and Ubuntu for amd64 and arm64.
