# Frolo — Design

## 1. Goals & non-goals

**Goals (first implementation milestone)**

- Deploy Nginx onto a Proxmox QEMU Ubuntu cloud-init template end-to-end
  (mock-backed now; real providers in Phase 7).
- Persistent, resumable deployment state machine driven by real task results,
  backed by an operation journal for idempotent crash recovery.
- Record/replay router port-forwarding via Teach Mode with semantic locators.
- Router chains with innermost-outward apply and reverse-order teardown.
- Strong secret hygiene: AES-256-GCM vault (random keychain master key), sanitized
  logs/audit, in-process controller reached only via Electron IPC.
- Explicit guest and router trust models.
- Mock-first: everything runs and is tested against fakes before real mutation;
  real mode is hidden until Phase 7 is verified.

**Non-goals (this milestone)**

- LXC containers.
- Recipes other than Nginx (engine is generic, catalogue ships one).
- Arbitrary/community scripts.
- Multi-user / remote controller access.
- Real Proxmox / real router connectivity (deferred to Phase 7).
- Per-hop port translation (five-tuple supports it; MVP requires equal ports).

## 2. High-level architecture

Frolo is a TypeScript monorepo (pnpm workspaces). It runs as **two processes**:
the Electron main process (which owns everything privileged) and the renderer
(pure UI). There is **no separate network-listening controller process** — the
controller is a library that runs inside Electron main. This resolves the earlier
ownership ambiguity: one process owns the controller, orchestrator, vault,
keychain, SQLite, and Playwright.

```
┌───────────────────────────────────────────────────────────────┐
│ Electron MAIN process — owns everything privileged             │
│                                                                │
│  Controller (library, in-process — NOT a network server)      │
│    - orchestrator, state machine, recipe engine, chain planner │
│    - operation journal + crash reconciliation                 │
│    - depends only on typed provider interfaces                 │
│                                                                │
│  Providers (typed interfaces, fake now / real later)           │
│    ProxmoxProvider │ GuestProvider │ RouterProvider            │
│  Vault (AES-256-GCM) │ Keychain adapter │ Store (SQLite)        │
│  Playwright / Teach Mode Chromium (visible, isolated)          │
│  Clock │ Logger │ Sanitizer                                    │
└───────────────────────────────────────────────────────────────┘
              ▲  narrow, typed Electron IPC via preload
              │  (contextIsolation on, nodeIntegration off)
              ▼
┌───────────────────────────────────────────────────────────────┐
│ Renderer (React + Vite) — pure UI                              │
│  - talks only through the preload IPC bridge                   │
│  - receives only serializable data + events                    │
│  - NO direct access to Proxmox / Playwright / SQLite / secrets │
└───────────────────────────────────────────────────────────────┘
```

**IPC trust model (req §17):** the renderer never reaches a socket. All calls go
through a fixed allow-list of typed IPC channels exposed by the preload script;
main validates every payload (zod) and rejects unknown channels. If an internal
HTTP surface is ever needed (e.g. for local tooling), it binds loopback on a
random port behind a per-launch unpredictable token, strict Origin checks, and
CSRF protection — but the shipping design uses IPC only, so no such surface is
exposed by default.

The **mode** selects which provider implementation is bound in a composition
root. While real providers are unimplemented (Phase 7), **only fakes are bound
and real mode is hidden** in the UI (req §1). Nothing above the provider layer
knows whether it is mock or real.

### 2.1 Monorepo layout

```
frolo/
  package.json                # pnpm workspace root
  pnpm-workspace.yaml
  tsconfig.base.json
  packages/
    core/            # domain types, state machine, recipe engine, chain planner,
                     # locator ranking, sanitizer — pure TS, no I/O
    contracts/       # provider interfaces + API DTOs + zod schemas (shared)
    providers-proxmox/   # ProxmoxProvider: fake + real (HTTP client)
    providers-guest/     # GuestProvider: fake + real (ssh/agent exec)
    providers-router/    # RouterProvider: fake fixtures + real (Playwright)
    vault/           # AES-256-GCM vault + OS keychain adapter
    store/           # SQLite store + migrations (non-secret only) + op journal
    controller/      # orchestrator, state machine, journal, DI composition root
                     # (library used by Electron main; NOT a standalone server)
  apps/
    desktop/         # Electron main (owns controller/providers/vault/Playwright)
                     #   + preload (narrow typed IPC bridge)
    ui/              # React + Vite renderer (pure UI)
  fixtures/
    router-a/        # static site: labelled form
    router-b/        # static site: generated ids, nested nav, loading, dialog
    nat-chain/       # simulated two-router NAT model
  e2e/               # Playwright + full mock workflow tests
```

Dependency rule (enforced by lint/`tsconfig` project refs):
`ui` → `contracts` only (types/DTOs; no runtime provider code). `desktop` (main)
→ `controller`, providers, `vault`, `store`. `controller` → `core`, `contracts`,
provider **interfaces**. `core` → nothing external. Providers → `contracts`
(+ their SDK). No package imports `store`, `vault`, or a provider from `ui`.

Note on Fastify: the earlier design named Fastify for the controller. Since the
controller is now in-process behind IPC, Fastify is **not** used to expose a
renderer-facing server. If an internal HTTP router is desired for structuring
handlers, it may be used strictly on loopback+random-port+token+Origin+CSRF, but
it is not part of the default runtime path.

## 3. Provider interfaces (the boundaries)

All defined in `packages/contracts`. Real and fake implementations conform to the
same interface; the controller only sees the interface.

```ts
// ProxmoxProvider — async Proxmox operations return task refs we must poll.
interface TaskRef { node: string; upid: string; }
interface TaskResult { status: "running" | "ok" | "error"; exitStatus?: string; }

interface ProxmoxProvider {
  validate(): Promise<CapabilityReport>;
  listTemplates(node: string): Promise<TemplateInfo[]>;      // QEMU cloud-init only
  listVms(node: string): Promise<VmInfo[]>;
  cloneTemplate(req: CloneRequest): Promise<TaskRef>;
  configureVm(req: ConfigureRequest): Promise<TaskRef>;
  startVm(node: string, vmid: number): Promise<TaskRef>;
  pollTask(ref: TaskRef): Promise<TaskResult>;
  deleteVm(node: string, vmid: number): Promise<TaskRef>;
  getGuestAddress(node: string, vmid: number): Promise<Ipv4 | null>; // DHCP readback
}

// GuestProvider — executes typed recipe operations inside the guest over SSH.
// Auth/trust model is explicit (see §9A): per-deployment SSH key, TOFU host key.
interface GuestTarget {
  address: Ipv4;
  sshUser: string;                 // cloud-init username
  privateKeyRef: SecretRef;        // vault ref, never inlined
  hostKeyFingerprint?: string;     // pinned on first connect (TOFU)
  guestAgentAvailable: boolean;    // required for DHCP readback
}
interface GuestProvider {
  // Verifies host key (TOFU): pins on first connect, fails on later mismatch.
  waitReachable(target: GuestTarget, timeoutMs: number): Promise<void>;
  run(target: GuestTarget, op: RecipeOperation): Promise<OpResult>;   // sudo per §9A
  httpGet(target: GuestTarget, path: string): Promise<{ status: number; body: string }>;
}

// RouterProvider — records & replays taught workflows; drives Playwright (real)
// Router TLS trust is per-profile and independent of Proxmox (§9).
interface RouterProvider {
  openTeachWindow(routerUrl: Url, trust: RouterTrust): Promise<TeachSession>; // visible, isolated
  record(session: TeachSession): AsyncIterable<RecordedStep>;   // manual checkpoints allowed
  replay(workflow: Workflow, vars: VarBindings, trust: RouterTrust): Promise<ReplayReport>;
  probeRule(workflow: Workflow, vars: VarBindings, trust: RouterTrust): Promise<RuleExistence>;
}
interface RouterTrust {
  scheme: "http" | "https";
  pinnedCertFingerprint?: string;  // per-router-profile pin; no global TLS bypass
}

// Vault — secrets only; never touches SQLite.
interface Vault {
  unlock(): Promise<void>;                 // pulls master key from keychain
  put(ref: SecretRef, value: string): Promise<void>;
  get(ref: SecretRef): Promise<string>;    // used only at replay/connect time
  status(): Promise<VaultStatus>;
}

// Store — non-secret persistence.
interface Store { /* CRUD for entities in §5; append-only audit + transitions */ }
```

The Playwright browser is owned by the **Electron main / provider layer**, never
by the renderer. The renderer receives only serializable `RecordedStep` and
`ReplayReport` events over IPC.

## 4. Deployment state machine

States and the only permitted transitions:

```
Queued ──▶ Cloning ──▶ Configuring ──▶ Booting ──▶ Installing ──▶ Checking
                                                                     │
                                                 ┌───────────────────┤
                                                 ▼                   ▼
                                             Exposing ──▶ Ready    Ready   (no exposure)
   any step ─────────────────────────────────────────────────────▶ Failed
   Failed ──▶ (retry) ──▶ <last safe step>
```

Rules:

- Each step is an async unit. Steps that call Proxmox obtain a `TaskRef` and
  block on `pollTask` until `ok` (advance) or `error` (→ Failed). Polling uses
  bounded backoff with an overall timeout.
- **Mutating steps are guarded by the operation journal (§4A).** The transition
  log records *state* history; the journal records *side-effect* facts (UPID,
  idempotency key, observed result). State advances only per the reconciled
  journal outcome. This closes the "crashed after clone but before recording
  success" gap: on restart, reconciliation finds the recorded UPID/target and
  never issues a duplicate clone.
- `Failed` preserves all infrastructure. No automatic deletion, ever.
- Retry re-enters at the earliest step whose journal entry is not `succeeded`
  (e.g. if clone succeeded and configure failed, retry starts at Configuring
  against the existing VM-ID, keyed by the same idempotency key).
- `Exposing` is skipped when the plan has no router chain; Checking → Ready.

## 4A. Operation journal & crash recovery (req §19)

The transition log alone cannot make mutations idempotent, so every mutating
external operation is bracketed by a journal entry:

```
operation(id, deployment_id, idempotency_key /* unique */, target /* node/vmid */,
          action /* clone|configure|start|delete|map_apply|map_delete */,
          upid?  /* external task id once known */,
          status /* pending|in_flight|succeeded|failed|needs_attention */,
          started_at, observed_result_sanitized?, reconciled_at?)
```

Flow per mutating op:

1. Insert `operation` with a deterministic `idempotency_key` (derived from
   deployment id + action + target) and `status=pending` **before** issuing.
2. Issue the Proxmox call; when a `TaskRef` returns, record `upid` and set
   `in_flight`.
3. Poll to result; set `succeeded`/`failed`; record sanitized result.

On startup, **reconciliation** runs for every `pending`/`in_flight` entry:

- If a `upid` exists, query Proxmox task status for that UPID.
- Else, inspect the target resource (does the VM-ID exist? is it configured/
  running? does the mapping exist per `probeRule`?).
- Resolve to `succeeded`/`failed`, or `needs_attention` when the truth is
  undeterminable — then surface it to the user rather than retrying blindly.

Because retries reuse the same `idempotency_key`, a confirmed-`succeeded` op is
never re-issued: no duplicate VMs, no duplicate mappings.

Step → state mapping:

| Step             | Enters state | Advances on                         |
|------------------|--------------|-------------------------------------|
| clone template   | Cloning      | clone task `ok`                     |
| configure vm     | Configuring  | configure task `ok`                 |
| start vm         | Booting      | start task `ok` + guest reachable   |
| run recipe ops   | Installing   | all install ops `ok`                |
| verify           | Checking     | HTTP marker found                   |
| expose (chain)   | Exposing     | all hops applied + verified         |
| finish           | Ready        | —                                   |

## 5. Data model (SQLite — non-secret only)

```
connection(id, name, host, node, token_id, cert_fingerprint?, pinned:boolean,
           mode_scope, created_at)          -- token SECRET lives in vault
template_cache(id, connection_id, vmid, name, kind, os_hint, cached_at)
vm_cache(id, connection_id, vmid, name, status, cores, ram_mb, disk_gb, seen_at)
network_profile(id, name, mode /* dhcp|manual|vmid */, subnet_cidr?, gateway?,
                address?, vmid_rule?, created_at)
router_profile(id, name, base_url, scheme /* http|https */,
               pinned_cert_fingerprint?, kind /* fixtureA|fixtureB|real */,
               created_at)                   -- router TLS trust is per-profile
workflow(id, router_profile_id, kind /* login|create|find|delete */, version,
         json /* steps + locators + bindings, NO secrets */, created_at)
router_chain(id, name, ordered_hops_json /* [{router_profile_id, wan_hint}] */)
recipe(id, name, version, source /* builtin */, checksum /* verified at load */,
       json /* declarative typed ops + per-op allow-lists */)
deployment(id, name, connection_id, template_vmid, target_vmid?, cores, ram_mb,
           disk_gb, hostname, ssh_user, network_profile_id, recipe_id, chain_id?,
           state, local_address?, public_address_sim?, created_at, updated_at)
           -- guest private key + host key live in the vault, keyed by deployment
deployment_transition(id, deployment_id, from_state, to_state, reason_sanitized,
                      at)                    -- append-only
deployment_log(id, deployment_id, level, message_sanitized, at)  -- sanitized
operation(id, deployment_id, idempotency_key, target, action, upid?,
          status, started_at, observed_result_sanitized?, reconciled_at?) -- §4A
mapping_record(id, deployment_id, hop_index, router_profile_id,
               listen_address, listen_port, target_address, target_port,
               protocol, applied:boolean, verified:boolean, at)  -- five-tuple §8
audit(id, actor, action, subject, detail_sanitized, at)          -- append-only
vault_meta(id, format_version, status)       -- NO key material, NO KDF/salt
```

Secrets that live **only in the vault**, keyed by `SecretRef`:
`proxmox_token_secret:<connection_id>`, `router_username:<router_profile_id>`,
`router_password:<router_profile_id>`, `guest_private_key:<deployment_id>`,
`guest_host_key:<deployment_id>`.

## 6. Recipe model (declarative, typed, versioned)

A recipe is JSON validated by a zod schema. Only these operation types exist in
v1; unknown types are rejected (no arbitrary scripts):

```ts
type RecipeOperation =
  | { type: "pkg.install"; packages: string[] }
  | { type: "file.write"; path: string; contentRef: string; mode?: string }
  | { type: "service.enable"; name: string }
  | { type: "service.start"; name: string }
  | { type: "http.check"; path: string; expectStatus: number; expectContains: string };

// Per-recipe allow-lists constrain what the typed ops may touch (req §5.7).
interface RecipeConstraints {
  writablePaths: string[];   // file.write must resolve within these dirs
  packages: string[];        // pkg.install must be a subset
  services: string[];        // service.enable/start must be a subset
}
```

Each operation maps to a `GuestProvider.run` / `httpGet` call. `contentRef`
points to a bundled asset (the Frolo test page) — never inline shell.

**Immutability & constraint enforcement (req §5.6–§5.8):**

- Built-in recipes are shipped as immutable assets with a bundled SHA-256
  checksum. At load, Frolo recomputes the checksum and refuses to run on
  mismatch — a tampered recipe cannot execute.
- Before executing any op, the engine enforces `RecipeConstraints`:
  - `file.write.path` is normalized and must resolve **within** `writablePaths`
    (no absolute escape, no `..` traversal, no symlink escape). The Nginx recipe
    allows only the web root (`/var/www/html`) and its own config path.
  - `pkg.install.packages` ⊆ `constraints.packages` (Nginx recipe: `["nginx"]`).
  - `service.*` name ∈ `constraints.services` (Nginx recipe: `["nginx"]`).
- A violation fails the operation with a sanitized reason and never reaches the
  guest.

**Nginx recipe (builtin, v1):**

1. `pkg.install nginx`
2. `file.write /var/www/html/index.html` ← Frolo test page (marker
   `FROLO-OK-<deployment-id>`)
3. `service.enable nginx`
4. `service.start nginx`
5. `http.check / 200 contains FROLO-OK-<deployment-id>`

The marker makes verification unambiguous and is what step 5A.8 checks.

## 7. Teach Mode: recording & locators

### 7.1 Recorded step schema

```ts
type Locator =
  | { by: "role"; role: string; name?: string }
  | { by: "label"; text: string }
  | { by: "id"; value: string; generated: boolean }
  | { by: "name"; value: string }
  | { by: "dataAttr"; attr: string; value: string }
  | { by: "nearbyText"; text: string; relation: "heading" | "row" }
  | { by: "domPath"; path: string }
  | { by: "coordinates"; x: number; y: number; lastResort: true };

interface RecordedStep {
  kind: "navigate" | "click" | "fill" | "fillSecret" | "select" | "check"
      | "enterFrame" | "waitLoad" | "confirmDialog" | "expectSuccess" | "verifyRule"
      | "manualCheckpoint";   // user acts by hand; not auto-replayed (req §8.2b)
  locators: Locator[];        // multiple strategies, ranked at replay
  binding?: FieldBinding;     // for fill/select/check
  meta: { url?: string; frame?: string; note?: string; manualReason?: string };
  // fillSecret NEVER carries a value; only a binding to a vault variable
}

type FieldBinding =
  | { kind: "fixed"; value: string }
  | { kind: "var"; name:
      | "router_username" | "router_password" | "internal_ip"
      | "internal_port" | "external_port" | "protocol" | "rule_name" }
  | { kind: "ask" };          // ask-during-deployment
```

Recording captures every available locator strategy for a target. `id` records
whether it looks generated (heuristic: long random/hashy segments) so ranking can
distrust it. Coordinates are only ever added when nothing else is capturable and
are flagged `lastResort`.

### 7.1a Supported surfaces & manual checkpoints (req §8.2a–§8.2c)

Semantic recording works on standard HTML admin pages, **open** shadow DOM, and
**accessible** iframes (same-origin or cross-origin frames that permit script
access). The following are explicitly **unsupported** for semantic capture:

- closed shadow DOM
- canvas-rendered UIs
- native browser auth dialogs (HTTP Basic, OS credential prompts)
- cross-origin frames that block script access

When a needed action lands on an unsupported surface, the recorder inserts a
`manualCheckpoint`: recording pauses, the user performs the action directly in
the visible Chromium window, then confirms. Manual steps are marked and are
**not** auto-replayed — at replay Frolo pauses and asks the user to perform them,
then continues. HTTP Basic auth is handled either by a manual checkpoint or by an
explicit credential prompt bound to `{{router_username}}`/`{{router_password}}`;
the typed credential is never captured.

### 7.2 Secret handling during recording

- `fillSecret` steps store **no keystrokes and no value** — only a `binding` of
  `{kind:"var", name:"router_password"}` (or username).
- The recorder intercepts input on password-type fields and records the step type
  without the text. This satisfies "never save password values during recording".

### 7.3 Replay locator ranking

At replay, each step's locators are resolved and scored. Suggested default order
(highest trust first):

1. accessible role + accessible name
2. associated label
3. stable `name` / `data-*` attribute
4. non-generated stable `id`
5. nearby heading / row text
6. DOM path
7. coordinates (last resort, only if explicitly present)

Resolution rule: pick the highest-ranked strategy that resolves to **exactly
one** element. If the best strategies disagree, resolve to multiple elements, or
resolve to zero, the step is **ambiguous/missing** → stop, do not click, and
raise a repair request to the user (req 9.2/9.3).

## 8. Router chains & exposure planning

Each hop is modeled as an explicit five-tuple
`{listenAddress, listenPort, targetAddress, targetPort, protocol}` (req §10.3).
Given an ordered chain from innermost (nearest VM) to outermost (internet edge)
and the VM address, the planner computes each hop:

```
hops = [Archer (innermost), Keenetic, modem (outermost)]
Archer   : listen (Archer WAN)   :P → target VM_IP        :P
Keenetic : listen (Keenetic WAN) :P → target Archer_WAN   :P
modem    : listen (modem WAN)    :P → target Keenetic_WAN :P
public address = modem WAN address:P   (simulated in mock)
```

**MVP constraint (req §10.3a):** the same port `P` is required at every hop
(`listenPort == targetPort` across all hops); the planner validates this before
exposure. The five-tuple already carries separate listen/target ports, so per-hop
translation is a later extension without a schema change.

Apply order = innermost → outermost. After each hop is applied, run that
router's **find mapping** workflow to verify (req 10.5). If hop *k* fails:

- roll back **only** the mappings created during this exposure operation, in
  reverse of their creation order, using each router's **delete mapping**
  workflow (req 10.6). Pre-existing rules are never touched.

Deployment deletion with exposure: remove mappings outermost → innermost (reverse
of apply), verifying each removal, **then** delete the VM (req 10.7), after the
explicit confirmation (req 11.9).

The mutation review screen (req 7.3) renders the full plan: protocol, public
port, internal port, each hop with its forwarding target, final VM address, and
deployment name — before any mutation.

## 9. Security boundaries

- **Vault**: see §9B for the exact file format and lifecycle. Summary: AES-256-GCM
  with a **random 256-bit master key** in the OS credential store; per-record
  random 96-bit IV; no KDF/salt (the key is random, not password-derived).
- **No secret in SQLite**: enforced by keeping secret writes exclusively in the
  vault API; a lint/test asserts no secret columns exist.
- **Sanitizer**: a single `sanitize()` in `core` runs on every log/audit string
  and every error surfaced to the UI. It redacts Authorization headers, `Cookie`,
  `Set-Cookie`, CSRF token fields, bearer/API tokens, private key blocks, and any
  value bound to `router_password`/`proxmox_token_secret`/guest keys. Nothing
  bypasses it.
- **Proxmox TLS**: default validation on. Per-connection pinning stores only the
  SHA-256 fingerprint the user approved; global `rejectUnauthorized=false` is
  never set.
- **Router TLS (independent of Proxmox)**: per-router-profile trust. HTTP routers
  are warned about and confined to the private address; self-signed HTTPS routers
  require the user to approve and pin a per-profile fingerprint. This trust store
  is entirely separate from the Proxmox trust store.
- **Guest trust (§9A)**: per-deployment SSH key (private key in vault), TOFU host
  key pinning, passwordless sudo via cloud-init, no stored guest password.
- **Network posture**: the controller is **in-process** and reached only via
  Electron IPC — it is not a network service. Any optional internal HTTP surface
  binds loopback on a random port with a per-launch token + Origin checks + CSRF.
  Frolo never opens SSH, Proxmox, controller, router-admin, or DB ports as part of
  a deployment; the only ports it ever opens are the user-approved public app
  ports on the routers.
- **Confirmation gates**: opening public ports and deleting a VM each require an
  explicit, separate final confirmation.
- **Audit trail**: append-only `audit` table; entries are pre-sanitized. No
  update/delete path is exposed.

## 9A. Guest access & trust model (req §18)

- **Auth**: SSH as the cloud-init user, using a **per-deployment key pair**. Frolo
  generates the pair, stores the private key in the vault
  (`guest_private_key:<deployment_id>`), and injects the public key + username via
  cloud-init at configure time. No password auth.
- **Sudo**: cloud-init grants the user passwordless sudo; recipe ops that need
  elevation use it. Frolo never prompts for or stores a guest sudo password.
- **Host-key verification (TOFU)**: on first connect Frolo pins the guest host key
  (`guest_host_key:<deployment_id>`); a later mismatch fails with a sanitized
  error instead of trusting silently.
- **DHCP discovery**: address is read back via the **QEMU guest agent** (required
  for DHCP). Manual and VM-ID-derived addressing do not require the agent. A
  missing required agent yields a clear sanitized error.
- **Mock parity**: the fake `GuestProvider` models key injection, TOFU pinning,
  and agent availability so these paths are exercised without real SSH.

## 9B. Vault file format & lifecycle (req §20)

Structure (single encrypted file, stored separately from SQLite):

```
header: { formatVersion, cipher: "AES-256-GCM", createdAt }
records: [ { ref: SecretRef, iv: <96-bit>, ciphertext, authTag }, ... ]
```

- **Master key**: random 256-bit, generated once and stored in the OS credential
  store. Because it is random, **no KDF and no salt** are used; per-record random
  IVs provide semantic security. (Resolves the earlier KDF/salt ambiguity.)
- **Atomic writes**: write temp file → fsync → rename over the vault, so a crash
  never leaves a half-written vault.
- **Key rotation**: create new keychain key → re-encrypt all records → atomic
  replace → remove old key. If interrupted, the vault still opens under the
  surviving key.
- **Deletion**: removing a record (or its owning connection/router/deployment)
  rewrites the vault atomically without that record.
- **Backup**: the file is safe to back up as-is (useless without the keychain
  key). Restoring without the matching keychain entry requires re-entering
  secrets; the vault **fails closed** and never silently accepts unreadable data.
- **Locked state**: if the keychain key is missing, the vault reports locked and
  refuses to fabricate or bypass decryption.

## 10. Mock mode design

- **Fake Proxmox**: in-memory inventory with a couple of QEMU cloud-init
  templates and existing VMs. `clone/configure/start/delete` return synthetic
  `TaskRef`s; `pollTask` transitions a task from `running` to `ok` after a few
  polls (and can be scripted to `error` for failure tests). Assigns VM-IDs and
  can hand back a DHCP address on `getGuestAddress`.
- **Fake Ubuntu guest**: models a filesystem + service table **and the trust
  flow** — it accepts an injected public key, presents a stable host key for TOFU
  pinning, and reports guest-agent availability for DHCP readback. `pkg.install`,
  `service.enable/start`, `file.write` mutate the model (subject to recipe
  constraints); `httpGet /` returns the written page so the marker check passes.
  Failure knobs (install fails, marker missing, host-key mismatch, agent absent)
  drive the Failed-path tests.
- **Pre-recorded fixture workflows** (req §14.5a): login/create/find/delete
  workflows for fixtures A and B ship as assets so the mock happy path can replay
  before the recorder UI exists. They contain only variable references.
- **Router fixture A**: static HTML with a normal labelled port-forward form
  (label→input associations, stable names).
- **Router fixture B**: static HTML with generated ids, a multi-step nested nav,
  artificial loading spinners, and a JS confirmation dialog on save — exercises
  waitLoad, enterFrame/nested nav, confirmDialog, and generated-id distrust.
- **Simulated NAT chain**: an in-memory model of two routers; applying a mapping
  registers a forward, and a "reachability probe" walks the chain to confirm a
  request to the simulated public address resolves to the VM. Produces the
  simulated public address shown in the UI.

Both fixtures are served statically so Playwright (record/replay) drives them
exactly like a real router UI — the same `RouterProvider` code path as real.

## 11. UI design

- React + Vite renderer, one typed client that calls the **preload IPC bridge**
  (not a network client). State via a light store; server state via query hooks
  over IPC.
- **Delivered in two stages** (req §15): the **MVP vertical slice** ships six
  screens that run the mock happy path end-to-end — Welcome (mock), Inventory,
  Deployment Wizard, Plan/Mutation Review, Live Timeline, Deployment Details.
  Real mode is hidden. Exposure in the MVP wizard replays the **pre-recorded
  fixture workflows** (§10), so the Teach Recorder UI is not required for the
  slice.
- **Stage 2** adds: Connections, Network Profiles, Router Profiles, Chain Editor,
  Teach Recorder, editable Recorded Timeline (with step-repair), Recipe
  Catalogue, Retry/Delete flows, Vault Status, Audit History.
- Live timeline subscribes to controller transition/journal events pushed over
  **IPC** and renders persisted history. **No fake terminal animations**; each
  line states what Frolo observed (e.g. "Clone task ok (upid …)", "HTTP 200,
  marker found", "Archer mapping verified").
- Teach recorder shows the live isolated Chromium externally; the timeline in-app
  lists recorded steps with their captured locators and a binding dropdown per
  field. Ambiguous replay steps surface a repair panel.

## 12. Testing strategy

- **Vitest (core/unit)**: state-machine transitions incl. task-poll gating and
  Failed preservation; **operation journal reconciliation** (crash-after-clone →
  no duplicate clone; needs_attention path); recipe schema validation + unknown-op
  rejection + **constraint enforcement (path/pkg/service allow-lists) and checksum
  immutability**; sanitizer redaction; locator ranking
  (single-match/ambiguous/missing); chain planner five-tuple targets + equal-port
  validation + apply/rollback/teardown order; vault encrypt/decrypt round-trip,
  atomic write, rotation, and locked-state with a fake keychain; guest TOFU
  host-key mismatch handling.
- **Playwright (router)**: record then replay create/find/delete/login against
  fixture A and fixture B, including B's loading/dialog/nested-nav; assert
  password steps never carry values; assert ambiguous step stops and requests
  repair.
- **E2E mock (req 14.6 / 16.3)**: full workflow configure→review→clone→configure
  network→install→verify→replay chain→verify mappings→show local + simulated
  public addresses; plus a Failed-path variant asserting infra is preserved and
  the sanitized reason is shown.
- No test touches real Proxmox or real routers (req 16.4).

## 13. Key risks & decisions

- **Task polling correctness** is central: state never advances on request
  acceptance, only on task result. Backoff + overall timeout, timeout → Failed
  (infra preserved).
- **Locator brittleness**: mitigated by multi-strategy capture + ranked
  single-match resolution + explicit repair instead of guessing.
- **Secret leakage**: mitigated by single mandatory sanitizer, vault-only
  secrets, `fillSecret` never carrying values, and a test asserting no secret ever
  reaches SQLite/logs/audit.
- **Provider seam**: real implementations are added later behind the same
  interfaces; mock mode is the reference implementation and the test substrate.
