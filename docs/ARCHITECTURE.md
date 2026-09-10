# Frolo architecture

Frolo is a TypeScript monorepo (pnpm workspaces) deployed as a **self-hosted web
panel**. It runs as the **Frolo local controller** — a single service on the
user's dedicated Frolo VM, listening on port **4512** — plus a **browser panel**
that is a pure UI client. Everything privileged (Proxmox/SSH/router automation,
the SQLite store, the encrypted vault) runs inside the local controller. The
browser **never** connects directly to Proxmox, SSH, SQLite, the vault, or
routers; it talks only to the controller's authenticated HTTP API on the same
origin.

```
                    Browser panel (React + Vite + MUI) — pure UI
                      · same-origin fetch + CSRF header
                      · EventSource (SSE) for live deployment events
                      · NO direct access to Proxmox / SSH / SQLite / vault / routers
                                   │
                                   │  HTTPS/HTTP on :4512 (LAN-only by default;
                                   │  put behind your own HTTPS reverse proxy)
                                   ▼
┌───────────────────────────────────────────────────────────────┐
│ Frolo local controller (packages/server, Fastify) — :4512      │
│   Auth (sessions, CSRF, Origin checks, rate limiting)          │
│   Controller (in-process library)                              │
│     orchestrator · state machine · recipe engine · chain planner│
│     operation journal + crash reconciliation · licensing        │
│   Providers (typed interfaces; fake by default, real when       │
│     explicitly enabled)                                         │
│     ProxmoxProvider · GuestProvider · RouterProvider            │
│   Vault (AES-256-GCM) · Keychain adapter · Store (SQLite)       │
│   Playwright / Teach Mode Chromium (real mode)                  │
│   Source updater · Clock · Logger · Sanitizer                   │
└───────────────────────────────────────────────────────────────┘
```

The controller and the built panel are served together from one process (the
panel's static files are served by the same Fastify server). The controller
never opens a router mapping to expose itself; remote access is the operator's
responsibility via their own HTTPS reverse proxy.

## Packages and the dependency rule

- `@frolo/contracts` — shared types, zod schemas, provider **interfaces**, the
  IPC contract, and the public licensing/entitlement contract.
- `@frolo/core` — pure domain logic: sanitizer, deployment state machine, network
  resolver, recipe engine (validation + constraints + checksum), locator ranking,
  chain planner. No I/O.
- `@frolo/vault` — AES-256-GCM vault, atomic file store, OS keychain adapter.
- `@frolo/store` — SQLite store + operation journal (non-secret only).
- `@frolo/providers-*` — Proxmox / Guest / Router providers, each with a fake and
  a real implementation behind the same interface.
- `@frolo/licensing` — offline signed-license verifier (public key only), a
  **dev-only** issuer (disabled in production builds), and the admin CLI contract.
- `@frolo/controller` — orchestration, journal service, exposure orchestrator,
  confirmation gates, audit, licensing surface, and the mock/real composition
  roots.
- `packages/server` — the **Frolo local controller**: Fastify HTTP API + auth +
  SSE, connection management, the source updater, and static hosting of the built
  panel. This is the only network-listening process.
- `apps/ui` — the React + Vite + MUI browser panel (pure UI client).

Not part of this repo: **`frolo-server/`** (private, gitignored) is a separate
service that holds the production license-signing key and subscriber data. See
[PRIVATE_SERVICE_BOUNDARY.md](PRIVATE_SERVICE_BOUNDARY.md).

**Enforced rule:** `apps/ui` may import only `@frolo/contracts`. An ESLint rule
forbids importing providers, store, vault, controller, Playwright, or SQLite from
the UI. The browser reaches privileged capability only through the controller's
authenticated HTTP API.

## Deployment state machine

```
Queued → Cloning → Configuring → Booting → Installing → Checking
                                                          ├─→ Exposing → Ready
                                                          └─→ Ready (no exposure)
any active step ───────────────────────────────────────────────────→ Failed
```

- Mutating Proxmox steps return a task id; the controller **polls to result** and
  advances only on success.
- Every mutation is bracketed by an **operation journal** entry (idempotency key,
  target, UPID, status). On startup, unresolved entries are **reconciled** by
  inspecting the actual resource — so a crash never causes a duplicate clone.
- `Failed` **preserves** all infrastructure; deletion is a separate, confirmed
  flow.

## Data model (SQLite, non-secret only)

Proxmox connection metadata (non-secret: host, node, token id, pinned cert
fingerprint), the single-row runtime config (active mode + selected connection),
network profiles, router profiles, workflows, router chains, recipes (+
checksum), deployments, transitions (append-only), logs (sanitized), the
operation journal, five-tuple mapping records, and an append-only audit trail.
Secrets (Proxmox API tokens, router credentials, SSH keys) are referenced by key
but their **values live only in the vault**.

## Teach Mode (record & replay)

- Recording captures multiple locator strategies per element (accessible role +
  name, label, stable name/data attribute, non-generated id, nearby heading/row
  text, DOM path), distrusts generated ids, and uses screen coordinates only as
  an explicitly-marked last resort. Password fields are recorded as `fillSecret`
  with a variable binding and **no value**.
- Replay ranks the strategies and picks the highest-ranked strategy that resolves
  to exactly one element. If a target is missing or ambiguous, it **stops and
  asks the user to repair the step** — it never guesses.

## Router chains

Each hop is an explicit five-tuple
`{listenAddress, listenPort, targetAddress, targetPort, protocol}`. The innermost
router forwards to the VM; each outer router forwards to the WAN address of the
router immediately inside it. Mappings are applied innermost→outermost and each is
verified; on failure only this operation's mappings are rolled back (reverse
order). On delete, mappings are torn down outermost→innermost before the VM is
removed. The MVP requires equal ports at every hop.

## Mock vs real

The controller selects fake or real providers by mode. **Mock mode is the
default** — it is the reference implementation and the test substrate, and the
whole first-run setup (OOBE) and demo flow run entirely on fakes with **no
infrastructure contact**.

Real mode is wired behind the same interfaces and is enabled explicitly:

1. The readiness gate must be open: `FROLO_ENABLE_REAL_MODE=1` **and** the
   real-mode safety tests recorded as passing (`FROLO_REAL_SAFETY_TESTS_PASSED=1`;
   see `real-readiness.ts`).
2. A Proxmox connection must be configured. Its non-secret metadata (host, node,
   token id, pinned cert SHA-256) lives in SQLite; the **API token secret lives
   only in the vault**.
3. The operator flips real mode on (Settings → Proxmox connections). Providers
   rebind on the next controller restart.

Real providers are **never even constructed** unless all of the above hold, so
mock stays fully working and setup never touches infrastructure. The real
providers use certificate-pinned HTTPS (Proxmox), TOFU host-key SSH (guest), and
a Playwright-driven router driver. Two endpoints reach infrastructure and only on
an explicit operator click: fetch-certificate-fingerprint (for pin review) and
read-only connection validate. No test in this repository connects to real
infrastructure.

## Software updates

The local controller can update itself from **source** when a release root is
configured (`FROLO_RELEASE_ROOT`). The updater (`packages/server/src/updater.ts`)
only installs **tagged** GitHub releases of `meowydev/frolo` (never an unpinned
branch), verifies the source archive's SHA-256 against the release's
`SHA256SUMS` **before** extracting, builds locally, atomically swaps a `current`
symlink, restarts, health-checks, and **auto-rolls back** to the previous release
on any failure. Docker installs update instead by pulling a new pinned image tag
(`install.sh update <tag>`, which downloads and checksum-verifies the compose
bundle). The panel's Settings screen and the `frolo-update` CLI drive updates.

## Licensing & the private boundary

The app verifies licenses **offline** with a bundled **public** key; it never
needs a network service to run. Signed licenses come from the private
`frolo-server` (admin panel on `:2444`, localhost-bound) which holds the
production Ed25519 **private** signing key and subscriber data. Development
"dev-fake" licenses are refused by production builds — the dev issuer and dev CLI
throw unless `FROLO_DEV=1` (or `FROLO_ALLOW_DEV_LICENSE_KEYS=1`), and the
controller rejects development-environment keys by default. Expiration only
disables paid conveniences and reverts to the free Home tier; it never deletes or
stops VMs, mappings, recipes, files, or deployments.
