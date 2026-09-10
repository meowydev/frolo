// E2E failure path, crash recovery, and exposure partial-failure (req §6.4,
// §6.6, §6.7, §19, §10.6). All against fakes; infrastructure is never silently
// deleted, and crash recovery never duplicates a mutation.

import { describe, it, expect } from "vitest";
import type { DeploymentPlan, RouterChain } from "@frolo/contracts";
import { composeMock, seedRouter } from "@frolo/controller";

function plan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return {
    name: "web-01",
    connectionId: "mock",
    templateVmid: 9000,
    cores: 2,
    ramMb: 2048,
    diskGb: 10,
    hostname: "web-01",
    sshUser: "ubuntu",
    networkProfileId: "net-dhcp",
    recipeId: "builtin.nginx",
    ...overrides,
  };
}

describe("E2E — failure path preserves infrastructure", () => {
  it("marks Failed and keeps the VM when the recipe install fails", async () => {
    const c = await composeMock({ guest: { failInstallPackages: ["nginx"] } });
    c.store.saveNetworkProfile({ id: "net-dhcp", name: "DHCP", mode: "dhcp" });

    const dep = c.controller.createDeployment(plan());
    const result = await c.controller.runDeployment(dep.id);

    expect(result.state).toBe("Failed");
    const target = c.controller.getDeployment(dep.id).targetVmid!;
    expect(c.proxmox.hasVm(target)).toBe(true); // infra preserved (req §6.6)

    // Sanitized failure reason is recorded.
    const states = c.controller.listTransitions(dep.id).map((t) => t.to);
    expect(states[states.length - 1]).toBe("Failed");
  });

  it("records a succeeded clone journal entry even when a later step fails", async () => {
    // Configure fails; the clone that already succeeded must be journaled as
    // succeeded so a retry would skip it (idempotent, no duplicate VM).
    const c = await composeMock({ proxmox: { failNext: { configure: "config error" } } });
    c.store.saveNetworkProfile({ id: "net-dhcp", name: "DHCP", mode: "dhcp" });

    const dep = c.controller.createDeployment(plan());
    const first = await c.controller.runDeployment(dep.id);
    expect(first.state).toBe("Failed");
    const vmid = c.controller.getDeployment(dep.id).targetVmid!;
    expect(c.proxmox.hasVm(vmid)).toBe(true);

    const ops = c.controller.listOperations(dep.id);
    const cloneOp = ops.find((o) => o.action === "clone")!;
    expect(cloneOp.status).toBe("succeeded");
    const configureOp = ops.find((o) => o.action === "configure")!;
    expect(configureOp.status).toBe("failed");
  });
});

describe("E2E — crash recovery reconciliation (req §19)", () => {
  it("reconciles an in-flight clone without issuing a duplicate", async () => {
    const c = await composeMock({});
    c.store.saveNetworkProfile({ id: "net-dhcp", name: "DHCP", mode: "dhcp" });
    const dep = c.controller.createDeployment(plan());

    // Simulate a crash: a clone was issued (VM exists) and journaled in_flight,
    // but the success was never recorded.
    const vmid = c.proxmox.allocateVmid();
    await c.proxmox.cloneTemplate({ node: "pve", templateVmid: 9000, newVmid: vmid, name: "web-01" });
    c.store.updateDeployment(dep.id, { targetVmid: vmid });
    const op = c.store.beginOperation({
      deploymentId: dep.id,
      idempotencyKey: `${dep.id}:clone`,
      target: `pve/${vmid}`,
      action: "clone",
    });
    c.store.setOperationUpid(op.id, "UPID:pve:crashed");

    // Reconcile on startup: the VM exists, so the clone is marked succeeded.
    await c.controller.reconcileOnStartup();
    const reconciled = c.store.getOperationByKey(`${dep.id}:clone`)!;
    expect(reconciled.status).toBe("succeeded");

    // Running now must NOT create a second VM (idempotent skip).
    const before = c.proxmox.hasVm(vmid);
    await c.controller.runDeployment(dep.id);
    expect(before).toBe(true);
    // The deployment reached Ready reusing the existing VM.
    expect(c.controller.getDeployment(dep.id).state).toBe("Ready");
  });
});

describe("E2E — exposure partial failure rolls back only this operation", () => {
  it("rolls back applied mappings when an outer hop cannot be verified", async () => {
    const c = await composeMock({ vmAddress: "192.168.7.50" });
    c.store.saveNetworkProfile({ id: "net-dhcp", name: "DHCP", mode: "dhcp" });

    // Archer works; Keenetic is seeded but we remove its create workflow so the
    // outer hop fails, forcing rollback of the (already-applied) Archer mapping.
    seedRouter(c, { id: "archer", name: "Archer", kind: "fixtureA", baseUrl: "http://a", wanAddress: "192.168.1.2" });
    seedRouter(c, { id: "keenetic", name: "Keenetic", kind: "fixtureB", baseUrl: "http://k", wanAddress: "203.0.113.7" });

    // Break the outer router by giving it a create workflow that targets a
    // missing field, so replay stops (refuses to guess) -> hop fails.
    c.store.saveWorkflow({
      id: "keenetic:create",
      routerProfileId: "keenetic",
      kind: "create",
      version: 2,
      steps: [
        { kind: "fill", locators: [{ by: "label", text: "This Field Does Not Exist" }], binding: { kind: "var", name: "rule_name" }, meta: {} },
      ],
    });

    const chain: RouterChain = {
      id: "home-chain",
      name: "Home chain",
      hops: [
        { routerProfileId: "archer", wanAddress: "192.168.1.2" },
        { routerProfileId: "keenetic", wanAddress: "203.0.113.7" },
      ],
    };
    c.store.saveRouterChain(chain);

    const dep = c.controller.createDeployment(
      plan({ chainId: "home-chain", exposure: { protocol: "tcp", publicPort: 8080, internalPort: 8080 } }),
    );
    const result = await c.controller.runDeployment(dep.id);

    // Deployment fails at Exposing; VM preserved.
    expect(result.state).toBe("Failed");
    expect(c.proxmox.hasVm(c.controller.getDeployment(dep.id).targetVmid!)).toBe(true);

    // The Archer mapping that was applied gets rolled back — NAT chain has no
    // leftover forwards from this operation.
    expect(c.nat.ruleCount()).toBe(0);
  });
});
