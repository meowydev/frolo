# Frolo production image (req: production Dockerfile). Multi-stage:
#  1) builder: installs deps, builds all packages + the web panel
#  2) runtime: slim Node image running the Fastify server, serving the built UI
#
# The image bundles ONLY the public app. No development or production signing
# keys are copied in (there are none in the repo). Data lives in a mounted
# volume at /opt/frolo/data.

# ---- Builder ----
FROM node:22-bookworm-slim AS builder
WORKDIR /build

# Build toolchain for better-sqlite3's native addon.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

# Install with the full workspace (lockfile + manifests first for cache).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY fixtures ./fixtures
COPY e2e ./e2e

RUN pnpm install --frozen-lockfile

# Build library packages, then the web panel.
RUN pnpm run build:packages \
 && pnpm --filter @frolo/ui build

# Prune dev dependencies for a smaller runtime node_modules.
RUN pnpm prune --prod

# ---- Runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    FROLO_PORT=4512 \
    FROLO_HOST=0.0.0.0 \
    FROLO_DATA_DIR=/opt/frolo/data \
    FROLO_WEB_ROOT=/app/web

# Minimal runtime deps (ca-certificates for outbound TLS to Proxmox in real mode).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates tini \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /app frolo \
 && mkdir -p /opt/frolo/data \
 && chown -R frolo:frolo /opt/frolo /app

# Copy the built workspace + node_modules from the builder.
COPY --from=builder --chown=frolo:frolo /build/node_modules ./node_modules
COPY --from=builder --chown=frolo:frolo /build/packages ./packages
COPY --from=builder --chown=frolo:frolo /build/package.json ./package.json
COPY --from=builder --chown=frolo:frolo /build/apps/ui/dist ./web

USER frolo
EXPOSE 4512
VOLUME ["/opt/frolo/data"]

# tini as PID 1 so SIGTERM reaches the server for graceful shutdown.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/server/dist/bin/frolo-server.js"]

# Container health check hits the unauthenticated /api/health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4512/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
