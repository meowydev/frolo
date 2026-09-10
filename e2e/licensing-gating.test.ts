// E2E licensing / tier gating (req: monetization). Verifies the free tier stays
// useful, that multi-hop exposure is a paid convenience, and that expiry reverts
// to Home WITHOUT touching any VM, mapping, or deployment.

import { describe, it, expect } from "vitest";
import type { DeploymentPlan, RouterChain } from "@frolo/contracts";
import { composeMock, seedRouter } from "@frolo/controller";
import { createDevIssuer } from "@frolo/licensing";

const DAY = 24 * 60 * 60 * 1000;

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

async function setupTwoHop(licenseTier?: "advanced_user" | "powerfullness") {
  const issuer = createDevIssuer();
  const c = await composeMock({
    vmAddress: "192.168.7.50",
    licenseKeys: [issuer.publicKey],
    allowDevLicenseKeys: true,
  });
  c.store.saveNetworkProfile({ id: "net-dhcp", name: "DHCP", mode: "dhcp" });
  seedRouter(c, { id: "archer", name: "Archer", kind: "fixtureA", baseUrl: "http://a", wanAddress: "192.168.1.2" });
  seedRouter(c, { id: "keenetic", name: "Keenetic", kind: "fixtureB", baseUrl: "http://k", wanAddress: "203.0.113.7" });
  const chain: RouterChain = {
    id: "home-chain",
    name: "Home chain",
    hops: [
      { routerProfileId: "archer", wanAddress: "192.168.1.2" },
      { routerProfileId: "keenetic", wanAddress: "203.0.113.7" },
    ],
  };
  c.store.saveRouterChain(chain);
  await c.controller.setRouterCredentials("archer", "u", "p");
  await c.controller.setRouterCredentials("keenetic", "u", "p");
  if (licenseTier) {
    await c.controller.installLicense(JSON.stringify(issuer.issue({ subject: "d", tier: licenseTier })));
  }
  return { c, issuer };
}

describe("licensing — free tier is useful", () => {
  it("Home can deploy Nginx locally (no exposure) end to end", async () => {
    const c = await composeMock({});
    c.store.saveNetworkProfile({ id: "net-dhcp", name: "DHCP", mode: "dhcp" });
    const dep = c.controller.createDeployment(plan());
    const result = await c.controller.runDeployment(dep.id);
    expect(result.state).toBe("Ready");
    const ent = await c.controller.getEntitlements();
    expect(ent.effectiveTier).toBe("home");
  });
});

describe("licensing — multi-hop exposure is a paid convenience", () => {
  it("blocks a 2-hop chain on Home, allows it on AdvancedUser", async () => {
    // Home: no license -> exposure fails, VM preserved.
    const home = await setupTwoHop();
    const depH = home.c.controller.createDeployment(
      plan({ chainId: "home-chain", exposure: { protocol: "tcp", publicPort: 8080, internalPort: 8080 } }),
    );
    const resH = await home.c.controller.runDeployment(depH.id);
    expect(resH.state).toBe("Failed");
    expect(home.c.proxmox.hasVm(home.c.controller.getDeployment(depH.id).targetVmid!)).toBe(true);

    // AdvancedUser: exposure succeeds.
    const adv = await setupTwoHop("advanced_user");
    const depA = adv.c.controller.createDeployment(
      plan({ chainId: "home-chain", exposure: { protocol: "tcp", publicPort: 8080, internalPort: 8080 } }),
    );
    const resA = await adv.c.controller.runDeployment(depA.id);
    expect(resA.state).toBe("Ready");
    expect(resA.publicAddressSim).toBe("203.0.113.7:8080");
  });
});

describe("licensing — expiry reverts to Home without touching infrastructure", () => {
  it("keeps the VM and mappings after the license expires", async () => {
    const { c, issuer } = await setupTwoHop("advanced_user");
    const dep = c.controller.createDeployment(
      plan({ chainId: "home-chain", exposure: { protocol: "tcp", publicPort: 8080, internalPort: 8080 } }),
    );
    const res = await c.controller.runDeployment(dep.id);
    expect(res.state).toBe("Ready");
    const vmid = c.controller.getDeployment(dep.id).targetVmid!;
    const mappingsBefore = c.controller.listMappings(dep.id).length;

    // Install a license that is already past its grace window (expired).
    const longAgo = new Date(Date.now() - 60 * DAY);
    await c.controller.installLicense(
      JSON.stringify(issuer.issue({ subject: "d", tier: "advanced_user", issuedAt: longAgo })),
    );
    const ent = await c.controller.getEntitlements();
    expect(ent.status.state).toBe("expired");
    expect(ent.effectiveTier).toBe("home");
    expect(ent.explanation.toLowerCase()).toContain("nothing was deleted");

    // The VM and its mappings are exactly as they were — expiry disabled a
    // convenience, it did not touch infrastructure.
    expect(c.proxmox.hasVm(vmid)).toBe(true);
    expect(c.controller.listMappings(dep.id).length).toBe(mappingsBefore);
    expect(c.controller.getDeployment(dep.id).state).toBe("Ready");
  });
});
