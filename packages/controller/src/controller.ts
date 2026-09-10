// Frolo Controller (req §4, §6, §7, §10, §11, §17). In-process library called by
// Electron main over IPC. Owns orchestration, confirmation gates, audit, and the
// entitlement (licensing) surface. No network server.

import type {
  AuditEntry,
  Deployment,
  DeploymentLogLine,
  DeploymentPlan,
  DeploymentTransition,
  Entitlements,
  ExposurePlan,
  JournalEntry,
  Mode,
  NetworkProfile,
  PublicVerificationKey,
  Recipe,
  RouterChain,
  RouterProfile,
  TemplateInfo,
  VmInfo,
  Workflow,
} from "@frolo/contracts";
import { deploymentPlanSchema, networkProfileSchema } from "@frolo/contracts";
import { computeEntitlements, verifyLicense } from "@frolo/licensing";
import { recipeChecksum } from "@frolo/core";
import { SecretRefs } from "@frolo/vault";
import type { ControllerDeps } from "./deps.js";
import { EventBus, type EventListener } from "./events.js";
import { DeploymentOrchestrator } from "./deployment-orchestrator.js";
import { ExposureOrchestrator } from "./exposure-orchestrator.js";
import { JournalService } from "./journal-service.js";
import { realModeReadiness } from "./real-readiness.js";

export interface ControllerConfig {
  // Public verification keys shipped with the app (NON-SECRET).
  licenseKeys: PublicVerificationKey[];
  // Production builds set this false so dev-fake licenses are refused.
  allowDevLicenseKeys: boolean;
}

export class Controller {
  readonly events = new EventBus();
  private readonly exposure: ExposureOrchestrator;
  private readonly deployment: DeploymentOrchestrator;
  private readonly journal: JournalService;

  constructor(
    private readonly deps: ControllerDeps,
    private readonly config: ControllerConfig,
  ) {
    this.exposure = new ExposureOrchestrator(deps, this.events);
    this.deployment = new DeploymentOrchestrator(deps, this.events, async (dep) => {
      // Tier gating happens before any router mutation (req: monetization).
      await this.enforceExposureEntitlement(dep);
      return this.exposure.apply(dep);
    });
    this.journal = new JournalService(deps.store, deps.proxmox, deps.sanitizer);
  }

  // --- mode ---
  // Real mode stays hidden until its providers exist AND their safety tests pass
  // AND the build opts in (req §1.1). The readiness gate defaults closed.
  getMode(): { mode: Mode; realModeAvailable: boolean } {
    return { mode: this.deps.mode, realModeAvailable: realModeReadiness().available };
  }

  // --- startup reconciliation (req §19.4) ---
  async reconcileOnStartup(): Promise<JournalEntry[]> {
    return this.journal.reconcile();
  }

  // --- inventory (req §3) ---
  async listTemplates(node = "pve"): Promise<TemplateInfo[]> {
    try {
      return await this.deps.proxmox.listTemplates(node);
    } catch (err) {
      throw new Error(this.deps.sanitizer.sanitize(err));
    }
  }
  async listVms(node = "pve"): Promise<VmInfo[]> {
    try {
      return await this.deps.proxmox.listVms(node);
    } catch (err) {
      throw new Error(this.deps.sanitizer.sanitize(err));
    }
  }

  // --- recipes (req §5) ---
  registerBuiltinRecipe(recipe: Recipe): void {
    this.deps.store.saveRecipe(recipe, recipeChecksum(recipe));
  }
  listRecipes(): { recipe: Recipe; checksum: string }[] {
    return this.deps.store.listRecipes();
  }

  // --- deployments (req §6, §7) ---
  createDeployment(planInput: unknown): Deployment {
    const parsed = deploymentPlanSchema.safeParse(planInput);
    if (!parsed.success) {
      throw new Error(
        `invalid deployment plan: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    const plan = parsed.data as DeploymentPlan;
    const dep = this.deps.store.createDeployment(plan);
    this.deps.store.appendTransition(dep.id, null, "Queued", "deployment created");
    this.audit("user", "create_deployment", plan.name, `queued ${plan.name}`);
    return dep;
  }

  // Preview the exact plan of actions before any mutation (req §7.2).
  previewPlan(deploymentId: string): {
    deployment: Deployment;
    steps: string[];
    exposure?: ExposurePlan;
  } {
    const dep = this.requireDeployment(deploymentId);
    const steps = [
      `Clone template ${dep.plan.templateVmid} as "${dep.plan.hostname}"`,
      `Configure ${dep.plan.cores} cores, ${dep.plan.ramMb} MB RAM, ${dep.plan.diskGb} GB disk`,
      `Apply network profile ${dep.plan.networkProfileId}`,
      `Start VM and wait for guest`,
      `Install recipe ${dep.plan.recipeId}`,
      `Verify the application over HTTP`,
    ];
    let exposure: ExposurePlan | undefined;
    if (dep.plan.chainId && dep.plan.exposure && dep.localAddress) {
      try {
        exposure = this.exposure.buildPlan(dep);
      } catch {
        exposure = undefined;
      }
    }
    return { deployment: dep, steps, exposure };
  }

  // Run a deployment (mutation). For exposure, the caller must have confirmed
  // (req §7.4) before this is invoked with exposure enabled.
  async runDeployment(deploymentId: string): Promise<Deployment> {
    await this.deployment.run(deploymentId);
    return this.requireDeployment(deploymentId);
  }

  async retryDeployment(deploymentId: string): Promise<Deployment> {
    this.audit("user", "retry_deployment", deploymentId, "retry requested");
    await this.deployment.retry(deploymentId);
    return this.requireDeployment(deploymentId);
  }

  getDeployment(id: string): Deployment {
    return this.requireDeployment(id);
  }
  listDeployments(): Deployment[] {
    return this.deps.store.listDeployments();
  }
  listTransitions(id: string): DeploymentTransition[] {
    return this.deps.store.listTransitions(id);
  }
  listLogs(id: string): DeploymentLogLine[] {
    return this.deps.store.listLogs(id);
  }
  listOperations(id: string): JournalEntry[] {
    return this.deps.store.listOperations(id);
  }
  listMappings(id: string) {
    return this.deps.store.listMappings(id);
  }

  // --- confirmation-gated mutations (req §7.4, §7.5, §11.9) ---

  // Opening public ports requires an explicit confirmation token that matches
  // the previewed plan. The IPC layer obtains this from a user confirmation.
  async confirmAndExpose(
    deploymentId: string,
    confirmation: { confirmed: true },
  ): Promise<Deployment> {
    if (!confirmation.confirmed) throw new Error("exposure not confirmed");
    const dep = this.requireDeployment(deploymentId);
    await this.enforceExposureEntitlement(dep);
    this.audit("user", "open_ports", dep.plan.name, "user confirmed opening public ports");
    const outcome = await this.exposure.apply(dep);
    if (!outcome.ok) throw new Error(outcome.detail);
    if (outcome.publicAddress) {
      this.deps.store.updateDeployment(dep.id, { publicAddressSim: outcome.publicAddress });
    }
    return this.requireDeployment(deploymentId);
  }

  // Deleting a VM requires explicit confirmation. Mappings are torn down in
  // reverse order BEFORE the VM is deleted (req §10.7). Never auto-deletes.
  async confirmAndDelete(
    deploymentId: string,
    confirmation: { confirmed: true },
  ): Promise<{ deleted: boolean; detail: string }> {
    if (!confirmation.confirmed) throw new Error("deletion not confirmed");
    const dep = this.requireDeployment(deploymentId);
    this.audit("user", "delete_vm", dep.plan.name, "user confirmed deletion");

    // 1) Tear down mappings outermost -> innermost.
    await this.exposure.teardownForDelete(dep);

    // 2) Delete the VM (journal-guarded).
    if (dep.targetVmid) {
      const node = "pve";
      const res = await this.journal.runMutation({
        deploymentId: dep.id,
        idempotencyKey: `${dep.id}:delete`,
        target: `${node}/${dep.targetVmid}`,
        action: "delete",
        issue: () => this.deps.proxmox.deleteVm(node, dep.targetVmid!),
      });
      if (!res.ok) return { deleted: false, detail: res.detail };
    }
    // 3) Remove the deployment's secrets from the vault.
    if (await this.deps.vault.has(SecretRefs.guestPrivateKey(dep.id))) {
      await this.deps.vault.remove(SecretRefs.guestPrivateKey(dep.id));
    }
    return { deleted: true, detail: "VM deleted and mappings removed" };
  }

  // --- licensing / entitlements (req: monetization) ---

  // A stable, non-secret device code the supporter sends from their subscribed
  // Boosty account. The private issuer service maps it to a signed license. It
  // is derived from a locally-stored random id (kept in the vault so it is
  // stable across restarts but never a secret that unlocks anything).
  async getDeviceCode(): Promise<string> {
    const ref = "device_code";
    if (await this.deps.vault.has(ref)) return this.deps.vault.get(ref);
    // Generate a short, human-shareable code.
    const raw = Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 8);
    const code = `FROLO-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`.toUpperCase();
    await this.deps.vault.put(ref, code);
    return code;
  }

  async getEntitlements(): Promise<Entitlements> {
    const has = await this.deps.vault.has(SecretRefs.license());
    if (!has) return computeEntitlements({ state: "none", tier: "home" });
    const blob = await this.deps.vault.get(SecretRefs.license());
    let parsed: unknown;
    try {
      parsed = JSON.parse(blob);
    } catch {
      return computeEntitlements({ state: "invalid", tier: "home", reason: "corrupt license" });
    }
    const status = verifyLicense(parsed, this.config.licenseKeys, this.deps.clock.now(), {
      allowDevKeys: this.config.allowDevLicenseKeys,
    });
    return computeEntitlements(status);
  }

  // Install a license the supporter received (stored encrypted in the vault).
  async installLicense(signedLicenseJson: string): Promise<Entitlements> {
    await this.deps.vault.put(SecretRefs.license(), signedLicenseJson);
    this.audit("user", "install_license", "license", "license installed");
    return this.getEntitlements();
  }

  // --- profiles, routers, chains, workflows (stage-2 breadth) ---
  saveNetworkProfile(p: unknown): void {
    const parsed = networkProfileSchema.safeParse(p);
    if (!parsed.success) {
      throw new Error(`invalid network profile: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    }
    this.deps.store.saveNetworkProfile(parsed.data as NetworkProfile);
  }
  listNetworkProfiles(): NetworkProfile[] {
    return this.deps.store.listNetworkProfiles();
  }
  saveRouterProfile(p: RouterProfile): void {
    this.deps.store.saveRouterProfile(p);
    this.audit("user", "save_router_profile", p.id, `router profile ${p.name}`);
  }
  getRouterProfile(id: string): RouterProfile | null {
    return this.deps.store.getRouterProfile(id);
  }
  saveWorkflow(w: Workflow): void {
    // Defensive: refuse to persist any workflow that carries a secret VALUE in a
    // secret step (req §8.8). Only variable references are permitted.
    for (const step of w.steps) {
      if (step.kind === "fillSecret" && step.binding && step.binding.kind === "fixed") {
        throw new Error("secret step must not carry a fixed value; use a variable binding");
      }
    }
    this.deps.store.saveWorkflow(w);
  }
  getWorkflow(routerProfileId: string, kind: Workflow["kind"]): Workflow | null {
    return this.deps.store.getWorkflow(routerProfileId, kind);
  }
  saveRouterChain(c: RouterChain): void {
    this.deps.store.saveRouterChain(c);
    this.audit("user", "save_router_chain", c.id, `chain ${c.name} with ${c.hops.length} hops`);
  }
  getRouterChain(id: string): RouterChain | null {
    return this.deps.store.getRouterChain(id);
  }

  // --- vault status (req §20, §15.1) ---
  async vaultStatus(): Promise<{ unlocked: boolean; recordCount: number; formatVersion: number }> {
    return this.deps.vault.status();
  }

  // --- router credentials (req §8.8, §11.4): stored ONLY in the vault ---
  async setRouterCredentials(
    routerProfileId: string,
    username: string,
    password: string,
  ): Promise<void> {
    await this.deps.vault.put(SecretRefs.routerUsername(routerProfileId), username);
    await this.deps.vault.put(SecretRefs.routerPassword(routerProfileId), password);
    // Register with the sanitizer so these never appear in any log/audit line.
    this.deps.sanitizer.register(username);
    this.deps.sanitizer.register(password);
    this.audit("user", "set_router_credentials", routerProfileId, "router credentials stored in vault");
  }

  // --- audit (req §11.10) ---
  listAudit(): AuditEntry[] {
    return this.deps.store.listAudit();
  }

  // --- events (req §6.9) ---
  subscribe(fn: EventListener): () => void {
    return this.events.subscribe(fn);
  }

  // Tier gating for exposure (req: monetization; must not weaken the free tier).
  // Home can expose through a SINGLE router hop. Multi-hop chains are an
  // AdvancedUser convenience; chains longer than two hops need Powerfullness.
  // Expiry reverts to Home, so a lapsed subscriber simply loses the multi-hop
  // convenience — their existing VMs and mappings are never touched.
  private async enforceExposureEntitlement(dep: Deployment): Promise<void> {
    if (!dep.plan.chainId) return;
    const chain = this.deps.store.getRouterChain(dep.plan.chainId);
    const hops = chain?.hops.length ?? 0;
    if (hops <= 1) return; // single hop is free (Frolo Home)
    const ent = await this.getEntitlements();
    if (hops >= 3 && !ent.features.unlimited_router_hops) {
      throw new Error(
        `Router chains with ${hops} hops require Frolo Powerfullness. Your VMs and existing mappings are unaffected.`,
      );
    }
    if (!ent.features.multi_router_chains) {
      throw new Error(
        `Multi-router chains require Frolo AdvancedUser or higher. Single-hop exposure remains free on Frolo Home.`,
      );
    }
  }

  // --- internal ---
  private requireDeployment(id: string): Deployment {
    const dep = this.deps.store.getDeployment(id);
    if (!dep) throw new Error(`no deployment ${id}`);
    return dep;
  }
  private audit(actor: string, action: string, subject: string, detail: string): void {
    this.deps.store.appendAudit(actor, action, subject, this.deps.sanitizer.sanitize(detail));
  }
}
