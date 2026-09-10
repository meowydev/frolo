// Exposure orchestrator (req §10). Applies router mappings innermost -> outermost,
// verifies each hop, and on failure rolls back ONLY the mappings created by this
// operation (never pre-existing rules). On deployment delete, tears mappings down
// outermost -> innermost before the VM is removed.

import type {
  Deployment,
  ExposurePlan,
  HopMapping,
  VarBindings,
} from "@frolo/contracts";
import { planExposure, applyOrder, rollbackOrder, teardownOrder } from "@frolo/core";
import { SecretRefs } from "@frolo/vault";
import type { ControllerDeps } from "./deps.js";
import type { EventBus } from "./events.js";

export interface ExposureOutcome {
  ok: boolean;
  publicAddress?: string;
  detail: string;
}

export class ExposureOrchestrator {
  constructor(
    private readonly deps: ControllerDeps,
    private readonly events: EventBus,
  ) {}

  buildPlan(dep: Deployment): ExposurePlan {
    if (!dep.plan.chainId || !dep.plan.exposure) {
      throw new Error("deployment has no exposure/chain");
    }
    const chain = this.deps.store.getRouterChain(dep.plan.chainId);
    if (!chain) throw new Error("router chain not found");
    const vmAddress = dep.localAddress;
    if (!vmAddress) throw new Error("VM local address unknown");
    return planExposure({
      chain,
      vmAddress,
      protocol: dep.plan.exposure.protocol,
      publicPort: dep.plan.exposure.publicPort,
      internalPort: dep.plan.exposure.internalPort,
    });
  }

  // Apply the full chain. Verifies each hop; on any failure rolls back only the
  // mappings this call created, in reverse order.
  async apply(dep: Deployment): Promise<ExposureOutcome> {
    const plan = this.buildPlan(dep);
    const created: HopMapping[] = [];

    for (const hop of applyOrder(plan)) {
      this.emitExposure(dep.id, hop.hopIndex, "applying", `applying hop ${hop.hopIndex}`);
      const vars = await this.varsFor(dep, hop);
      const provider = this.deps.routerFor(hop.routerProfileId);
      const trust = this.trustFor(hop.routerProfileId);

      // Replay login + create for this router.
      const login = this.deps.store.getWorkflow(hop.routerProfileId, "login");
      if (login) {
        const r = await provider.replay(login, vars, trust);
        if (!r.ok) {
          await this.rollback(dep, created);
          return { ok: false, detail: `login replay failed at hop ${hop.hopIndex}: ${r.detailSanitized ?? ""}` };
        }
      }
      const create = this.deps.store.getWorkflow(hop.routerProfileId, "create");
      if (!create) {
        await this.rollback(dep, created);
        return { ok: false, detail: `no create workflow for hop ${hop.hopIndex}` };
      }
      const applied = await provider.replay(create, vars, trust);
      if (!applied.ok) {
        await this.rollback(dep, created);
        return { ok: false, detail: `create replay failed at hop ${hop.hopIndex}: ${applied.detailSanitized ?? ""}` };
      }

      // Record + reflect in the simulated NAT chain (mock).
      this.deps.store.saveMapping(dep.id, hop, true, false);
      this.deps.nat?.apply(hop);
      created.push(hop);

      // Verify via find-mapping workflow (req §10.5).
      const find = this.deps.store.getWorkflow(hop.routerProfileId, "find");
      const exists = find ? await provider.probeRule(find, vars, trust) : { exists: true };
      if (!exists.exists) {
        await this.rollback(dep, created);
        return { ok: false, detail: `verification failed at hop ${hop.hopIndex}` };
      }
      this.deps.store.saveMapping(dep.id, hop, true, true);
      this.emitExposure(dep.id, hop.hopIndex, "verified", `hop ${hop.hopIndex} verified`);
    }

    // End-to-end reachability (mock NAT).
    if (this.deps.nat && !this.deps.nat.probe(plan)) {
      await this.rollback(dep, created);
      return { ok: false, detail: "end-to-end reachability probe failed" };
    }

    return { ok: true, publicAddress: plan.publicAddress, detail: `exposed at ${plan.publicAddress}` };
  }

  // Roll back ONLY the mappings created by this operation, reverse order (req §10.6).
  private async rollback(dep: Deployment, created: HopMapping[]): Promise<void> {
    for (const hop of rollbackOrder(created)) {
      try {
        await this.removeHop(dep, hop, "rolled_back");
      } catch {
        // best-effort rollback; leave a record for the user
      }
    }
  }

  // Teardown on delete: outermost -> innermost (req §10.7).
  async teardownForDelete(dep: Deployment): Promise<ExposureOutcome> {
    if (!dep.plan.chainId || !dep.plan.exposure) {
      return { ok: true, detail: "no exposure to tear down" };
    }
    const plan = this.buildPlan(dep);
    for (const hop of teardownOrder(plan)) {
      await this.removeHop(dep, hop, "removed");
    }
    return { ok: true, detail: "mappings removed" };
  }

  private async removeHop(
    dep: Deployment,
    hop: HopMapping,
    phase: "rolled_back" | "removed",
  ): Promise<void> {
    const vars = await this.varsFor(dep, hop);
    const provider = this.deps.routerFor(hop.routerProfileId);
    const trust = this.trustFor(hop.routerProfileId);
    const login = this.deps.store.getWorkflow(hop.routerProfileId, "login");
    if (login) await provider.replay(login, vars, trust);
    const del = this.deps.store.getWorkflow(hop.routerProfileId, "delete");
    if (del) await provider.replay(del, vars, trust);
    this.deps.nat?.remove(hop);
    this.deps.store.saveMapping(dep.id, hop, false, false);
    this.emitExposure(dep.id, hop.hopIndex, phase, `hop ${hop.hopIndex} ${phase}`);
  }

  // Build the variable bindings for a hop, resolving credential vars from the
  // vault (req §9.4). Secret values are registered with the sanitizer so they
  // can never leak into logs, then returned only to the router provider.
  private async varsFor(dep: Deployment, hop: HopMapping): Promise<VarBindings> {
    const vars: VarBindings = {
      rule_name: `frolo-${dep.plan.name}`,
      external_port: String(hop.listenPort),
      internal_ip: hop.targetAddress,
      internal_port: String(hop.targetPort),
      protocol: hop.protocol,
    };
    const userRef = SecretRefs.routerUsername(hop.routerProfileId);
    const passRef = SecretRefs.routerPassword(hop.routerProfileId);
    if (await this.deps.vault.has(userRef)) {
      const u = await this.deps.vault.get(userRef);
      vars.router_username = u;
      this.deps.sanitizer.register(u);
    }
    if (await this.deps.vault.has(passRef)) {
      const p = await this.deps.vault.get(passRef);
      vars.router_password = p;
      this.deps.sanitizer.register(p);
    }
    return vars;
  }

  private trustFor(routerProfileId: string) {
    const rp = this.deps.store.getRouterProfile(routerProfileId);
    return {
      scheme: rp?.scheme ?? ("http" as const),
      pinnedCertFingerprint: rp?.pinnedCertFingerprint,
    };
  }

  private emitExposure(
    deploymentId: string,
    hopIndex: number,
    phase: "applying" | "verified" | "rolled_back" | "removed",
    detail: string,
  ): void {
    this.events.emit({
      type: "exposure",
      deploymentId,
      hopIndex,
      phase,
      detailSanitized: this.deps.sanitizer.sanitize(detail),
      at: this.deps.clock.isoNow(),
    });
  }
}
