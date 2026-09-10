#!/usr/bin/env bash
# Build Frolo beta release artifacts (req: versioned amd64 + arm64 container
# images, docker-compose bundle, checksums, install script).
#
# Produces, under ./release/<version>/:
#   - multi-arch container image (loaded/pushed via buildx)
#   - docker-compose.yml (deploy bundle)
#   - install.sh
#   - SHA256SUMS.txt  (checksums for the shipped files)
#
# NO development or production signing keys are bundled — there are none in the
# repo, and this script never generates any.
set -euo pipefail

VERSION="${FROLO_VERSION:-0.1.0-beta.1}"
IMAGE="${FROLO_IMAGE:-ghcr.io/meowerity/frolo}"
OUT="release/${VERSION}"
PLATFORMS="linux/amd64,linux/arm64"

echo "Building Frolo ${VERSION} release artifacts…"
mkdir -p "${OUT}"

# 1) Multi-arch image. Requires docker buildx. Use --push for a registry, or
#    --load (single arch) for local testing.
if docker buildx version >/dev/null 2>&1; then
  echo "Building multi-arch image ${IMAGE}:${VERSION} (${PLATFORMS})…"
  docker buildx build \
    --platform "${PLATFORMS}" \
    -t "${IMAGE}:${VERSION}" \
    -t "${IMAGE}:beta" \
    "${@:---output=type=image,push=false}" \
    .
else
  echo "docker buildx not available — skipping image build (build it in CI)." >&2
fi

# 2) Deploy bundle: compose + installer, pinned to this version.
sed "s#\${FROLO_IMAGE:-ghcr.io/meowerity/frolo:0.1.0-beta.1}#${IMAGE}:${VERSION}#" \
  docker-compose.yml > "${OUT}/docker-compose.yml"
cp install/install.sh "${OUT}/install.sh"
chmod +x "${OUT}/install.sh"

# 3) Checksums for the shipped files.
( cd "${OUT}" && shasum -a 256 docker-compose.yml install.sh > SHA256SUMS.txt )

echo "Artifacts written to ${OUT}:"
ls -la "${OUT}"
echo
echo "NOTE: .deb packaging is tracked as a later task (see docs). The supported"
echo "beta install path is Docker via install.sh."
