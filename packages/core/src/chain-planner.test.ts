import { describe, it, expect } from "vitest";
import type { RouterChain } from "@frolo/contracts";
import {
  planExposure,
  applyOrder,
  rollbackOrder,
  teardownOrder,
  ChainPlanError,
} from "./chain-planner.js";

// Internet -> modem -> Keenetic -> Archer C6U -> VM
// innermost first: Archer, Keenetic, modem
const chain: RouterChain = {
  id: "c",
  name: "home chain",
  hops: [
    { routerProfileId: "archer", wanAddress: "192.168.1.2" },
    { routerProfileId: "keenetic", wanAddress: "10.10.0.2" },
    { routerProfileId: "modem", wanAddress: "203.0.113.7" },
  ],
};

describe("chain planner", () => {
  it("computes per-hop five-tuple targets innermost->outermost", () => {
    const plan = planExposure({
      chain,
      vmAddress: "192.168.10.50",
      protocol: "tcp",
      publicPort: 8080,
      internalPort: 8080,
    });

    // Archer forwards to VM
    expect(plan.hops[0]!.targetAddress).toBe("192.168.10.50");
    // Keenetic forwards to Archer WAN
    expect(plan.hops[1]!.targetAddress).toBe("192.168.1.2");
    // modem forwards to Keenetic WAN
    expect(plan.hops[2]!.targetAddress).toBe("10.10.0.2");
    // public address is modem WAN:port
    expect(plan.publicAddress).toBe("203.0.113.7:8080");
    // all listen/target ports equal
    for (const h of plan.hops) {
      expect(h.listenPort).toBe(8080);
      expect(h.targetPort).toBe(8080);
    }
  });

  it("enforces equal ports for MVP", () => {
    expect(() =>
      planExposure({
        chain,
        vmAddress: "192.168.10.50",
        protocol: "tcp",
        publicPort: 8080,
        internalPort: 80,
      }),
    ).toThrow(ChainPlanError);
  });

  it("apply order is innermost->outermost", () => {
    const plan = planExposure({
      chain,
      vmAddress: "192.168.10.50",
      protocol: "tcp",
      publicPort: 80,
      internalPort: 80,
    });
    expect(applyOrder(plan).map((h) => h.hopIndex)).toEqual([0, 1, 2]);
  });

  it("rollback order is reverse of creation", () => {
    const plan = planExposure({
      chain,
      vmAddress: "192.168.10.50",
      protocol: "tcp",
      publicPort: 80,
      internalPort: 80,
    });
    const applied = [plan.hops[0]!, plan.hops[1]!]; // outer failed
    expect(rollbackOrder(applied).map((h) => h.hopIndex)).toEqual([1, 0]);
  });

  it("teardown order is outermost->innermost", () => {
    const plan = planExposure({
      chain,
      vmAddress: "192.168.10.50",
      protocol: "tcp",
      publicPort: 80,
      internalPort: 80,
    });
    expect(teardownOrder(plan).map((h) => h.hopIndex)).toEqual([2, 1, 0]);
  });
});
