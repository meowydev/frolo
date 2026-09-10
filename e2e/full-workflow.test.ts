// End-to-end mock workflow (req §14.6, §16.3). Runs the entire happy path
// against fakes: configure VM -> review plan -> clone -> configure networking ->
// install Nginx -> verify Nginx -> replay taught router workflows -> verify
// mappings -> show local + simulated public addresses. No real infrastructure.

import { describe, it, expect } from "vitest";
import type { DeploymentPlan, RouterChain } from "@frolo/contracts";
import { composeMock, seedRouter } from "@frolo/controller";
import { createDevIssuer } from "@frolo/licensing";

// Chain: Internet -> Keenetic -> Archer C6U -> VM (innermost first: Archer, Keenetic)
async function setupWithChain() {
  // A 2-hop chain is an AdvancedUser convenience, so activate a paid license.
  const issuer = createDevIssuer();
  const c = await composeMock({
    vmAddress: "192.168.7.50",
    licenseKeys: [issuer.publicKey],
    allowDevLicenseKeys: true,
  });
  await c.controller.installLicense(
    JSON.stringify(issuer.issue({ subject: "device-1", tier: "advanced_user" })),
  );

  // DHCP network profile: the fake hands back 192.168.7.50 for the first VM,
  // matching the NAT chain's expected VM address.
  c.store.saveNetworkProfile({ id: "net-dhcp", name: "DHCP", mode: "dhcp" });

  // Two routers: Archer (fixture A, innermost) and Keenetic (fixture B, outer).
  seedRouter(c, {
    id: "archer",
    name: "Archer C6U",
    kind: "fixtureA",
    baseUrl: "http://192.168.10.1",
    wanAddress: "192.168.1.2",
  });
  seedRouter(c, {
    id: "keenetic",
    name: "Keenetic",
    kind: "fixtureB",
    baseUrl: "http://192.168.1.1",
    wanAddress: "203.0.113.7",
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

  // Router credentials live only in the vault (needed to replay login).
  await c.controller.setRouterCredentials("archer", "admin", "router-pass-A");
  await c.controller.setRouterCredentials("keenetic", "admin", "router-pass-B");

  return c;
}

function planWithExposure(overrides: Partial<DeploymentPlan> = {}): DeploymentPlan {
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
    chainId: "home-chain",
    exposure: { protocol: "tcp", publicPort: 8080, internalPort: 8080 },
    ...overrides,
  };
}

describe("E2E mock — full happy path with router chain exposure", () => {
  it("configures, clones, installs, verifies, exposes, and shows both addresses", async () => {
    const c = await setupWithChain();

    const dep = c.controller.createDeployment(planWithExposure());

    // Review the plan before any mutation (req §7.2).
    const preview = c.controller.previewPlan(dep.id);
    expect(preview.steps.some((s) => s.includes("Clone template"))).toBe(true);

    // Run the full deployment (includes Exposing because chain+exposure set).
    const result = await c.controller.runDeployment(dep.id);

    expect(result.state).toBe("Ready");
    // local address shown (req §5A.10)
    expect(result.localAddress).toBe("192.168.7.50");
    // simulated public address shown (req §10.8)
    expect(result.publicAddressSim).toBe("203.0.113.7:8080");

    // Full state timeline including Exposing
    const states = c.controller.listTransitions(dep.id).map((t) => t.to);
    expect(states).toEqual([
      "Queued",
      "Cloning",
      "Configuring",
      "Booting",
      "Installing",
      "Checking",
      "Exposing",
      "Ready",
    ]);

    // Both hops' mappings recorded, applied and verified (req §10.5)
    const mappings = c.controller.listMappings(dep.id);
    expect(mappings).toHaveLength(2);
    expect(mappings.every((m) => m.applied && m.verified)).toBe(true);
    // Innermost (Archer) forwards to the VM; outer (Keenetic) to Archer WAN.
    const archer = mappings.find((m) => m.routerProfileId === "archer")!;
    const keenetic = mappings.find((m) => m.routerProfileId === "keenetic")!;
    expect(archer.targetAddress).toBe("192.168.7.50");
    expect(keenetic.targetAddress).toBe("192.168.1.2");

    // End-to-end reachability holds in the simulated NAT chain.
    expect(c.nat.ruleCount()).toBe(2);

    // Nginx page verified with the unique marker.
    expect(c.guest.fileAt("/var/www/html/index.html")).toContain(`FROLO-OK-${dep.id}`);
  });
});
