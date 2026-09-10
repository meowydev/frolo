# Frolo — Requirements

## Overview

Frolo is a cross-platform desktop application that helps homelab users deploy
applications onto Proxmox VE. It clones a QEMU Ubuntu cloud-init template,
configures the VM (CPU, RAM, disk, hostname, networking), boots it, installs a
declarative application recipe, verifies the application, and optionally exposes
it through one or more of the user's routers using recorded ("taught") browser
workflows.

The **first implementation milestone** ships in **mock mode only**. All external
systems (Proxmox, the guest OS, routers, the NAT chain) are backed by fakes so
the entire workflow can be built and tested before any real infrastructure is
mutated. Real providers arrive in a later milestone (Phase 7). Until real
providers are implemented and verified, **real mode is hidden entirely** — it is
not shown, not selectable, and not reachable in the UI.

### Scope of first implementation milestone

- QEMU Ubuntu cloud-init templates only. **No LXC.**
- One official recipe: **Nginx**.
- Router automation via **Frolo Teach Mode** (record + replay).
- Router chains (e.g. Internet → modem → Keenetic → Archer C6U → VM).
- Mock-first: fake Proxmox, fake guest, two router fixtures, simulated NAT chain.

### Definitions

- **EARS**: Easy Approach to Requirements Syntax. Requirements use the keywords
  WHEN / IF / WHILE / WHERE + THE SYSTEM SHALL.
- **Controller**: the local Fastify API process that orchestrates deployments.
- **Recipe**: a declarative, versioned list of known typed operations.
- **Taught workflow**: a recorded sequence of router UI steps with semantic
  locators and variable bindings.
- **Hop**: one router in a router chain.
- **Sanitized**: with all secrets (passwords, tokens, cookies, private keys,
  authorization headers, CSRF values) removed or redacted.

### Actors

- **User**: the homelab operator using the desktop app.
- **Frolo controller**: local orchestration service.
- **Proxmox provider**: fake or real Proxmox VE API.
- **Router provider**: fake or real router UI driven by Playwright.

---

## 1. Application shell & modes

- **1.1** WHILE real providers (Phase 7) are not yet implemented and verified, THE
  SYSTEM SHALL hide real mode completely: it SHALL NOT be displayed, selectable,
  or reachable anywhere in the UI, and THE SYSTEM SHALL operate exclusively in
  mock mode.
- **1.2** WHEN the application starts for the first time, THE SYSTEM SHALL display
  a welcome screen that introduces mock mode and lets the user proceed; no mode
  choice is offered while real mode is hidden.
- **1.3** WHILE mock mode is active, THE SYSTEM SHALL route every external
  operation (Proxmox, guest, routers, NAT) to fake implementations and SHALL NOT
  open any network connection to real infrastructure.
- **1.4** WHERE real mode becomes available in a later milestone, THE SYSTEM SHALL
  require at least one validated Proxmox connection before enabling deployment in
  real mode, and SHALL require an explicit switch out of mock mode.
- **1.5** THE SYSTEM SHALL display the active mode persistently in the UI. WHILE
  only mock mode exists, THE SYSTEM SHALL clearly indicate that Frolo is running
  against simulated infrastructure.
- **1.6** THE SYSTEM SHALL NOT expose the controller as a network-reachable
  service. Renderer↔controller communication SHALL use Electron IPC through the
  preload bridge; see §17 for the process and IPC trust model.

## 2. Proxmox connections

- **2.1** WHEN the user adds a Proxmox connection, THE SYSTEM SHALL require a host
  address, a node name, and an API token id + secret.
- **2.2** THE SYSTEM SHALL store the Proxmox API token secret only in the
  encrypted vault and SHALL NOT persist it in SQLite or logs.
- **2.3** WHEN a Proxmox connection uses a certificate that does not chain to a
  trusted root, THE SYSTEM SHALL present the certificate fingerprint and require
  explicit user approval to pin it for that one connection.
- **2.4** THE SYSTEM SHALL NOT disable TLS validation globally; certificate
  pinning SHALL apply only to the specific approved connection.
- **2.5** WHEN the user validates a connection, THE SYSTEM SHALL perform a
  read-only capability check and report success or the sanitized failure.
- **2.6** THE SYSTEM SHALL treat the Proxmox API token as a dedicated restricted
  token and SHALL document the minimum required privileges.

## 3. Inventory

- **3.1** WHEN a validated connection exists, THE SYSTEM SHALL list available
  QEMU cloud-init templates for the selected node.
- **3.2** THE SYSTEM SHALL list existing VMs with their VM-ID, name, status, and
  resource summary.
- **3.3** IF the inventory query fails, THEN THE SYSTEM SHALL show the sanitized
  error and SHALL NOT fabricate inventory entries.
- **3.4** THE SYSTEM SHALL identify which listed templates are QEMU cloud-init
  templates and SHALL exclude LXC entries from selection.

## 4. Network profiles

- **4.1** THE SYSTEM SHALL allow the user to create reusable network profiles.
- **4.2** THE SYSTEM SHALL support three IPv4 addressing modes: DHCP, manual
  IPv4, and VM-ID-derived IPv4.
- **4.3** WHERE manual IPv4 is selected, THE SYSTEM SHALL require an address,
  prefix/netmask, and gateway, and SHALL validate them.
- **4.4** WHERE VM-ID-derived IPv4 is selected, THE SYSTEM SHALL require a base
  subnet and a deterministic rule, and SHALL compute the address from the VM-ID.
- **4.5** WHERE DHCP is selected, THE SYSTEM SHALL request an address from the
  guest and SHALL read back the assigned address after boot.
- **4.6** THE SYSTEM SHALL validate that a manual or derived address is within the
  configured subnet before allowing deployment.

## 5. Recipes

- **5.1** THE SYSTEM SHALL represent recipes as declarative, versioned documents
  composed only of known typed operations.
- **5.2** THE SYSTEM SHALL NOT execute arbitrary or community-supplied scripts.
- **5.3** WHEN a recipe references an operation type that is not in the known
  typed set, THE SYSTEM SHALL reject the recipe with a validation error.
- **5.4** THE SYSTEM SHALL provide the Nginx recipe as the first official recipe.
- **5.5** THE SYSTEM SHALL display a recipe catalogue with each recipe's name,
  version, and the operations it performs.
- **5.6** THE SYSTEM SHALL treat built-in recipes as immutable and SHALL verify
  each built-in recipe against a bundled checksum at load time. IF the checksum
  does not match, THEN THE SYSTEM SHALL refuse to run the recipe.
- **5.7** THE SYSTEM SHALL constrain each operation type with an allow-list:
  - **5.7a** `file.write` SHALL only target paths within a configured allow-listed
    set of directories (e.g. the web root and specific config paths) and SHALL
    reject absolute paths outside that set, path traversal, and symlink escapes.
  - **5.7b** `pkg.install` SHALL only accept package names from the recipe's
    declared allow-list.
  - **5.7c** `service.enable` and `service.start` SHALL only accept service names
    from the recipe's declared allow-list.
- **5.8** WHEN any operation violates its constraint (5.7), THE SYSTEM SHALL reject
  the recipe or fail the operation with a sanitized reason and SHALL NOT execute
  it against the guest.

### 5A. Nginx recipe behavior

- **5A.1** WHEN the Nginx recipe runs, THE SYSTEM SHALL clone the selected Ubuntu
  cloud-init template.
- **5A.2** THE SYSTEM SHALL configure CPU cores, RAM, and disk size per the plan.
- **5A.3** THE SYSTEM SHALL apply the selected networking mode (DHCP, manual, or
  VM-ID-derived) and hostname.
- **5A.4** THE SYSTEM SHALL start the VM and wait until the guest is reachable.
- **5A.5** THE SYSTEM SHALL install Nginx on the guest.
- **5A.6** THE SYSTEM SHALL create a recognizable Frolo test page containing a
  known marker string.
- **5A.7** THE SYSTEM SHALL enable Nginx to start on boot and ensure it is
  running.
- **5A.8** WHEN installation completes, THE SYSTEM SHALL fetch the test page over
  HTTP and SHALL verify the known marker string is present.
- **5A.9** IF the marker string is not found or HTTP fails, THEN THE SYSTEM SHALL
  transition the deployment to Failed with the sanitized reason.
- **5A.10** WHEN verification succeeds, THE SYSTEM SHALL display the VM's local
  address.

## 6. Deployment state machine

- **6.1** THE SYSTEM SHALL model each deployment with the states: Queued,
  Cloning, Configuring, Booting, Installing, Checking, Exposing, Ready, Failed.
- **6.2** THE SYSTEM SHALL persist every state transition with a timestamp, the
  previous state, the new state, and a sanitized reason.
- **6.3** WHEN a Proxmox operation returns an asynchronous task id, THE SYSTEM
  SHALL poll that task to completion and SHALL advance state only after the task
  result confirms success.
- **6.4** IF a Proxmox task returns a failure result, THEN THE SYSTEM SHALL
  transition to Failed and SHALL record the sanitized task error.
- **6.5** WHERE a deployment has no exposure step, THE SYSTEM SHALL transition
  from Checking directly to Ready and skip Exposing.
- **6.6** IF any step fails, THEN THE SYSTEM SHALL preserve the VM and all created
  infrastructure and SHALL NOT delete it automatically.
- **6.7** THE SYSTEM SHALL allow the user to retry a Failed deployment from a safe
  step without recreating already-successful resources where possible.
- **6.8** THE SYSTEM SHALL survive an application restart and SHALL restore the
  last persisted state of every deployment.
- **6.9** THE SYSTEM SHALL expose a live timeline reflecting the persisted
  transitions in order.

## 7. Deployment wizard & review

- **7.1** THE SYSTEM SHALL guide the user through selecting connection, template,
  resources, network profile, recipe, and (optionally) router exposure.
- **7.2** BEFORE any infrastructure mutation, THE SYSTEM SHALL show a plan review
  screen listing every action Frolo will take.
- **7.3** WHERE public exposure is requested, THE SYSTEM SHALL show a mutation
  review screen listing protocol, public port, internal port, every router hop,
  the forwarding target at each hop, the final VM address, and the deployment
  name.
- **7.4** THE SYSTEM SHALL require an explicit final confirmation before opening
  public ports.
- **7.5** THE SYSTEM SHALL require an explicit final confirmation before deleting
  a VM.

## 8. Teach Mode (router recording)

- **8.1** WHEN the user starts Teach Mode, THE SYSTEM SHALL open a visible,
  isolated Chromium window navigated to a private router address.
- **8.1a** WHERE a router is reached over HTTP, THE SYSTEM SHALL warn that the
  session is unencrypted and SHALL confine it to the private address the user
  entered.
- **8.1b** WHERE a router presents a self-signed or untrusted TLS certificate, THE
  SYSTEM SHALL show the certificate fingerprint and require the user to approve
  and pin it **per router profile**. This router trust store SHALL be separate and
  independent from the Proxmox connection trust store (§2, §11.6), and SHALL NOT
  disable TLS validation globally.
- **8.2** THE SYSTEM SHALL record these step types: navigation, clicks, text
  fields, password fields, dropdowns, checkboxes, entries into **same-origin and
  accessible cross-origin iframes**, loading waits, confirmation dialogs, success
  messages, verification that a rule exists, and a **manual checkpoint** step.
- **8.2a** THE SYSTEM SHALL support recording on standard HTML router admin pages,
  including open shadow DOM and accessible iframes. THE SYSTEM SHALL explicitly
  declare the following as **unsupported for semantic recording**: closed shadow
  DOM, canvas-rendered UIs, native browser authentication dialogs (HTTP Basic /
  OS credential prompts), and cross-origin frames that block script access.
- **8.2b** WHERE a step targets an unsupported surface (per 8.2a), THE SYSTEM
  SHALL require the user to insert a **manual checkpoint**: recording pauses, the
  user performs the action directly in the visible window, and the user confirms
  completion before recording resumes. THE SYSTEM SHALL mark such steps as manual
  and SHALL NOT attempt automated replay of them.
- **8.2c** WHEN the router presents native HTTP Basic authentication, THE SYSTEM
  SHALL handle it via a manual checkpoint or an explicit credential prompt bound
  to vault variables, and SHALL NOT capture the typed credential.
- **8.3** WHEN recording a field, THE SYSTEM SHALL capture multiple locator
  strategies: accessible role, accessible name, associated label, stable id,
  stable name/data attribute, nearby heading or row text, and DOM structure.
- **8.4** THE SYSTEM SHALL NOT rely solely on generated ids for locating an
  element.
- **8.5** WHERE no stable locator can be captured, THE SYSTEM SHALL allow screen
  coordinates only as an explicitly marked last-resort strategy.
- **8.6** THE SYSTEM SHALL let the user map each form field to one of: fixed
  value, router username, router password, internal IP, internal port, external
  port, protocol, rule name, or ask-during-deployment.
- **8.7** WHEN a field is mapped to router username or router password, THE SYSTEM
  SHALL store only a variable reference (e.g. `{{router_username}}`,
  `{{router_password}}`) in the workflow.
- **8.8** THE SYSTEM SHALL NEVER store an actual credential value inside a
  recorded workflow; credentials SHALL live only in the encrypted vault.
- **8.9** THE SYSTEM SHALL support recording password fields without capturing
  their typed characters.
- **8.10** THE SYSTEM SHALL present an editable recorded timeline where the user
  can reorder, edit, delete, and re-map steps.
- **8.11** THE SYSTEM SHALL store, per router profile, four separate workflows:
  login, create mapping, find mapping, and delete mapping.

## 9. Teach Mode replay

- **9.1** WHEN replaying a step, THE SYSTEM SHALL rank the candidate locator
  matches by strategy reliability and confidence.
- **9.2** IF a target element is missing or ambiguous, THEN THE SYSTEM SHALL stop
  before interacting and SHALL ask the user to repair that step.
- **9.3** THE SYSTEM SHALL NEVER guess an element when the match is ambiguous.
- **9.4** WHEN a step is mapped to a credential variable, THE SYSTEM SHALL resolve
  it from the vault at replay time and SHALL NOT write the value to logs or the
  workflow.
- **9.5** WHEN a verification step runs, THE SYSTEM SHALL confirm the expected
  rule exists and SHALL fail the operation if it does not.

## 10. Router chains & exposure

- **10.1** THE SYSTEM SHALL let the user define a router chain as an ordered list
  of hops from the innermost router to the internet edge.
- **10.2** THE SYSTEM SHALL support the example chain Internet → modem →
  Keenetic → Archer C6U → VM.
- **10.3** THE SYSTEM SHALL model each hop's mapping with an explicit five-tuple:
  `listenAddress`, `listenPort`, `targetAddress`, `targetPort`, and `protocol`.
  THE SYSTEM SHALL compute, for each hop, its forwarding target: the innermost
  router's `targetAddress:targetPort` is the VM's address and internal port; each
  outer router's `targetAddress` is the WAN address of the router immediately
  inside it.
- **10.3a** FOR the first milestone, THE SYSTEM SHALL require the same port at
  every hop (`listenPort == targetPort` across all hops) and SHALL validate this
  before allowing exposure. Per-hop port translation is a documented future
  extension of the five-tuple model.
- **10.4** WHEN applying mappings, THE SYSTEM SHALL apply them from the innermost
  router outward.
- **10.5** WHEN a mapping is applied, THE SYSTEM SHALL verify it using the find
  mapping workflow before proceeding to the next hop.
- **10.6** IF a hop fails, THEN THE SYSTEM SHALL offer to remove only the mappings
  created by that operation and SHALL NOT touch pre-existing rules.
- **10.7** WHEN a deployment with exposure is deleted, THE SYSTEM SHALL remove the
  mappings in reverse order (outermost first) before deleting the VM.
- **10.8** THE SYSTEM SHALL display both the local VM address and the simulated
  public address after exposure in mock mode.

## 11. Security

- **11.1** THE SYSTEM SHALL encrypt all credentials at rest using AES-256-GCM.
- **11.2** THE SYSTEM SHALL obtain the master key from the OS credential store
  and SHALL NOT store the master key on disk in plaintext.
- **11.3** THE SYSTEM SHALL NEVER log passwords, tokens, cookies, private keys,
  authorization headers, or CSRF values.
- **11.4** THE SYSTEM SHALL NEVER save password values during recording.
- **11.5** THE SYSTEM SHALL NOT disable TLS validation globally.
- **11.6** THE SYSTEM SHALL allow the user to approve and pin one certificate
  fingerprint per Proxmox connection.
- **11.7** THE SYSTEM SHALL NOT expose the controller as a network-reachable
  service. THE SYSTEM SHALL use Electron IPC as the sole channel between renderer
  and controller (see §17). WHERE any local HTTP surface exists for internal
  reasons, THE SYSTEM SHALL bind it to loopback on a random port, require an
  unpredictable per-launch token, enforce strict Origin checks, and apply CSRF
  protection.
- **11.8** THE SYSTEM SHALL NOT open or expose SSH, Proxmox, Frolo, router
  administration, or database ports as part of any deployment.
- **11.9** THE SYSTEM SHALL require explicit final confirmation before opening
  public ports or deleting a VM.
- **11.10** THE SYSTEM SHALL maintain an append-only, sanitized audit trail of all
  sensitive operations.
- **11.11** THE SYSTEM SHALL restrict recipes to declarative, versioned, known
  typed operations and SHALL NOT execute arbitrary community scripts.
- **11.12** WHERE any value would be written to a log or audit entry, THE SYSTEM
  SHALL run it through a sanitizer that redacts known secret patterns.

## 12. Persistence

- **12.1** THE SYSTEM SHALL persist non-secret data (connections metadata,
  templates cache, network profiles, router profiles, chains, recipes,
  deployments, transitions, audit trail) in SQLite.
- **12.2** THE SYSTEM SHALL NOT persist any secret value in SQLite.
- **12.3** THE SYSTEM SHALL store all secret values in the encrypted vault only.

## 13. Architecture boundaries

- **13.1** THE SYSTEM SHALL keep UI components free of any direct access to
  Proxmox, Playwright, SQLite, or credentials.
- **13.2** THE SYSTEM SHALL place every external system behind a typed interface
  with both a fake and a real implementation.
- **13.3** THE SYSTEM SHALL select fake or real implementations based solely on
  the active mode.

## 14. Mock mode fixtures

- **14.1** THE SYSTEM SHALL provide a fake Proxmox API implementing inventory,
  cloning, configuration, startup, asynchronous task polling, and deletion.
- **14.2** THE SYSTEM SHALL provide a fake Ubuntu guest capable of exercising the
  full Nginx recipe (install, page creation, enable, HTTP verify).
- **14.3** THE SYSTEM SHALL provide Router fixture A with a normal, clearly
  labelled form.
- **14.4** THE SYSTEM SHALL provide Router fixture B with generated ids, nested
  navigation, loading states, and a confirmation dialog.
- **14.5** THE SYSTEM SHALL provide a simulated two-router NAT chain that verifies
  reachability through both hops.
- **14.5a** THE SYSTEM SHALL provide **pre-recorded fixture workflows** (login,
  create, find, delete) for Router fixtures A and B, so the mock happy path can
  replay taught workflows before the Teach Mode recorder UI is built. These
  fixture workflows SHALL contain only variable references, never secret values.
- **14.6** THE SYSTEM SHALL be able to run the complete workflow end-to-end in
  mock mode: configure VM → review plan → clone → configure networking → install
  Nginx → verify Nginx → replay taught router workflows → verify mappings → show
  local and simulated public addresses.

## 15. UI surfaces

The UI is delivered in two stages so a working vertical slice exists before
breadth is added.

- **15.1** For the **MVP vertical slice**, THE SYSTEM SHALL provide six screens
  sufficient to run the mock happy path end-to-end:
  1. Welcome (mock mode)
  2. Inventory (templates + VMs)
  3. Deployment wizard (resources, network, recipe, optional exposure)
  4. Plan / mutation review with confirmations
  5. Live deployment timeline
  6. Deployment details with sanitized logs and final addresses
- **15.2** AFTER the MVP slice works end-to-end, THE SYSTEM SHALL add the
  remaining screens: Proxmox connections, network profiles, router profiles,
  router-chain editor, Teach Mode recorder, editable recorded timeline, recipe
  catalogue, retry/deletion flows, vault status, and audit history.
- **15.3** THE SYSTEM SHALL keep the UI compact, clear, and friendly.
- **15.4** THE SYSTEM SHALL NOT use fake terminal animations.
- **15.5** THE SYSTEM SHALL make status text describe what Frolo actually
  observed, not simulated progress.

## 16. Testing

- **16.1** THE SYSTEM SHALL provide Vitest unit/integration coverage for the state
  machine, recipe engine (incl. constraint enforcement 5.7 and checksum 5.6),
  locator ranking, sanitizer, chain planner, vault (§20), and the operation
  journal / crash-recovery reconciliation (§19).
- **16.2** THE SYSTEM SHALL provide Playwright tests that record and replay
  workflows against Router fixtures A and B.
- **16.3** THE SYSTEM SHALL provide an end-to-end mock test that runs the full
  workflow in requirement 14.6 and asserts the final local and simulated public
  addresses.
- **16.4** THE SYSTEM SHALL NOT connect to real Proxmox or real routers in any
  test.

## 17. Process ownership & IPC trust model

- **17.1** THE SYSTEM SHALL adopt a single process-ownership model: the **Electron
  main process** owns the controller/orchestrator, the vault, the OS keychain
  access, the SQLite store, and the Playwright/Teach Mode Chromium. The controller
  SHALL run in-process in Electron main and SHALL NOT run as a separately
  network-listening child process.
- **17.2** THE SYSTEM SHALL expose functionality to the renderer only through a
  narrow, typed set of IPC methods via the preload bridge, with `contextIsolation`
  enabled and Node integration disabled in the renderer.
- **17.3** THE SYSTEM SHALL keep all provider access (Proxmox, Guest, Router),
  secret access, and database access in the main process; the renderer SHALL
  receive only serializable data and events.
- **17.4** THE SYSTEM SHALL validate and type-check every IPC request payload in
  main before acting, and SHALL reject unknown channels.

## 18. Guest access & trust model

- **18.1** THE SYSTEM SHALL define how it authenticates to the guest before any
  recipe operation runs. FOR the first milestone the mechanism is **SSH using a
  Frolo-generated key pair injected via cloud-init** as the cloud-init user.
- **18.2** WHEN preparing a deployment, THE SYSTEM SHALL generate a per-deployment
  SSH key pair, store the private key only in the vault, and inject the public key
  and the cloud-init username into the VM via cloud-init.
- **18.3** THE SYSTEM SHALL record the cloud-init username used for guest access
  and SHALL require it as part of the network/recipe plan.
- **18.4** THE SYSTEM SHALL define sudo behavior explicitly: recipe operations that
  require elevation SHALL use passwordless sudo for the cloud-init user configured
  via cloud-init; THE SYSTEM SHALL NOT prompt for or store a guest sudo password.
- **18.5** THE SYSTEM SHALL perform SSH host-key verification. On first connect,
  THE SYSTEM SHALL record (pin) the guest host key for that deployment and SHALL
  fail if the host key later changes (Trust On First Use), surfacing a sanitized
  mismatch error rather than silently trusting.
- **18.6** THE SYSTEM SHALL define DHCP address discovery: WHERE DHCP is used, THE
  SYSTEM SHALL obtain the guest address via the QEMU guest agent (preferred) or a
  documented fallback, and SHALL read it back before verification (§4.5).
- **18.7** THE SYSTEM SHALL state whether the **QEMU guest agent is required**. FOR
  DHCP address discovery the guest agent is **required**; for manual and
  VM-ID-derived addressing the guest agent is optional. THE SYSTEM SHALL surface a
  clear, sanitized error if a required guest agent is unavailable.
- **18.8** THE SYSTEM SHALL NEVER log the guest private key, host key material, or
  any guest credential (§11.3).
- **18.9** THE fake `GuestProvider` (mock mode) SHALL model this trust flow (key
  injection, TOFU host key, guest-agent availability) so the same code paths are
  exercised without real SSH.

## 19. Operation journal & crash recovery

- **19.1** THE SYSTEM SHALL maintain an **operation journal** separate from the
  state-transition log. Each journal entry SHALL contain: an idempotency key, the
  target resource (e.g. connection/node/VM-ID), the external task id (UPID) when
  known, the intended action, the start time, the observed result, and a
  reconciliation status.
- **19.2** BEFORE issuing a mutating Proxmox operation, THE SYSTEM SHALL write a
  journal entry with a unique idempotency key and status `pending`.
- **19.3** WHEN an operation returns a task id, THE SYSTEM SHALL record the UPID in
  the journal entry before polling, so a crash after issue but before completion
  is recoverable.
- **19.4** WHEN the application restarts, THE SYSTEM SHALL reconcile every
  `pending`/`in_flight` journal entry: it SHALL query Proxmox for the recorded
  UPID and/or the target resource state, determine the true outcome, and update
  the entry to `succeeded`, `failed`, or `needs_attention` WITHOUT issuing a
  duplicate mutation.
- **19.5** IF the true outcome cannot be determined during reconciliation, THEN THE
  SYSTEM SHALL mark the entry `needs_attention` and surface it to the user rather
  than retrying blindly.
- **19.6** THE SYSTEM SHALL use the idempotency key to guarantee that a retried
  step does not create duplicate infrastructure (e.g. it SHALL NOT clone a second
  VM if the first clone actually succeeded).
- **19.7** State transitions (§6.2) SHALL advance only in accordance with the
  reconciled journal outcome.

## 20. Vault format & lifecycle

- **20.1** THE SYSTEM SHALL define the vault as a single encrypted file with an
  exact structure: a versioned header (format version, cipher = AES-256-GCM,
  creation time), and a set of records each containing a `SecretRef` key, a random
  96-bit IV, the ciphertext, and the GCM authentication tag.
- **20.2** THE SYSTEM SHALL obtain a **random 256-bit master key** from the OS
  credential store. Because the master key is random (not password-derived), THE
  SYSTEM SHALL NOT use a KDF or salt; per-record random IVs provide semantic
  security. (This removes the earlier KDF/salt ambiguity.)
- **20.3** THE SYSTEM SHALL write the vault file **atomically**: write to a
  temporary file, fsync, then rename over the existing file, so a crash never
  leaves a partially written vault.
- **20.4** THE SYSTEM SHALL support **key rotation**: generate a new master key in
  the keychain, re-encrypt all records under the new key, atomically replace the
  file, and only then remove the old key. IF rotation is interrupted, THE SYSTEM
  SHALL remain able to open the vault with the surviving key.
- **20.5** THE SYSTEM SHALL support **secret deletion**: removing a record SHALL
  rewrite the vault atomically without that record; deleting a connection or
  router profile SHALL delete its associated secrets.
- **20.6** THE SYSTEM SHALL define **backup behavior**: the vault file MAY be
  backed up as-is because it is useless without the OS-keychain master key; THE
  SYSTEM SHALL document that restoring a vault on a machine without the matching
  keychain entry will require re-entering secrets, and SHALL fail closed (never
  silently accept unreadable records).
- **20.7** IF the master key is missing from the keychain, THEN THE SYSTEM SHALL
  report a clear locked state and SHALL NOT fabricate or bypass decryption.
- **20.8** THE SYSTEM SHALL store the vault file separately from the SQLite
  database and SHALL never place secret material in SQLite (§12.2, §12.3).
