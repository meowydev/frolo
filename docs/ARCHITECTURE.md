# Frolo architecture

Frolo is a TypeScript monorepo (pnpm workspaces) that runs as two processes: the
Electron **main** process (owns everything privileged) and the **renderer** (pure
UI). There is no separate network-listening controller — the controller is a
library that runs inside Electron main.

```
┌───────────────────────────────────────────────────────────────┐
│ Electron MAIN process — owns everything privileged             │
│   Controller (library, in-process — NOT a network server)      │
│     orchestrator · state machine · recipe engine · chain planner│
│     operation journal + crash reconciliation · licensing        │
│   Providers (typed interfaces, fake now / real later)           │
│     ProxmoxProvider · GuestProvider · RouterProvider            │
│   Vault (AES-256-GCM) · Keychain adapter · Store (SQLite)       │
│   Playwright / Teach Mode Chromium (real mode)                  │
│   Clock · Logger · Sanitizer                                    │
└───────────────────────────────────────────────────────────────┘
        ▲  narrow, typed Electron IPC via preload
        │  (contextIsolation on, nodeIntegration off, sandbox on)
        ▼
┌───────────────────────────────────────────────────────────────┐
│ Renderer (React + Vite) — pure UI                              │
│   talks only through the preload IPC bridge                    │
│   NO direct access to providers / vault / SQLite / Playwright  │
└───────────────────────────────────────────────────────────────┘
```

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
  dev-only issuer, and an admin CLI contract.
- `@frolo/controller` — orchestration, journal service, exposure orchestrator,
  confirmation gates, audit, licensing surface, and the mock/real composition
  roots.
- `apps/desktop` — Electron main + preload.
- `apps/ui` — React renderer.

**Enforced rule:** `apps/ui` may import only `@frolo/contracts`. An ESLint rule
forbids importing providers, store, vault, controller, Playwright, or SQLite from
the UI.

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

connections metadata, network profiles, router profiles, workflows, router
chains, recipes (+ checksum), deployments, transitions (append-only), logs
(sanitized), the operation journal, five-tuple mapping records, and an
append-only audit trail. Secrets are referenced by key but their **values live
only in the vault**.

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

The composition root selects fake or real providers by mode. Mock mode is the
reference implementation and the test substrate. Real mode is wired behind the
same interfaces but is **hidden** until `FROLO_ENABLE_REAL_MODE=1` and the
real-mode safety tests are recorded as passing (see `real-readiness.ts`). No test
in this repository connects to real infrastructure.
