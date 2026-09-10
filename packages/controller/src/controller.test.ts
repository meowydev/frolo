import { describe, it, expect } from "vitest";
import type { DeploymentPlan } from "@frolo/contracts";
import { composeMock, seedRouter, type MockComposition } from "./compose-mock.js";
import { createDevIssuer } from "@frolo/licensing";

function basePlan(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
  return {
    name: "web-01",
    connectionId: "c1",
    templateVmid: 9000,
    cores: 2,
    ramMb: 2048,
    diskGb: 10,
    hostname: "web-01",
    sshUser: "ubuntu",
    networkProfileId: "n-dhcp",
    recipeId: "builtin.nginx",
    ...overrides,
  };
}

async function setup(overrides?: Parameters<typeof composeMock>[0]): Promise<MockComposition> {
  const c = await composeMock({ vmAddress: "192.168.7.50", ...overrides });
  c.store.saveNetworkProfile({ id: "n-dhcp", name: "dhcp", mode: "dhcp" });
  c.store.saveNetworkProfile({
    id: "n-manual",
    name: "manual",
    mode: "manual",
    address: "192.168.7.50",
    gateway: "192.168.7.1",
    subnetCidr: "192.168.7.0/24",
  });
  return c;
}

describe("Controller — inventory & mode", () => {
  it("lists only cloud-init templates and hides real mode", async () => {
    const c = await setup();
    const templates = await c.controller.listTemplates();
    expect(templates.every((t) => t.cloudInit)).toBe(true);
    expect(c.controller.getMode()).toEqual({ mode: "mock", realModeAvailable: false });
  });
});

describe("Controller — deployment happy path (no exposure)", () => {
  it("runs clone->configure->boot->install->check->ready and finds the marker", async () => {
    const c = await setup();
    const dep = c.controller.createDeployment(basePlan());
    const result = await c.controller.runDeployment(dep.id);
    expect(result.state).toBe("Ready");
    expect(result.localAddress).toMatch(/^192\.168\.7\./);

    const transitions = c.controller.listTransitions(dep.id).map((t) => t.to);
    expect(transitions).toEqual([
      "Queued",
      "Cloning",
      "Configuring",
      "Booting",
      "Installing",
      "Checking",
      "Ready",
    ]);
    // marker page written + served
    expect(c.guest.fileAt("/var/www/html/index.html")).toContain(`FROLO-OK-${dep.id}`);
    expect(c.guest.isEnabled("nginx")).toBe(true);
    expect(c.guest.isRunning("nginx")).toBe(true);
  });
});

describe("Controller — failure preserves infra", () => {
  it("marks Failed and keeps the VM when install fails", async () => {
    const c = await setup({ guest: { failInstallPackages: ["nginx"] } });
    const dep = c.controller.createDeployment(basePlan());
    const result = await c.controller.runDeployment(dep.id);
    expect(result.state).toBe("Failed");
    // VM was created and NOT deleted (infra preserved, req §6.6)
    const target = c.controller.getDeployment(dep.id).targetVmid!;
    expect(c.proxmox.hasVm(target)).toBe(true);
  });

  it("verification fails when the marker is missing", async () => {
    const c = await setup({ guest: { markerMissing: true } });
    const dep = c.controller.createDeployment(basePlan());
    const result = await c.controller.runDeployment(dep.id);
    expect(result.state).toBe("Failed");
    const logs = c.controller.listLogs(dep.id).map((l) => l.messageSanitized);
    expect(logs.some((l) => l.includes("marker missing"))).toBe(true);
  });
});

describe("Controller — licensing", () => {
  it("defaults to Frolo Home with core + teach mode", async () => {
    const c = await setup();
    const ent = await c.controller.getEntitlements();
    expect(ent.effectiveTier).toBe("home");
    expect(ent.features.core_deployment).toBe(true);
    expect(ent.features.teach_mode).toBe(true);
    expect(ent.features.multi_router_chains).toBe(false);
  });

  it("activates a paid tier from a valid dev license", async () => {
    const issuer = createDevIssuer();
    const c = await setup({ licenseKeys: [issuer.publicKey], allowDevLicenseKeys: true });
    const lic = issuer.issue({ subject: "device-1", tier: "powerfullness" });
    const ent = await c.controller.installLicense(JSON.stringify(lic));
    expect(ent.effectiveTier).toBe("powerfullness");
    expect(ent.features.unlimited_router_hops).toBe(true);
  });
});

describe("Controller — deletion is confirmation-gated and non-destructive by default", () => {
  it("requires confirmation and tears down before deleting", async () => {
    const c = await setup();
    const dep = c.controller.createDeployment(basePlan());
    await c.controller.runDeployment(dep.id);
    const target = c.controller.getDeployment(dep.id).targetVmid!;
    expect(c.proxmox.hasVm(target)).toBe(true);

    const res = await c.controller.confirmAndDelete(dep.id, { confirmed: true });
    expect(res.deleted).toBe(true);
    expect(c.proxmox.hasVm(target)).toBe(false);
    // audit recorded
    expect(c.controller.listAudit().some((a) => a.action === "delete_vm")).toBe(true);
  });
});
