import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DeploymentPlan, HopMapping } from "@frolo/contracts";
import { FroloStore } from "./store.js";
import { FORBIDDEN_SECRET_COLUMNS } from "./schema.js";

const plan: DeploymentPlan = {
  name: "web-01",
  connectionId: "c1",
  templateVmid: 9000,
  cores: 2,
  ramMb: 2048,
  diskGb: 10,
  hostname: "web-01",
  sshUser: "ubuntu",
  networkProfileId: "n1",
  recipeId: "builtin.nginx",
};

describe("FroloStore", () => {
  let store: FroloStore;
  beforeEach(() => {
    store = new FroloStore(":memory:");
  });
  afterEach(() => store.close());

  it("has no secret-bearing columns (req §12.2)", () => {
    const cols = store.listAllColumns().map((c) => c.toLowerCase());
    for (const forbidden of FORBIDDEN_SECRET_COLUMNS) {
      const hit = cols.find((c) => c.endsWith(`.${forbidden}`));
      expect(hit, `unexpected secret column: ${hit}`).toBeUndefined();
    }
  });

  it("creates and reloads a deployment", () => {
    const dep = store.createDeployment(plan);
    expect(dep.state).toBe("Queued");
    const loaded = store.getDeployment(dep.id);
    expect(loaded?.plan.name).toBe("web-01");
  });

  it("appends transitions in order (append-only)", () => {
    const dep = store.createDeployment(plan);
    store.appendTransition(dep.id, null, "Queued", "created");
    store.appendTransition(dep.id, "Queued", "Cloning", "clone issued");
    store.appendTransition(dep.id, "Cloning", "Configuring", "clone ok");
    const t = store.listTransitions(dep.id);
    expect(t.map((x) => x.to)).toEqual(["Queued", "Cloning", "Configuring"]);
  });

  it("journal is idempotent by key", () => {
    const dep = store.createDeployment(plan);
    const a = store.beginOperation({
      deploymentId: dep.id,
      idempotencyKey: `${dep.id}:clone:9000`,
      target: "node1/9000",
      action: "clone",
    });
    const b = store.beginOperation({
      deploymentId: dep.id,
      idempotencyKey: `${dep.id}:clone:9000`,
      target: "node1/9000",
      action: "clone",
    });
    expect(b.id).toBe(a.id); // no duplicate entry
    expect(store.listOperations(dep.id)).toHaveLength(1);
  });

  it("tracks journal lifecycle and unresolved list", () => {
    const dep = store.createDeployment(plan);
    const op = store.beginOperation({
      deploymentId: dep.id,
      idempotencyKey: "k1",
      target: "node1/9000",
      action: "clone",
    });
    store.setOperationUpid(op.id, "UPID:node1:0001");
    expect(store.listUnresolvedOperations().map((o) => o.status)).toContain("in_flight");
    store.setOperationStatus(op.id, "succeeded", "clone task ok");
    expect(store.listUnresolvedOperations()).toHaveLength(0);
  });

  it("stores five-tuple mappings", () => {
    const dep = store.createDeployment(plan);
    const m: HopMapping = {
      hopIndex: 0,
      routerProfileId: "archer",
      listenAddress: "192.168.1.2",
      listenPort: 8080,
      targetAddress: "192.168.10.50",
      targetPort: 8080,
      protocol: "tcp",
    };
    store.saveMapping(dep.id, m, true, true);
    const list = store.listMappings(dep.id);
    expect(list[0]!.targetAddress).toBe("192.168.10.50");
    expect(list[0]!.applied).toBe(true);
  });

  it("audit is append-only and newest-first", () => {
    store.appendAudit("user", "open_ports", "web-01", "opened tcp/8080");
    store.appendAudit("user", "delete_vm", "web-01", "deleted vmid 9000");
    const a = store.listAudit();
    expect(a).toHaveLength(2);
    expect(a[0]!.action).toBe("delete_vm");
  });
});
