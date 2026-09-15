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
IMAGE="${FROLO_IMAGE:-ghcr.io/meowydev/frolo}"
OUT="release/${VERSION}"
PLATFORMS="${FROLO_PLATFORMS:-linux/amd64}"

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
sed "s#\${FROLO_IMAGE:-ghcr.io/meowydev/frolo:0.1.0-beta.1}#${IMAGE}:${VERSION}#" \
  docker-compose.yml > "${OUT}/docker-compose.yml"
cp install/install.sh "${OUT}/install.sh"
chmod +x "${OUT}/install.sh"

# 3) Source archive for the source-based updater (packages/server updater.ts).
#    IMPORTANT: the updater downloads THIS EXACT named release asset
#    (frolo-<version>.tar.gz) and verifies it against SHA256SUMS.txt — it never
#    uses GitHub's auto-generated tag tarball, whose bytes differ. We build it
#    from a clean `git archive` of the tagged commit so the bytes (and therefore
#    the checksum) are reproducible: attach both this file and SHA256SUMS.txt to
#    the GitHub release so `frolo-update` can fetch and verify them.
SRC_TARBALL="frolo-${VERSION}.tar.gz"
if git -C . rev-parse >/dev/null 2>&1; then
  echo "Creating source archive ${SRC_TARBALL} from git (prefix frolo-${VERSION}/)…"
  git archive --format=tar.gz --prefix="frolo-${VERSION}/" -o "${OUT}/${SRC_TARBALL}" HEAD
else
  echo "Not a git checkout — skipping source archive (CI builds it from the tag)." >&2
fi

# 4) Checksums for ALL shipped files, including the source archive. The updater's
#    SHA256SUMS parser matches the <version> tar.gz entry.
(
  cd "${OUT}"
  files=(docker-compose.yml install.sh)
  [ -f "${SRC_TARBALL}" ] && files+=("${SRC_TARBALL}")
  shasum -a 256 "${files[@]}" > SHA256SUMS.txt
)

echo "Artifacts written to ${OUT}:"
ls -la "${OUT}"
echo
echo "Publishing (CI): upload the multi-arch image to ghcr.io/meowydev/frolo and"
echo "attach docker-compose.yml, install.sh, ${SRC_TARBALL}, and SHA256SUMS.txt to"
echo "the GitHub release for tag ${VERSION} at github.com/meowydev/frolo."
echo
echo "NOTE: .deb packaging is tracked as a later task (see docs). The supported"
echo "beta install paths are Docker via install.sh and source via frolo-update."
