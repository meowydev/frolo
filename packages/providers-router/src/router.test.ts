import { describe, it, expect } from "vitest";
import type { VarBindings, Workflow } from "@frolo/contracts";
import { RouterFixtureA, RouterFixtureB } from "./fixtures.js";
import { fixtureAWorkflows, fixtureBWorkflows } from "./workflows.js";
import { FakeRouterProvider } from "./fake.js";
import { SimulatedNatChain } from "./nat-chain.js";
import { planExposure } from "@frolo/core";
import type { RouterChain } from "@frolo/contracts";

const trust = { scheme: "http" as const };

const vars: VarBindings = {
  router_username: "admin",
  router_password: "s3cret", // supplied from vault; must never be stored in workflow
  rule_name: "frolo-web-01",
  external_port: "8080",
  internal_ip: "192.168.10.50",
  internal_port: "8080",
  protocol: "tcp",
};

function wf(list: Workflow[], kind: Workflow["kind"]): Workflow {
  return list.find((w) => w.kind === kind)!;
}

describe("pre-recorded workflows never contain secret values", () => {
  it("fixture A/B password steps use var bindings, not values", () => {
    for (const list of [fixtureAWorkflows("rA"), fixtureBWorkflows("rB")]) {
      const json = JSON.stringify(list);
      expect(json).not.toContain("s3cret");
      const secretSteps = list
        .flatMap((w) => w.steps)
        .filter((s) => s.kind === "fillSecret");
      expect(secretSteps.length).toBeGreaterThan(0);
      for (const s of secretSteps) {
        expect(s.binding).toEqual({ kind: "var", name: "router_password" });
      }
    }
  });
});

describe("Fixture A replay (clean labelled form)", () => {
  it("logs in and creates + verifies a rule", async () => {
    const fx = new RouterFixtureA();
    const p = new FakeRouterProvider(fx);
    const wfs = fixtureAWorkflows("rA");

    expect((await p.replay(wf(wfs, "login"), vars, trust)).ok).toBe(true);
    const create = await p.replay(wf(wfs, "create"), vars, trust);
    expect(create.ok).toBe(true);
    expect(fx.hasRule("frolo-web-01")).toBe(true);
    expect((await p.probeRule(wf(wfs, "find"), vars, trust)).exists).toBe(true);
  });
});

describe("Fixture B replay (generated ids, nested nav, loading, dialog)", () => {
  it("navigates, waits for loading, fills, confirms dialog, verifies", async () => {
    const fx = new RouterFixtureB();
    const p = new FakeRouterProvider(fx);
    const wfs = fixtureBWorkflows("rB");

    expect((await p.replay(wf(wfs, "login"), vars, trust)).ok).toBe(true);
    const create = await p.replay(wf(wfs, "create"), vars, trust);
    expect(create.ok).toBe(true);
    expect(fx.hasRule("frolo-web-01")).toBe(true);
  });

  it("does not rely on generated ids (locators still resolve)", async () => {
    const fx = new RouterFixtureB();
    const p = new FakeRouterProvider(fx);
    const wfs = fixtureBWorkflows("rB");
    const r = await p.replay(wf(wfs, "create"), vars, trust);
    expect(r.ok).toBe(true);
  });
});

describe("replay refuses to guess", () => {
  it("stops with a repair request when the target is missing", async () => {
    const fx = new RouterFixtureA();
    const p = new FakeRouterProvider(fx);
    const broken: Workflow = {
      id: "x",
      routerProfileId: "rA",
      kind: "create",
      version: 1,
      steps: [
        { kind: "fill", locators: [{ by: "label", text: "Nonexistent Field" }], binding: { kind: "var", name: "rule_name" }, meta: {} },
      ],
    };
    const r = await p.replay(broken, vars, trust);
    expect(r.ok).toBe(false);
    expect(r.repair?.reason).toBe("missing");
  });

  it("stops on a manual checkpoint instead of auto-acting", async () => {
    const fx = new RouterFixtureA();
    const p = new FakeRouterProvider(fx);
    const manual: Workflow = {
      id: "m",
      routerProfileId: "rA",
      kind: "login",
      version: 1,
      steps: [{ kind: "manualCheckpoint", locators: [], meta: { manualReason: "solve captcha" } }],
    };
    const r = await p.replay(manual, vars, trust);
    expect(r.ok).toBe(false);
    expect(r.repair?.reason).toBe("manual");
  });
});

describe("Simulated NAT chain reachability", () => {
  const chain: RouterChain = {
    id: "c",
    name: "home",
    hops: [
      { routerProfileId: "archer", wanAddress: "192.168.1.2" },
      { routerProfileId: "keenetic", wanAddress: "10.10.0.2" },
    ],
  };

  it("is reachable only after both hops are applied", () => {
    const plan = planExposure({
      chain,
      vmAddress: "192.168.10.50",
      protocol: "tcp",
      publicPort: 8080,
      internalPort: 8080,
    });
    const nat = new SimulatedNatChain("192.168.10.50");
    expect(nat.probe(plan)).toBe(false);
    nat.apply(plan.hops[0]!); // archer -> vm
    expect(nat.probe(plan)).toBe(false); // outer hop missing
    nat.apply(plan.hops[1]!); // keenetic -> archer wan
    expect(nat.probe(plan)).toBe(true);
    expect(plan.publicAddress).toBe("10.10.0.2:8080");
  });

  it("removing a mapping breaks reachability", () => {
    const plan = planExposure({
      chain,
      vmAddress: "192.168.10.50",
      protocol: "tcp",
      publicPort: 8080,
      internalPort: 8080,
    });
    const nat = new SimulatedNatChain("192.168.10.50");
    nat.apply(plan.hops[0]!);
    nat.apply(plan.hops[1]!);
    expect(nat.probe(plan)).toBe(true);
    nat.remove(plan.hops[1]!);
    expect(nat.probe(plan)).toBe(false);
  });
});
