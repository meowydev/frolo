// Router chain planner (req §10). Computes the five-tuple mapping for each hop,
// the apply/rollback/teardown order, and enforces the MVP equal-port rule.

import type {
  ExposurePlan,
  HopMapping,
  Ipv4,
  Protocol,
  RouterChain,
} from "@frolo/contracts";

export class ChainPlanError extends Error {}

export interface PlanExposureInput {
  chain: RouterChain; // hops innermost -> outermost
  vmAddress: Ipv4;
  protocol: Protocol;
  publicPort: number;
  internalPort: number;
}

// MVP requires the same port at every hop (req §10.3a).
export function planExposure(input: PlanExposureInput): ExposurePlan {
  const { chain, vmAddress, protocol, publicPort, internalPort } = input;
  if (chain.hops.length === 0) {
    throw new ChainPlanError("chain has no hops");
  }
  if (publicPort !== internalPort) {
    throw new ChainPlanError(
      `MVP requires equal ports at every hop (public ${publicPort} != internal ${internalPort})`,
    );
  }
  const port = publicPort;

  const hops: HopMapping[] = chain.hops.map((hop, i) => {
    const isInnermost = i === 0;
    // target of hop i:
    //  - innermost forwards to the VM
    //  - each outer forwards to the WAN address of the router immediately inside it
    const targetAddress = isInnermost
      ? vmAddress
      : chain.hops[i - 1]!.wanAddress;
    return {
      hopIndex: i,
      routerProfileId: hop.routerProfileId,
      listenAddress: hop.wanAddress,
      listenPort: port,
      targetAddress,
      targetPort: port,
      protocol,
    };
  });

  const outermost = chain.hops[chain.hops.length - 1]!;
  const publicAddress = `${outermost.wanAddress}:${port}`;

  return {
    protocol,
    publicPort,
    internalPort,
    vmAddress,
    hops,
    publicAddress,
  };
}

// Apply order: innermost -> outermost (req §10.4). This is the natural hop order.
export function applyOrder(plan: ExposurePlan): HopMapping[] {
  return [...plan.hops].sort((a, b) => a.hopIndex - b.hopIndex);
}

// Rollback of a partially-applied exposure: reverse of the order they were
// created (req §10.6). Given the mappings that WERE applied this operation.
export function rollbackOrder(applied: HopMapping[]): HopMapping[] {
  return [...applied].sort((a, b) => b.hopIndex - a.hopIndex);
}

// Teardown on deployment delete: outermost -> innermost (req §10.7).
export function teardownOrder(plan: ExposurePlan): HopMapping[] {
  return [...plan.hops].sort((a, b) => b.hopIndex - a.hopIndex);
}
