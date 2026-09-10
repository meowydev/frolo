// E2E secret-hygiene assertions (req §11.3, §11.4, §12.2, §12.3, §18.8).
// After a full deployment with router credentials + exposure, no secret value
// may appear in SQLite, logs, audit, transitions, or recorded workflows, and
// password steps must carry no values. Secrets live only in the encrypted vault.

import { describe, it, expect } from "vitest";
import type { DeploymentPlan, RouterChain } from "@frolo/contracts";
import { composeMock, seedRouter } from "@frolo/controller";
import { createDevIssuer } from "@frolo/licensing";
import { NodeAtomicFileStore } from "@frolo/vault";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROUTER_USER = "supersecretadmin";
const ROUTER_PASS = "P@ssw0rd-do-not-leak-1234";

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
    chainId: "home-chain",
    exposure: { protocol: "tcp", publicPort: 8080, internalPort: 8080 },
    ...overrides,
  };
}

describe("E2E — secret hygiene", () => {
  it("keeps router credentials out of SQLite, logs, audit, and workflows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "frolo-hygiene-"));
    const dbPath = join(dir, "frolo.sqlite");
    const vaultPath = join(dir, "frolo.vault");

    const issuer = createDevIssuer();
    const c = await composeMock({
      storePath: dbPath,
      vaultPath,
      vmAddress: "192.168.7.50",
      licenseKeys: [issuer.publicKey],
      allowDevLicenseKeys: true,
    });
    await c.controller.installLicense(
      JSON.stringify(issuer.issue({ subject: "device-hygiene", tier: "advanced_user" })),
    );
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

    // Store real router credentials (in the vault only).
    await c.controller.setRouterCredentials("archer", ROUTER_USER, ROUTER_PASS);
    await c.controller.setRouterCredentials("keenetic", ROUTER_USER, ROUTER_PASS);

    const dep = c.controller.createDeployment(plan());
    const result = await c.controller.runDeployment(dep.id);
    expect(result.state).toBe("Ready");

    // 1) SQLite file on disk must not contain the secret values.
    const dbBytes = readFileSync(dbPath, "utf8").replace(/\0/g, "");
    // WAL file may hold recent writes; check it too if present.
    let walBytes = "";
    try {
      walBytes = readFileSync(`${dbPath}-wal`, "utf8").replace(/\0/g, "");
    } catch {
      /* no wal */
    }
    expect(dbBytes.includes(ROUTER_PASS)).toBe(false);
    expect(dbBytes.includes(ROUTER_USER)).toBe(false);
    expect(walBytes.includes(ROUTER_PASS)).toBe(false);
    expect(walBytes.includes(ROUTER_USER)).toBe(false);

    // 2) Logs, transitions, and audit (in-memory + persisted) must be clean.
    const logs = c.controller.listLogs(dep.id).map((l) => l.messageSanitized).join("\n");
    const transitions = c.controller.listTransitions(dep.id).map((t) => t.reasonSanitized).join("\n");
    const audit = c.controller.listAudit().map((a) => a.detailSanitized).join("\n");
    for (const blob of [logs, transitions, audit]) {
      expect(blob.includes(ROUTER_PASS)).toBe(false);
      expect(blob.includes(ROUTER_USER)).toBe(false);
    }

    // 3) Recorded workflows never carry password values; secret steps use var
    //    bindings only.
    for (const kind of ["login", "create", "find", "delete"] as const) {
      for (const rp of ["archer", "keenetic"]) {
        const wf = c.store.getWorkflow(rp, kind);
        if (!wf) continue;
        const json = JSON.stringify(wf);
        expect(json.includes(ROUTER_PASS)).toBe(false);
        for (const step of wf.steps) {
          if (step.kind === "fillSecret") {
            expect(step.binding).toEqual({ kind: "var", name: "router_password" });
          }
        }
      }
    }

    // 4) The vault file DOES contain ciphertext but NOT the plaintext secret.
    const vaultRaw = await new NodeAtomicFileStore().read(vaultPath);
    expect(vaultRaw).not.toBeNull();
    expect(vaultRaw!.includes(ROUTER_PASS)).toBe(false);
    expect(vaultRaw!.includes(ROUTER_USER)).toBe(false);
    expect(vaultRaw!.includes("AES-256-GCM")).toBe(true);

    // 5) The guest private key (also a secret) is not in SQLite or logs.
    expect(dbBytes.includes("FAKE-PRIVATE-KEY")).toBe(false);
    expect(logs.includes("FAKE-PRIVATE-KEY")).toBe(false);
  });
});
