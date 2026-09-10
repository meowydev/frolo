# Frolo — Implementation Tasks

Small, ordered tasks. Each references the requirements it satisfies. Everything
through the E2E mock milestone runs against fakes only; no real infrastructure is
touched, and **real mode stays hidden** until Phase 8. Do not start implementation
until the spec is approved.

The ordering is **vertical-slice-first**: Phases 0–5 build the minimum needed for
one working mock deployment through six screens. Phase 6 hardens crash recovery
and security depth. Phase 7 adds the remaining breadth (Teach recorder UI,
profiles, audit browsing, vault management). Phase 8 (deferred) adds real
providers.

## Phase 0 — Monorepo scaffold

- [ ] 0.1 Initialize pnpm workspace: root `package.json`, `pnpm-workspace.yaml`,
  `tsconfig.base.json`, shared lint/format config. (Req 13)
- [ ] 0.2 Create packages with project references and the enforced dependency
  graph: `core`, `contracts`, `providers-proxmox`, `providers-guest`,
  `providers-router`, `vault`, `store`, `controller`; apps `desktop`, `ui`;
  `fixtures/*`, `e2e`. Lint rule forbidding `ui` from importing providers/store/
  vault. (Req 13.1–13.3, 17.2–17.3)
- [ ] 0.3 Vitest + Playwright base config + CI script (typecheck + unit +
  e2e-mock). (Req 16)

## Phase 1 — Core domain (pure, no I/O)

- [ ] 1.1 Domain types & DTOs + zod schemas in `contracts`: connections,
  templates, VMs, network profiles, recipes + constraints, deployments,
  workflows, chains, five-tuple mappings, operation-journal entries. (Req 3–6, 12,
  19, 10.3)
- [ ] 1.2 Sanitizer in `core` (redact tokens, cookies, auth headers, CSRF, private
  keys, password-/token-/guest-key-bound values) + tests. (Req 11.3, 11.12)
- [ ] 1.3 Deployment state machine in `core`: states, allowed transitions,
  task-result gating, Failed-preserves-infra, retry entry keyed by journal +
  tests. (Req 6.1–6.9)
- [ ] 1.4 Network address resolution (DHCP/manual/VM-ID-derived, subnet
  validation) + tests. (Req 4.2–4.6)
- [ ] 1.5 Recipe schema + validator: known typed ops only; **per-op constraint
  enforcement** (writable-path allow-list w/ traversal+symlink guard, package
  allow-list, service allow-list); **checksum immutability** for built-ins; the
  built-in Nginx recipe + tests (incl. unknown-op and constraint-violation
  rejection). (Req 5.1–5.8, 5A.*)
- [ ] 1.6 Locator ranking + single-match/ambiguous/missing resolution + tests.
  (Req 8.3, 8.4, 9.1–9.3)
- [ ] 1.7 Chain planner: five-tuple per-hop targets, **equal-port MVP validation**,
  apply order, rollback order, teardown order + tests. (Req 10.1–10.7, 10.3a)

## Phase 2 — Provider interfaces, store, vault

- [ ] 2.1 Provider interfaces in `contracts`: `ProxmoxProvider`, `GuestProvider`
  (with `GuestTarget` trust fields), `RouterProvider` (with `RouterTrust`),
  `Vault`, `Store`, `Clock`, `Logger`. (Req 13.2, 18, 8.1b)
- [ ] 2.2 `store` (SQLite): migrations for every non-secret entity incl. the
  **operation journal** and five-tuple `mapping_record`; append-only transitions/
  audit; test asserting no secret columns exist. (Req 12, 19.1)
- [ ] 2.3 `vault`: exact encrypted-file format (versioned header + per-record
  IV/ciphertext/authTag), **random 256-bit keychain master key (no KDF/salt)**,
  atomic write, key rotation, deletion, locked/fail-closed state + round-trip and
  crash-safety tests with a fake keychain. (Req 11.1, 11.2, 20.*)

## Phase 3 — Mock providers & fixtures

- [ ] 3.1 Fake Proxmox provider: inventory, clone, configure, start, delete, async
  task polling (scriptable ok/error), DHCP readback + tests. (Req 14.1, 6.3, 6.4)
- [ ] 3.2 Fake Ubuntu guest provider: fs/service model **and trust flow** (accepts
  injected key, presents stable host key for TOFU, reports guest-agent
  availability), recipe op execution under constraints, `httpGet` serving the
  page, failure knobs (install fail, marker missing, host-key mismatch, agent
  absent) + tests. (Req 14.2, 5A.*, 18.*)
- [ ] 3.3 Router fixture A (normal labelled form) static site. (Req 14.3)
- [ ] 3.4 Router fixture B (generated ids, nested nav, loading states, confirm
  dialog) static site. (Req 14.4)
- [ ] 3.5 Router provider — replay path (Playwright) with `RouterTrust`: ranked
  resolution, stop-and-repair on ambiguous/missing, manual-checkpoint handling,
  resolve credential vars from vault, verify rule exists + tests against A and B.
  (Req 9.1–9.5, 8.2b, 8.1b)
- [ ] 3.6 **Pre-recorded fixture workflows** (login/create/find/delete) for A and
  B as assets, variable-references only + a test asserting no secret values.
  (Req 14.5a, 8.7, 8.8)
- [ ] 3.7 Simulated two-router NAT chain + reachability probe producing the
  simulated public address + tests. (Req 14.5, 10.8)

## Phase 4 — Controller & orchestration (in Electron main, IPC only)

- [ ] 4.1 Controller as an in-process library + composition root that binds fake
  providers by mode; **no network server**; typed handler layer callable over IPC.
  (Req 1.3, 1.6, 11.7, 13.3, 17.1)
- [ ] 4.2 Inventory handler: templates (QEMU cloud-init only) + VMs; sanitized
  errors. (Req 3.1–3.4)
- [ ] 4.3 **Operation journal service**: write-before-issue, record UPID, poll to
  result, and **startup reconciliation** (query UPID/target, no duplicate
  mutation, `needs_attention` path) + tests. (Req 19.*)
- [ ] 4.4 Deployment orchestrator: run steps through the state machine gated by the
  journal, persist every transition, sanitized logs, guest trust flow (key inject
  + TOFU), Failed preserves infra, retry keyed by idempotency. (Req 6.*, 5A.*,
  18.*, 11.10)
- [ ] 4.5 Exposure orchestrator: innermost-outward apply, per-hop verify,
  partial-failure rollback of only this operation's mappings, reverse-order
  teardown on delete. (Req 10.3–10.7)
- [ ] 4.6 Confirmation gates (open public ports; delete VM) + append-only
  sanitized audit for every sensitive action. (Req 7.4, 7.5, 11.9, 11.10)
- [ ] 4.7 Transition/journal event push to renderer over **IPC** (no SSE/socket).
  (Req 6.9, 15.5, 17.2)

## Phase 5 — Desktop shell & MVP six-screen slice

- [ ] 5.1 Electron main + preload: `contextIsolation` on, `nodeIntegration` off,
  narrow typed IPC allow-list with payload validation; main owns controller,
  providers, vault, keychain, Playwright. (Req 17.1–17.4, 13.1)
- [ ] 5.2 React/Vite renderer + typed IPC client; renderer has no direct provider
  access. (Req 13.1, 17.3)
- [ ] 5.3 Screen 1 — Welcome (mock mode only; **real mode hidden**; simulated-infra
  indicator). (Req 1.1, 1.2, 1.5)
- [ ] 5.4 Screen 2 — Inventory (templates + VMs, sanitized errors). (Req 3, 15.1)
- [ ] 5.5 Screen 3 — Deployment wizard (resources, network mode incl. VM-ID
  derivation, recipe = Nginx, optional exposure using pre-recorded fixture
  workflows). (Req 4, 5A, 7.1, 14.5a, 15.1)
- [ ] 5.6 Screen 4 — Plan / mutation review (protocol, public/internal ports, every
  hop + forwarding target, final VM address, deployment name) with explicit
  confirmations. (Req 7.2–7.5, 15.1)
- [ ] 5.7 Screen 5 — Live deployment timeline (observed status text, no fake
  animations). (Req 6.9, 15.4, 15.5)
- [ ] 5.8 Screen 6 — Deployment details + sanitized logs + local and simulated
  public addresses. (Req 5A.10, 10.8, 15.1)

## Phase 6 — End-to-end mock milestone (gate before Phase 7 breadth)

- [ ] 6.1 E2E mock happy path: configure VM → review plan → clone → configure
  networking → install Nginx → verify Nginx (marker) → replay taught workflows →
  verify mappings → show local + simulated public addresses. (Req 14.6, 16.3)
- [ ] 6.2 E2E mock failure path: recipe/task failure → Failed, infra preserved,
  sanitized reason shown, retry works without duplicate infra. (Req 6.4, 6.6, 6.7,
  19.6)
- [ ] 6.3 E2E crash-recovery: simulate crash after clone-issued-before-recorded →
  reconciliation confirms the existing VM and does **not** clone again. (Req 19.*)
- [ ] 6.4 E2E exposure partial-failure: outer hop fails → only this operation's
  mappings rolled back, pre-existing untouched. (Req 10.6)
- [ ] 6.5 Secret-hygiene assertions across the suite: no secret in SQLite, logs,
  audit, vault-plaintext, or recorded workflows; password steps carry no values;
  guest key never logged. (Req 11.3, 11.4, 12.2, 12.3, 18.8)

## Phase 7 — Remaining breadth (Stage-2 UI & recorder)

- [ ] 7.1 Router provider — **record path** (Playwright): open visible isolated
  window, capture all step types + multi-strategy locators, generated-id distrust,
  manual checkpoints, never store password values + tests on A and B. (Req 8.1–
  8.11, 11.4)
- [ ] 7.2 Connections handler + screen: add/validate, **Proxmox cert-fingerprint
  pin flow**, token secret stored in vault only. (Req 2.1–2.6, 11.5, 11.6)
- [ ] 7.3 Network profiles, Router profiles (with **per-profile router TLS trust/
  pin**), Chain editor screens + handlers. (Req 4, 8.1b, 8.11, 10.1, 10.2)
- [ ] 7.4 Teach recorder screen + editable recorded timeline (reorder/edit/delete/
  re-map, binding dropdown, secret fields show no value, step-repair panel).
  (Req 8.6–8.10, 9.2)
- [ ] 7.5 Recipe catalogue screen (name/version/ops, checksum status). (Req 5.5,
  5.6)
- [ ] 7.6 Retry & deletion flows; Vault status/management; Audit history browsing.
  (Req 6.7, 10.7, 11.9, 11.10, 20.4, 20.5)

## Phase 8 — Real providers (DEFERRED — real mode stays hidden until this ships)

- [ ] 8.1 Real `ProxmoxProvider` (HTTPS + restricted token + per-connection
  fingerprint pinning) behind the same interface. (Req 2, 11.6)
- [ ] 8.2 Real `GuestProvider` (SSH key auth + TOFU host key + guest-agent DHCP
  readback + passwordless sudo). (Req 18.*)
- [ ] 8.3 Real `RouterProvider` against a real router, user-supervised, with
  per-profile TLS trust. (Req 8.1b, 9)
- [ ] 8.4 Reveal real mode in the UI only after 8.1–8.3 are verified; require
  explicit switch out of mock mode. (Req 1.1, 1.4)

> Phase 8 is intentionally not started now. Per your instruction, Frolo stays in
> mock mode, real mode is hidden, and it does not connect to real Proxmox or
> routers until you approve.


---

## Addendum A — Web-panel pivot (completed)

The Electron desktop app was pivoted to a self-hosted web panel. All domain
logic, providers, vault, state machine, recipes, and their tests were preserved.

- [x] A.1 `@frolo/server` — Fastify on :4512, wraps the existing controller;
  auth (scrypt, session cookies, CSRF, login rate limit, session revocation);
  REST API mirroring the controller; SSE live events; health check; graceful
  shutdown; auth/setup DB migrations.
- [x] A.2 Accounts + recovery code (shown once, confirmed, never logged);
  local-terminal-only `frolo-reset-setup`; HTTP-not-HTTPS LAN warning +
  reverse-proxy docs.
- [x] A.3 OOBE backend (welcome → admin → recovery → validate Proxmox read-only →
  node/template detect → network profile → optional router/gateway → review →
  complete); no infra mutation; persisted non-secret progress; "Try Frolo safely"
  mock config.
- [x] A.4 Removed Electron (`apps/desktop` deleted); UI talks to the HTTP API.
- [x] A.5 MUI Material Design 2 web UI (light/dark/system, nav drawer, responsive,
  dialogs, snackbars, accessible forms, beta label, FAB, chips, linear progress,
  honest status; OOBE Material stepper with Back/Continue/Skip/Test
  Connection/Finish; no double-submit; progress preserved on reload).
- [x] A.6 Wired UI to Fastify API + SSE (login/logout, dashboard, wizard, live
  timeline, details, routers, recipes, vault/audit, mock-mode selection).
- [x] A.7 Dev/build tooling (`pnpm dev/build/test/typecheck/lint`), production
  Dockerfile, docker-compose (persistent volume, health check, graceful
  shutdown), `install.sh` (Debian/Ubuntu amd64+arm64; uninstall/update/backup/
  restore/diagnostics; rerun-safe; data preserved unless `--remove-data`).
- [x] A.8 Release artifacts (multi-arch image build config, compose bundle,
  checksums, install script; `.deb` documented as a later task; no keys bundled).
- [x] A.9 E2E tests (first setup, interrupted-setup recovery, login/logout, mock
  Nginx deployment, service restart + persistent data, installer safety, expired
  license preserves infra, unauthorized rejection).
- [x] A.10 Verified: typecheck clean, 148 tests pass, production build succeeds,
  and a live full-HTTP OOBE + mock deployment reaches Ready. No real Proxmox,
  guest, router, gateway, DNS, or Meowerity production service was contacted.
- [x] A.11 Specs + README + private-service boundary updated for the web
  architecture.

### Later (not part of this beta)
- [ ] Native `.deb` packaging pipeline (documented in docs/RELEASE.md).
- [ ] Additional template OS families (Debian, Rocky, Alma, Fedora, Alpine).
- [ ] Nginx gateway automation (create/connect gateway, Let's Encrypt, etc.).
