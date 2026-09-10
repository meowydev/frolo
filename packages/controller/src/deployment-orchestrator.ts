// Deployment orchestrator (req §5A, §6, §18). Runs a deployment through the
// state machine. Mutating Proxmox steps go through the JournalService so state
// advances only on confirmed task results and retries never duplicate infra.
// Guest access uses a per-deployment key (vault) + TOFU host key. Verification
// fetches the page over HTTP and checks the unique marker.

import type {
  Deployment,
  DeploymentState,
  GuestTarget,
  Recipe,
} from "@frolo/contracts";
import {
  froloMarker,
  preflightRecipe,
  resolveNetwork,
  toIpConfig,
  verifyChecksum,
  recipeChecksum,
  FROLO_MARKER_PLACEHOLDER,
} from "@frolo/core";
import { SecretRefs } from "@frolo/vault";
import type { ControllerDeps } from "./deps.js";
import type { EventBus } from "./events.js";
import { JournalService } from "./journal-service.js";

export interface DeploymentResult {
  state: DeploymentState;
  localAddress?: string;
  publicAddressSim?: string;
}

export class DeploymentOrchestrator {
  private readonly journal: JournalService;

  constructor(
    private readonly deps: ControllerDeps,
    private readonly events: EventBus,
    private readonly runExposure: (dep: Deployment) => Promise<{ ok: boolean; publicAddress?: string; detail: string }>,
  ) {
    this.journal = new JournalService(deps.store, deps.proxmox, deps.sanitizer);
  }

  // Advance a Queued/Failed deployment to completion (or Failed). Idempotent and
  // resumable: uses the journal to skip already-succeeded steps.
  async run(deploymentId: string): Promise<DeploymentResult> {
    const dep = this.deps.store.getDeployment(deploymentId);
    if (!dep) throw new Error(`no deployment ${deploymentId}`);
    const node = this.node();
    const hasExposure = Boolean(dep.plan.chainId && dep.plan.exposure);

    // Ensure we have a target VM id (allocate once, persist).
    let vmid = dep.targetVmid;
    if (!vmid) {
      vmid = (this.deps.proxmox as unknown as { allocateVmid?: () => number }).allocateVmid?.() ??
        dep.plan.templateVmid + 1000;
      this.deps.store.updateDeployment(dep.id, { targetVmid: vmid });
    }
    const target = `${node}/${vmid}`;

    try {
      // --- Cloning ---
      await this.enter(dep, "Cloning", "cloning template");
      const clone = await this.journal.runMutation({
        deploymentId: dep.id,
        idempotencyKey: `${dep.id}:clone`,
        target,
        action: "clone",
        issue: () =>
          this.deps.proxmox.cloneTemplate({
            node,
            templateVmid: dep.plan.templateVmid,
            newVmid: vmid!,
            name: dep.plan.hostname,
          }),
      });
      this.log(dep.id, clone.ok ? "info" : "error", `clone: ${clone.detail}`);
      if (!clone.ok) return this.fail(dep, `clone failed: ${clone.detail}`);

      // Prepare guest trust material (req §18.2): keypair -> vault, host key TOFU.
      const keys = this.deps.keygen.generate(dep.id);
      await this.deps.vault.put(SecretRefs.guestPrivateKey(dep.id), keys.privateKey);
      this.deps.sanitizer.register(keys.privateKey);

      // --- Configuring (resources + network + cloud-init user/key) ---
      await this.enter(dep, "Configuring", "configuring VM resources and network");
      const profile = this.deps.store.getNetworkProfile(dep.plan.networkProfileId);
      if (!profile) return this.fail(dep, "network profile not found");
      const net = resolveNetwork(profile, vmid);
      const cfg = await this.journal.runMutation({
        deploymentId: dep.id,
        idempotencyKey: `${dep.id}:configure`,
        target,
        action: "configure",
        issue: () =>
          this.deps.proxmox.configureVm({
            node,
            vmid: vmid!,
            cores: dep.plan.cores,
            ramMb: dep.plan.ramMb,
            diskGb: dep.plan.diskGb,
            hostname: dep.plan.hostname,
            ipConfig: toIpConfig(net),
            sshUser: dep.plan.sshUser,
            sshPublicKey: keys.publicKey,
          }),
      });
      this.log(dep.id, cfg.ok ? "info" : "error", `configure: ${cfg.detail}`);
      if (!cfg.ok) return this.fail(dep, `configure failed: ${cfg.detail}`);

      // --- Booting ---
      await this.enter(dep, "Booting", "starting VM and waiting for the guest");
      const start = await this.journal.runMutation({
        deploymentId: dep.id,
        idempotencyKey: `${dep.id}:start`,
        target,
        action: "start",
        issue: () => this.deps.proxmox.startVm(node, vmid!),
      });
      this.log(dep.id, start.ok ? "info" : "error", `start: ${start.detail}`);
      if (!start.ok) return this.fail(dep, `start failed: ${start.detail}`);

      // Determine the guest address (DHCP readback requires the guest agent).
      const address = await this.deps.proxmox.getGuestAddress(node, vmid);
      if (!address) {
        return this.fail(
          dep,
          net.requiresGuestAgent
            ? "could not read DHCP address (guest agent unavailable)"
            : "guest address unavailable",
        );
      }
      this.deps.store.updateDeployment(dep.id, { localAddress: address });

      const guestTarget: GuestTarget = {
        address,
        sshUser: dep.plan.sshUser,
        privateKeyRef: SecretRefs.guestPrivateKey(dep.id),
        hostKeyFingerprint: keys.expectedHostKeyFingerprint,
        guestAgentAvailable: profile.mode === "dhcp",
      };
      try {
        await this.deps.guest.waitReachable(guestTarget, 10_000);
        this.log(dep.id, "info", `guest reachable at ${address}`);
      } catch (err) {
        return this.fail(dep, `guest not reachable: ${this.deps.sanitizer.sanitize(err)}`);
      }

      // --- Installing (recipe) ---
      await this.enter(dep, "Installing", "installing application recipe");
      const recipe = this.loadRecipe(dep.plan.recipeId);
      if (!recipe) return this.fail(dep, "recipe not found");
      try {
        preflightRecipe(recipe);
      } catch (err) {
        return this.fail(dep, `recipe rejected: ${this.deps.sanitizer.sanitize(err)}`);
      }

      const marker = froloMarker(dep.id);
      for (const op of recipe.operations) {
        if (op.type === "http.check") continue; // handled in Checking
        const asset =
          op.type === "file.write"
            ? substituteMarker(recipe.assets[op.contentRef] ?? "", marker)
            : undefined;
        const res = await this.deps.guest.run(guestTarget, op, asset);
        this.log(dep.id, res.ok ? "info" : "error", `op ${op.type}: ${res.detailSanitized ?? ""}`);
        if (!res.ok) return this.fail(dep, `install step ${op.type} failed`);
      }

      // --- Checking (HTTP marker verification) ---
      await this.enter(dep, "Checking", "verifying the application over HTTP");
      const check = recipe.operations.find((o) => o.type === "http.check");
      if (check && check.type === "http.check") {
        const res = await this.deps.guest.httpGet(guestTarget, check.path);
        const expected = check.expectContains === FROLO_MARKER_PLACEHOLDER ? marker : check.expectContains;
        if (res.status !== check.expectStatus || !res.body.includes(expected)) {
          return this.fail(
            dep,
            `verification failed: HTTP ${res.status}, marker ${res.body.includes(expected) ? "present" : "missing"}`,
          );
        }
        this.log(dep.id, "info", `HTTP ${res.status}, marker found`);
      }

      // --- Exposing (optional) ---
      let publicAddressSim: string | undefined;
      if (hasExposure) {
        await this.enter(dep, "Exposing", "applying router mappings");
        let exposure: { ok: boolean; publicAddress?: string; detail: string };
        try {
          exposure = await this.runExposure(this.deps.store.getDeployment(dep.id)!);
        } catch (err) {
          // e.g. a tier-gating rejection. Fail gracefully; infra is preserved.
          return this.fail(dep, `exposure failed: ${this.deps.sanitizer.sanitize(err)}`);
        }
        this.log(dep.id, exposure.ok ? "info" : "error", `exposure: ${exposure.detail}`);
        if (!exposure.ok) return this.fail(dep, `exposure failed: ${exposure.detail}`);
        publicAddressSim = exposure.publicAddress;
        if (publicAddressSim) {
          this.deps.store.updateDeployment(dep.id, { publicAddressSim });
        }
      }

      // --- Ready ---
      await this.enter(dep, "Ready", "deployment ready");
      const final = this.deps.store.getDeployment(dep.id)!;
      return {
        state: "Ready",
        localAddress: final.localAddress,
        publicAddressSim: final.publicAddressSim,
      };
    } finally {
      this.deps.sanitizer; // (literals stay registered for the process lifetime)
    }
  }

  // Retry a Failed deployment (req §6.7): the journal skips succeeded steps.
  async retry(deploymentId: string): Promise<DeploymentResult> {
    const dep = this.deps.store.getDeployment(deploymentId);
    if (!dep) throw new Error(`no deployment ${deploymentId}`);
    if (dep.state !== "Failed") {
      throw new Error(`can only retry a Failed deployment (state is ${dep.state})`);
    }
    // Move back to Queued conceptually; run() re-enters and journal skips done work.
    this.deps.store.updateDeployment(dep.id, { state: "Queued" });
    this.emitTransition(dep.id, "Failed", "Queued", "retry requested");
    return this.run(deploymentId);
  }

  // --- helpers ---
  private node(): string {
    // Single-node mock; connection metadata would supply this in real mode.
    return "pve";
  }

  private loadRecipe(recipeId: string): Recipe | null {
    const row = this.deps.store.getRecipe(recipeId);
    if (!row) return null;
    // Immutability check (req §5.6): verify checksum matches what was stored.
    try {
      verifyChecksum(row.recipe, row.checksum);
    } catch {
      return null;
    }
    // Defensive: recompute to ensure the stored checksum is self-consistent.
    if (recipeChecksum(row.recipe) !== row.checksum) return null;
    return row.recipe;
  }

  private async enter(dep: Deployment, to: DeploymentState, reason: string): Promise<void> {
    const current = this.deps.store.getDeployment(dep.id)!;
    if (current.state === to) return;
    this.deps.store.updateDeployment(dep.id, { state: to });
    this.deps.store.appendTransition(dep.id, current.state, to, this.deps.sanitizer.sanitize(reason));
    this.emitTransition(dep.id, current.state, to, reason);
  }

  private fail(dep: Deployment, reason: string): DeploymentResult {
    const sanitized = this.deps.sanitizer.sanitize(reason);
    const current = this.deps.store.getDeployment(dep.id)!;
    // Failed preserves infrastructure (req §6.6): we only change state.
    this.deps.store.updateDeployment(dep.id, { state: "Failed" });
    this.deps.store.appendTransition(dep.id, current.state, "Failed", sanitized);
    this.log(dep.id, "error", sanitized);
    this.emitTransition(dep.id, current.state, "Failed", sanitized);
    return { state: "Failed" };
  }

  private log(deploymentId: string, level: "info" | "warn" | "error", msg: string): void {
    const sanitized = this.deps.sanitizer.sanitize(msg);
    this.deps.store.appendLog(deploymentId, level, sanitized);
    this.events.emit({
      type: "log",
      deploymentId,
      level,
      messageSanitized: sanitized,
      at: this.deps.clock.isoNow(),
    });
  }

  private emitTransition(
    deploymentId: string,
    from: DeploymentState | null,
    to: DeploymentState,
    reason: string,
  ): void {
    this.events.emit({
      type: "transition",
      deploymentId,
      from,
      to,
      reasonSanitized: this.deps.sanitizer.sanitize(reason),
      at: this.deps.clock.isoNow(),
    });
  }
}

function substituteMarker(content: string, marker: string): string {
  return content.split(FROLO_MARKER_PLACEHOLDER).join(marker);
}
